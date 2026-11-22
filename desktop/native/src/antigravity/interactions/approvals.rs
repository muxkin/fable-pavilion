use super::{Target, bounded_text, pending_interaction};
use crate::requests::Response;
use anyhow::{Result, bail};
use serde_json::{Value, json};

const ONCE: &str = "PERMISSION_SCOPE_ONCE";
const SESSION_SCOPES: &[&str] = &["PERMISSION_SCOPE_CONVERSATION", "PERMISSION_SCOPE_SESSION"];

const COMMAND_ACTIONS: &[&str] = &[
    "command",
    "run_command",
    "execute_command",
    "shell",
    "terminal",
    "send_command_input",
];

const FILE_CREATE_ACTIONS: &[&str] = &["write_file", "write_to_file", "file_write", "create_file"];

const FILE_UPDATE_ACTIONS: &[&str] = &[
    "edit_file",
    "replace_file_content",
    "multi_replace_file_content",
    "modify_file",
    "move_file",
    "rename_file",
];

const FILE_DELETE_ACTIONS: &[&str] = &["delete_file", "remove_file"];

const FILE_READ_ACTIONS: &[&str] = &[
    "read_file",
    "view_file",
    "file_read",
    "view_file_outline",
    "view_code_item",
];

const DIR_ACCESS_ACTIONS: &[&str] = &["list_dir", "find_by_name", "grep_search", "search_files"];

struct PermissionScopes {
    allow_once: bool,
    session_scope: Option<String>,
    decline_scope: String,
}

impl PermissionScopes {
    fn read(permission: &Value) -> Option<Self> {
        match permission.get("approvalScopeFilter") {
            None | Some(Value::Null) => Some(Self {
                allow_once: true,
                session_scope: None,
                decline_scope: ONCE.to_owned(),
            }),
            Some(Value::Array(scopes)) if scopes.is_empty() => Some(Self {
                allow_once: true,
                session_scope: None,
                decline_scope: ONCE.to_owned(),
            }),
            Some(Value::Array(scopes)) => {
                let allow_once = scopes.iter().any(|scope| scope == ONCE);
                let session_scope = scopes.iter().find_map(|scope| {
                    scope
                        .as_str()
                        .filter(|value| SESSION_SCOPES.contains(value))
                        .map(str::to_owned)
                });
                if !allow_once && session_scope.is_none() {
                    return None;
                }
                let decline_scope = if allow_once {
                    ONCE.to_owned()
                } else {
                    session_scope.clone()?
                };
                Some(Self {
                    allow_once,
                    session_scope,
                    decline_scope,
                })
            }
            Some(_) => None,
        }
    }

    fn decisions(&self) -> Vec<&'static str> {
        let mut choices = Vec::with_capacity(3);
        if self.allow_once {
            choices.push("accept");
        }
        if self.session_scope.is_some() {
            choices.push("acceptForSession");
        }
        choices.push("decline");
        choices
    }

    fn reply(&self, target: &Target, answer: &Response) -> Result<Value> {
        let (allow, scope) = match answer.decision.as_deref() {
            Some("accept") if self.allow_once => (true, ONCE),
            Some("acceptForSession") if let Some(scope) = self.session_scope.as_deref() => {
                (true, scope)
            }
            Some("decline") => (false, self.decline_scope.as_str()),
            _ => bail!("Antigravity 权限审批选项无效"),
        };
        Ok(json!({
            "trajectoryId": target.trajectory_id,
            "stepIndex": target.step_index,
            "permission": {"allow": allow, "scope": scope},
        }))
    }
}

pub(super) enum Approval<'a> {
    Command(CommandApproval<'a>),
    File(FileApproval<'a>),
    Generic(GenericPermissionApproval<'a>),
}

impl<'a> Approval<'a> {
    pub(super) fn read(step: &'a Value, _target: &Target) -> Option<Self> {
        if !pending_interaction(step) {
            return None;
        }
        let permission = &step["requestedInteraction"]["permission"];
        if !permission.as_object().is_some_and(|map| !map.is_empty())
            || permission.to_string().len() > 100_000
        {
            return None;
        }
        let scopes = PermissionScopes::read(permission)?;
        let action = permission["resource"]["action"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        if is_command_permission(step, action) {
            // Never fall back to a generic permission card if a command step has conflicting
            // execution text between the permission resource and the step arguments.
            return CommandApproval::read(step, permission, scopes).map(Self::Command);
        }
        if let Some(action) = action
            && is_file_action(action)
            && let Some(approval) = FileApproval::read(step, permission, action, scopes)
        {
            return Some(Self::File(approval));
        }
        let scopes = PermissionScopes::read(permission)?;
        GenericPermissionApproval::read(step, permission, scopes).map(Self::Generic)
    }

    pub(super) fn view(&self, target: &Target, actionable: bool) -> Value {
        match self {
            Self::Command(approval) => approval.view(target, actionable),
            Self::File(approval) => approval.view(target, actionable),
            Self::Generic(approval) => approval.view(target, actionable),
        }
    }

    pub(super) fn reply(&self, target: &Target, answer: &Response) -> Result<Value> {
        match self {
            Self::Command(approval) => approval.scopes.reply(target, answer),
            Self::File(approval) => approval.scopes.reply(target, answer),
            Self::Generic(approval) => approval.scopes.reply(target, answer),
        }
    }
}

fn is_command_permission(step: &Value, action: Option<&str>) -> bool {
    action.is_some_and(|action| COMMAND_ACTIONS.contains(&action))
        || (action.is_none()
            && matches!(
                step["type"].as_str(),
                Some("CORTEX_STEP_TYPE_RUN_COMMAND" | "CORTEX_STEP_TYPE_SEND_COMMAND_INPUT")
            ))
}

fn is_file_action(action: &str) -> bool {
    FILE_CREATE_ACTIONS.contains(&action)
        || FILE_UPDATE_ACTIONS.contains(&action)
        || FILE_DELETE_ACTIONS.contains(&action)
        || FILE_READ_ACTIONS.contains(&action)
        || DIR_ACCESS_ACTIONS.contains(&action)
}

fn bypass_sandbox(step: &Value) -> bool {
    [
        step["generic"]["args"].get("BypassSandbox"),
        step["runCommand"].get("sandboxOverride"),
    ]
    .into_iter()
    .flatten()
    .any(|flag| match flag {
        Value::Null | Value::Bool(false) => false,
        Value::String(value) => !value.is_empty() && !value.eq_ignore_ascii_case("false"),
        _ => true,
    })
}

pub(super) struct CommandApproval<'a> {
    permission: &'a Value,
    scopes: PermissionScopes,
    command: &'a str,
    cwd: Option<&'a str>,
    bypass_sandbox: bool,
}

impl<'a> CommandApproval<'a> {
    fn read(step: &'a Value, permission: &'a Value, scopes: PermissionScopes) -> Option<Self> {
        let generic = &step["generic"]["args"];
        let legacy = &step["runCommand"];
        let target_command = visible_text(&permission["resource"]["target"], 16_000, true);
        let fallback_command = [
            generic.get("CommandLine"),
            legacy.get("commandLine"),
            legacy.get("proposedCommandLine"),
        ]
        .into_iter()
        .flatten()
        .find_map(|value| visible_text(value, 16_000, true));

        let command = target_command.or(fallback_command)?;
        // A permission response releases the existing command step without replacing its input.
        if [
            generic.get("CommandLine"),
            legacy.get("commandLine"),
            legacy.get("proposedCommandLine"),
        ]
        .into_iter()
        .flatten()
        .any(|value| {
            value
                .as_str()
                .map(str::trim)
                .is_some_and(|text| !text.is_empty() && text != command.trim())
        }) {
            return None;
        }
        let cwd = match generic.get("Cwd").or_else(|| legacy.get("cwd")) {
            Some(cwd) if cwd != "" => Some(visible_text(cwd, 4_096, false)?),
            _ => None,
        };
        Some(Self {
            permission,
            scopes,
            command,
            cwd,
            bypass_sandbox: bypass_sandbox(step),
        })
    }

    fn view(&self, target: &Target, actionable: bool) -> Value {
        let mut sections = vec![self.command.to_owned()];
        if let Some(cwd) = self.cwd {
            sections.push(format!("工作目录：{cwd}"));
        }
        if self.bypass_sandbox {
            sections.push("⚠️ 此命令请求绕过沙箱执行".to_owned());
        }
        let title = if self.bypass_sandbox {
            "Antigravity 命令执行审批（绕过沙箱）"
        } else {
            "Antigravity 命令执行审批"
        };
        json!({
            "id": target.id(),
            "kind": "command",
            "title": title,
            "description": sections.join("\n\n"),
            "turnId": target.turn_id,
            "fingerprint": crate::state::hash(&json!([target.trajectory_id,target.step_index,target.turn_id,"permission",self.permission,self.cwd,self.bypass_sandbox]).to_string()),
            "decisions": self.scopes.decisions(),
            "actionable": actionable,
        })
    }
}

pub(super) struct FileApproval<'a> {
    permission: &'a Value,
    scopes: PermissionScopes,
    title: &'static str,
    target_path: String,
    change_kind: Option<&'static str>,
    bypass_sandbox: bool,
}

impl<'a> FileApproval<'a> {
    fn read(
        step: &'a Value,
        permission: &'a Value,
        action: &str,
        scopes: PermissionScopes,
    ) -> Option<Self> {
        let raw_target = visible_text(&permission["resource"]["target"], 4_096, false).or_else(
            || {
                [
                    step["writeToFile"].get("targetFile"),
                    step["writeToFile"].get("targetFileUri"),
                    step["replaceFileContent"].get("targetFile"),
                    step["replaceFileContent"].get("targetFileUri"),
                    step["multiReplaceFileContent"].get("targetFile"),
                    step["multiReplaceFileContent"].get("targetFileUri"),
                    step["viewFile"].get("absolutePath"),
                    step["viewFile"].get("absolutePathUri"),
                    step["listDir"].get("directoryPath"),
                    step["listDir"].get("directoryPathUri"),
                    step["findByName"].get("searchDirectory"),
                    step["grepSearch"].get("searchPath"),
                    step["generic"]["args"].get("Path"),
                    step["generic"]["args"].get("AbsolutePath"),
                    step["generic"]["args"].get("TargetFile"),
                    step["generic"]["args"].get("FilePath"),
                ]
                .into_iter()
                .flatten()
                .find_map(|value| visible_text(value, 4_096, false))
            },
        )?;
        let target_path = decode_file_path(raw_target);
        let (title, change_kind) = if FILE_CREATE_ACTIONS.contains(&action) {
            ("Antigravity 文件修改审批", Some("create"))
        } else if FILE_UPDATE_ACTIONS.contains(&action) {
            ("Antigravity 文件修改审批", Some("update"))
        } else if FILE_DELETE_ACTIONS.contains(&action) {
            ("Antigravity 文件删除审批", Some("delete"))
        } else if FILE_READ_ACTIONS.contains(&action) {
            ("Antigravity 文件读取审批", None)
        } else {
            ("Antigravity 目录访问审批", None)
        };
        Some(Self {
            permission,
            scopes,
            title,
            target_path,
            change_kind,
            bypass_sandbox: bypass_sandbox(step),
        })
    }

    fn view(&self, target: &Target, actionable: bool) -> Value {
        let description = if self.bypass_sandbox {
            format!("{}\n\n⚠️ 此操作请求绕过沙箱执行", self.target_path)
        } else {
            self.target_path.clone()
        };
        let mut view = json!({
            "id": target.id(),
            "kind": "file",
            "title": self.title,
            "description": description,
            "turnId": target.turn_id,
            "fingerprint": crate::state::hash(&json!([target.trajectory_id,target.step_index,target.turn_id,"file-permission",self.permission,self.bypass_sandbox]).to_string()),
            "decisions": self.scopes.decisions(),
            "actionable": actionable,
        });
        if let Some(change_kind) = self.change_kind {
            view["changes"] = json!([{"path": self.target_path, "kind": change_kind}]);
        }
        view
    }
}

pub(super) struct GenericPermissionApproval<'a> {
    permission: &'a Value,
    scopes: PermissionScopes,
    title: &'static str,
    description: String,
    bypass_sandbox: bool,
}

impl<'a> GenericPermissionApproval<'a> {
    fn read(step: &'a Value, permission: &'a Value, scopes: PermissionScopes) -> Option<Self> {
        let action = visible_text(&permission["resource"]["action"], 200, false)
            .or_else(|| visible_text(&step["generic"]["toolName"], 200, false))
            .or_else(|| visible_text(&step["generic"]["name"], 200, false))
            .or_else(|| {
                step["type"]
                    .as_str()
                    .map(|kind| kind.trim_start_matches("CORTEX_STEP_TYPE_"))
                    .filter(|kind| !kind.is_empty())
            });
        let target = [
            permission["resource"].get("target"),
            permission.get("target"),
            permission.get("path"),
            permission.get("url"),
        ]
        .into_iter()
        .flatten()
        .find_map(|value| visible_text(value, 16_000, true));
        let reason = [
            permission.get("message"),
            permission.get("description"),
            permission.get("reason"),
        ]
        .into_iter()
        .flatten()
        .find_map(|value| visible_text(value, 4_096, true));

        let bypass = bypass_sandbox(step);
        let mut lines = Vec::new();
        if let Some(action) = action {
            lines.push(format!("操作：{action}"));
        }
        if let Some(target) = target {
            lines.push(format!("目标：{}", decode_file_path(target)));
        }
        if let Some(reason) = reason {
            lines.push(format!("说明：{reason}"));
        }
        if bypass {
            lines.push("⚠️ 此操作请求绕过沙箱执行".to_owned());
        }
        if lines.is_empty() {
            lines.push("Antigravity 请求执行受限操作".to_owned());
        }
        let title = if bypass {
            "Antigravity 权限审批（绕过沙箱）"
        } else {
            "Antigravity 权限审批"
        };
        Some(Self {
            permission,
            scopes,
            title,
            description: lines.join("\n"),
            bypass_sandbox: bypass,
        })
    }

    fn view(&self, target: &Target, actionable: bool) -> Value {
        json!({
            "id": target.id(),
            "kind": "command",
            "title": self.title,
            "description": self.description,
            "turnId": target.turn_id,
            "fingerprint": crate::state::hash(&json!([target.trajectory_id,target.step_index,target.turn_id,"generic-permission",self.permission,self.bypass_sandbox]).to_string()),
            "decisions": self.scopes.decisions(),
            "actionable": actionable,
        })
    }
}

fn decode_file_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("file:")
        && let Ok(url) = url::Url::parse(trimmed)
        && let Ok(path) = url.to_file_path()
    {
        return path.to_string_lossy().into_owned();
    }
    trimmed.to_owned()
}

fn visible_text(value: &Value, limit: usize, allow_multiline: bool) -> Option<&str> {
    bounded_text(value, limit).filter(|text| {
        !text.chars().any(|ch| {
            (ch.is_control() && !(allow_multiline && matches!(ch, '\n' | '\r' | '\t')))
                || matches!(ch, '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
        })
    })
}

#[cfg(test)]
mod tests {
    use super::super::{WAITING, response, views};
    use super::*;

    const TRAJECTORY: &str = "889bccc9-6e56-4fef-92b9-44217568ff6a";
    const CASCADE: &str = "41cd814f-125e-40ca-8143-9daa34e08769";
    const COMMAND: &str = "printf 'fixture approval'";

    fn trajectory() -> Value {
        json!({"trajectoryId":TRAJECTORY,"cascadeId":CASCADE,"steps":[null,{
            "type":"CORTEX_STEP_TYPE_GENERIC","status":WAITING,
            "metadata":{"executionId":"fixture-turn","sourceTrajectoryStepInfo":{"trajectoryId":TRAJECTORY,"cascadeId":CASCADE,"stepIndex":1}},
            "generic":{"args":{"CommandLine":COMMAND,"BypassSandbox":"false"}},
            "requestedInteraction":{"permission":{"resource":{"action":"command","target":COMMAND},"approvalScopeFilter":[ONCE]}},
        }]})
    }

    fn reply(shown: &Value, decision: &str) -> Response {
        serde_json::from_value(json!({
            "requestId":"a52b4290-3f86-4af9-84af-e370d7dfb7fb",
            "targetRequestId":shown["id"],"expectedTurnId":shown["turnId"],
            "expectedFingerprint":shown["fingerprint"],"decision":decision,
        }))
        .unwrap()
    }

    #[test]
    fn command_approval_uses_one_time_native_permission() {
        let trajectory = trajectory();
        let shown = &views(&trajectory, false)[0];
        assert_eq!(shown["kind"], "command");
        assert_eq!(shown["description"], COMMAND);
        assert_eq!(shown["decisions"], json!(["accept", "decline"]));
        assert_eq!(views(&trajectory, true)[0]["actionable"], false);
        let accepted = response(&trajectory, &reply(shown, "accept")).unwrap();
        assert_eq!(
            accepted,
            json!({"trajectoryId":TRAJECTORY,"stepIndex":1,"permission":{"allow":true,"scope":ONCE}})
        );
        let denied = response(&trajectory, &reply(shown, "decline")).unwrap();
        assert_eq!(denied["permission"], json!({"allow":false,"scope":ONCE}));
        assert!(response(&trajectory, &reply(shown, "acceptForSession")).is_err());
    }

    #[test]
    fn stale_unrelated_and_completed_approval_do_not_dispatch() {
        let mut trajectory = trajectory();
        let shown = &views(&trajectory, false)[0];
        let answer = reply(shown, "accept");
        let permission = "/steps/1/requestedInteraction/permission";
        let native = trajectory.pointer_mut(permission).unwrap();
        native["resource"]["target"] = json!("printf 'changed command'");
        assert!(response(&trajectory, &answer).is_err());

        // Switching to BypassSandbox invalidates any previous approval receipt and warns the user.
        trajectory["steps"][1]["requestedInteraction"]["permission"]["resource"]["target"] =
            json!(COMMAND);
        for flag in [json!("true"), json!(true)] {
            trajectory["steps"][1]["generic"]["args"]["BypassSandbox"] = flag;
            assert!(response(&trajectory, &answer).is_err());
            let bypassed = &views(&trajectory, false)[0];
            assert_eq!(bypassed["kind"], "command");
            assert!(
                bypassed["description"]
                    .as_str()
                    .unwrap()
                    .contains("绕过沙箱")
            );
            assert!(response(&trajectory, &reply(bypassed, "accept")).is_ok());
        }

        let step = &mut trajectory["steps"][1];
        let requested = step["requestedInteraction"].clone();
        step["completedInteractions"] =
            json!([{"request":requested,"response":{"permission":{"allow":true,"scope":ONCE}}}]);
        assert!(views(&trajectory, false).is_empty());
    }

    #[test]
    fn command_approval_rejects_conflicting_execution_text() {
        let mut trajectory = trajectory();
        let shown = &views(&trajectory, false)[0];
        let answer = reply(shown, "accept");

        trajectory["steps"][1]["generic"]["args"]["CommandLine"] = json!("printf 'changed input'");
        assert_eq!(views(&trajectory, false)[0]["kind"], "unsupported");
        assert!(response(&trajectory, &answer).is_err());

        let step = &mut trajectory["steps"][1];
        step["generic"] = Value::Null;
        step["type"] = json!("CORTEX_STEP_TYPE_RUN_COMMAND");
        step["runCommand"] = json!({"proposedCommandLine":COMMAND});
        assert!(response(&trajectory, &answer).is_ok());

        trajectory["steps"][1]["runCommand"]["commandLine"] = json!("printf 'changed input'");
        assert_eq!(views(&trajectory, false)[0]["kind"], "unsupported");
        assert!(response(&trajectory, &answer).is_err());
    }

    #[test]
    fn file_approval_supports_one_time_write_and_edit_permissions() {
        let trajectory = json!({"trajectoryId":TRAJECTORY,"cascadeId":CASCADE,"steps":[null,{
            "type":"CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT","status":WAITING,
            "metadata":{"executionId":"fixture-turn","sourceTrajectoryStepInfo":{"trajectoryId":TRAJECTORY,"cascadeId":CASCADE,"stepIndex":1}},
            "requestedInteraction":{"permission":{"resource":{"action":"replace_file_content","target":"/work/src/lib.rs"},"approvalScopeFilter":[ONCE]}},
        }]});
        let shown = &views(&trajectory, false)[0];
        assert_eq!(shown["kind"], "file");
        assert_eq!(shown["title"], "Antigravity 文件修改审批");
        assert_eq!(shown["description"], "/work/src/lib.rs");
        assert_eq!(shown["changes"][0]["path"], "/work/src/lib.rs");
        assert_eq!(shown["changes"][0]["kind"], "update");
        assert_eq!(shown["decisions"], json!(["accept", "decline"]));
        assert_eq!(views(&trajectory, true)[0]["actionable"], false);
        let accepted = response(&trajectory, &reply(shown, "accept")).unwrap();
        assert_eq!(
            accepted,
            json!({"trajectoryId":TRAJECTORY,"stepIndex":1,"permission":{"allow":true,"scope":ONCE}})
        );
        let denied = response(&trajectory, &reply(shown, "decline")).unwrap();
        assert_eq!(denied["permission"], json!({"allow":false,"scope":ONCE}));
    }

    #[test]
    fn approvals_work_without_source_metadata_and_with_crlf_and_extended_actions() {
        // Missing sourceTrajectoryStepInfo, CRLF command, trailing newline, and non-WAITING active status.
        let crlf_cmd = "echo one\r\necho two";
        let trajectory = json!({"trajectoryId":TRAJECTORY,"cascadeId":CASCADE,"steps":[{
            "type":"CORTEX_STEP_TYPE_GENERIC","status":"CORTEX_STEP_STATUS_RUNNING",
            "metadata":{"executionId":"fixture-turn"},
            "generic":{"args":{"CommandLine":"echo one\r\necho two\r\n"}},
            "requestedInteraction":{"permission":{"resource":{"action":"run_command","target":crlf_cmd}}},
        },{
            "type":"CORTEX_STEP_TYPE_VIEW_FILE","status":WAITING,
            "metadata":{"executionId":"fixture-turn"},
            "requestedInteraction":{"permission":{"resource":{"action":"read_file","target":"/etc/hosts"}}},
        },{
            "type":"CORTEX_STEP_TYPE_GENERIC","status":WAITING,
            "metadata":{"executionId":"fixture-turn"},
            "generic":{"toolName":"mcp_query"},
            "requestedInteraction":{"permission":{"resource":{"action":"mcp_tool","target":"docs/search"},"message":"Query external MCP"}},
        }]});
        let shown = views(&trajectory, false);
        assert_eq!(shown.len(), 3);
        assert_eq!(shown[0]["kind"], "command");
        assert_eq!(shown[0]["actionable"], true);
        assert_eq!(shown[1]["kind"], "file");
        assert_eq!(shown[1]["title"], "Antigravity 文件读取审批");
        assert_eq!(shown[1]["description"], "/etc/hosts");
        assert_eq!(shown[2]["kind"], "command");
        assert_eq!(shown[2]["title"], "Antigravity 权限审批");
        assert!(shown[2]["description"].as_str().unwrap().contains("mcp_tool"));
        assert!(shown[2]["description"].as_str().unwrap().contains("Query external MCP"));
        for card in &shown {
            let accepted = response(&trajectory, &reply(card, "accept")).unwrap();
            assert_eq!(accepted["permission"], json!({"allow":true,"scope":ONCE}));
        }
    }

    #[test]
    fn session_scope_is_offered_only_when_explicitly_advertised() {
        let trajectory = json!({"trajectoryId":TRAJECTORY,"cascadeId":CASCADE,"steps":[{
            "type":"CORTEX_STEP_TYPE_GENERIC","status":WAITING,
            "metadata":{"executionId":"fixture-turn"},
            "generic":{"args":{"CommandLine":COMMAND}},
            "requestedInteraction":{"permission":{
                "resource":{"action":"command","target":COMMAND},
                "approvalScopeFilter":[ONCE, "PERMISSION_SCOPE_CONVERSATION"],
            }},
        }]});
        let shown = &views(&trajectory, false)[0];
        assert_eq!(
            shown["decisions"],
            json!(["accept", "acceptForSession", "decline"])
        );
        let session = response(&trajectory, &reply(shown, "acceptForSession")).unwrap();
        assert_eq!(
            session["permission"],
            json!({"allow":true,"scope":"PERMISSION_SCOPE_CONVERSATION"})
        );
    }

    #[test]
    fn unsupported_non_permission_interaction_surfaces_safe_type_hint() {
        let trajectory = json!({"trajectoryId":TRAJECTORY,"cascadeId":CASCADE,"steps":[{
            "type":"CORTEX_STEP_TYPE_BROWSER_SUBAGENT","status":WAITING,
            "metadata":{"executionId":"fixture-turn"},
            "requestedInteraction":{"confirmBrowserSetup":{"secret":"must-not-leak"}},
        }]});
        let shown = &views(&trajectory, false)[0];
        assert_eq!(shown["kind"], "unsupported");
        assert_eq!(shown["actionable"], false);
        let desc = shown["description"].as_str().unwrap();
        assert!(desc.contains("confirmBrowserSetup"));
        assert!(desc.contains("BROWSER_SUBAGENT"));
        assert!(!desc.contains("must-not-leak"));
    }
}
