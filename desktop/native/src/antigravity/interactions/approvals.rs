use super::{Target, WAITING, bounded_text, pending_interaction};
use crate::requests::Response;
use anyhow::{Result, bail};
use serde_json::{Value, json};

const ONCE: &str = "PERMISSION_SCOPE_ONCE";

pub(super) struct CommandApproval<'a> {
    permission: &'a Value,
    command: &'a str,
    cwd: Option<&'a str>,
}

impl<'a> CommandApproval<'a> {
    pub(super) fn read(step: &'a Value, target: &Target) -> Option<Self> {
        if step["status"] != WAITING
            || !matches!(
                step["type"].as_str(),
                Some("CORTEX_STEP_TYPE_GENERIC" | "CORTEX_STEP_TYPE_RUN_COMMAND")
            )
            || !pending_interaction(step)
        {
            return None;
        }
        // The native App addresses approval by the originating trajectory and step.
        let source = &step["metadata"]["sourceTrajectoryStepInfo"];
        if source["trajectoryId"] != target.trajectory_id
            || source["stepIndex"].as_u64() != Some(u64::from(target.step_index))
        {
            return None;
        }
        let permission = &step["requestedInteraction"]["permission"];
        if permission["resource"]["action"] != "command"
            || permission.to_string().len() > 100_000
            || permission.get("approvalScopeFilter").is_some_and(|scopes| {
                scopes.as_array().is_none_or(|scopes| {
                    !scopes.is_empty() && !scopes.iter().any(|scope| scope == ONCE)
                })
            })
        {
            return None;
        }
        let generic = &step["generic"]["args"];
        let legacy = &step["runCommand"];
        if [generic.get("BypassSandbox"), legacy.get("sandboxOverride")]
            .into_iter()
            .flatten()
            .any(|flag| flag != false && flag != "false")
        {
            return None;
        }
        // Keep the full proposed command and working directory legible.
        let command = visible_text(&permission["resource"]["target"], 16_000, true)?;
        // A permission response releases the existing command step without replacing its input.
        if [
            generic.get("CommandLine"),
            legacy.get("commandLine"),
            legacy.get("proposedCommandLine"),
        ]
        .into_iter()
        .flatten()
        .any(|value| value != "" && value != command)
        {
            return None;
        }
        let cwd = match generic.get("Cwd").or_else(|| legacy.get("cwd")) {
            Some(cwd) if cwd != "" => Some(visible_text(cwd, 4_096, false)?),
            _ => None,
        };
        Some(Self {
            permission,
            command,
            cwd,
        })
    }

    pub(super) fn view(&self, target: &Target, actionable: bool) -> Value {
        let description = match self.cwd {
            Some(cwd) => format!("{}\n\n工作目录：{cwd}", self.command),
            None => self.command.to_owned(),
        };
        json!({
            "id": target.id(),
            "kind": "command",
            "title": "Antigravity 命令执行审批",
            "description": description,
            "turnId": target.turn_id,
            "fingerprint": crate::state::hash(&json!([target.trajectory_id,target.step_index,target.turn_id,"permission",self.permission,self.cwd]).to_string()),
            "decisions": ["accept", "decline"],
            "actionable": actionable,
        })
    }

    pub(super) fn reply(&self, target: &Target, answer: &Response) -> Result<Value> {
        let allow = match answer.decision.as_deref() {
            Some("accept") => true,
            Some("decline") => false,
            _ => bail!("Antigravity 命令审批只允许接受本次或拒绝"),
        };
        // This mirrors the native one-time action. No alternate target, persistent grant or
        // sandbox override is sent, and the command stays in the originating step.
        Ok(json!({
            "trajectoryId": target.trajectory_id,
            "stepIndex": target.step_index,
            "permission": {"allow": allow, "scope": ONCE},
        }))
    }
}

const FILE_WRITE_ACTIONS: &[&str] = &[
    "write_file",
    "edit_file",
    "file_write",
    "replace_file_content",
    "multi_replace_file_content",
    "create_file",
    "modify_file",
];

pub(super) struct FileApproval<'a> {
    permission: &'a Value,
    target_path: &'a str,
    change_kind: &'static str,
}

impl<'a> FileApproval<'a> {
    pub(super) fn read(step: &'a Value, target: &Target) -> Option<Self> {
        if step["status"] != WAITING
            || !matches!(
                step["type"].as_str(),
                Some(
                    "CORTEX_STEP_TYPE_GENERIC"
                        | "CORTEX_STEP_TYPE_WRITE_TO_FILE"
                        | "CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT"
                        | "CORTEX_STEP_TYPE_MULTI_REPLACE_FILE_CONTENT"
                )
            )
            || !pending_interaction(step)
        {
            return None;
        }
        let source = &step["metadata"]["sourceTrajectoryStepInfo"];
        if source["trajectoryId"] != target.trajectory_id
            || source["stepIndex"].as_u64() != Some(u64::from(target.step_index))
        {
            return None;
        }
        let permission = &step["requestedInteraction"]["permission"];
        let action = permission["resource"]["action"].as_str()?;
        if !FILE_WRITE_ACTIONS.contains(&action)
            || permission.to_string().len() > 100_000
            || permission.get("approvalScopeFilter").is_some_and(|scopes| {
                scopes.as_array().is_none_or(|scopes| {
                    !scopes.is_empty() && !scopes.iter().any(|scope| scope == ONCE)
                })
            })
        {
            return None;
        }
        if [step["generic"]["args"].get("BypassSandbox")]
            .into_iter()
            .flatten()
            .any(|flag| flag != false && flag != "false")
        {
            return None;
        }
        let target_path = visible_text(&permission["resource"]["target"], 4_096, false)?;
        let change_kind = if matches!(action, "write_file" | "file_write" | "create_file") {
            "create"
        } else {
            "update"
        };
        Some(Self {
            permission,
            target_path,
            change_kind,
        })
    }

    pub(super) fn view(&self, target: &Target, actionable: bool) -> Value {
        json!({
            "id": target.id(),
            "kind": "file",
            "title": "Antigravity 文件修改审批",
            "description": self.target_path,
            "changes": [{"path": self.target_path, "kind": self.change_kind}],
            "turnId": target.turn_id,
            "fingerprint": crate::state::hash(&json!([target.trajectory_id,target.step_index,target.turn_id,"file-permission",self.permission]).to_string()),
            "decisions": ["accept", "decline"],
            "actionable": actionable,
        })
    }

    pub(super) fn reply(&self, target: &Target, answer: &Response) -> Result<Value> {
        let allow = match answer.decision.as_deref() {
            Some("accept") => true,
            Some("decline") => false,
            _ => bail!("Antigravity 文件审批只允许接受本次或拒绝"),
        };
        Ok(json!({
            "trajectoryId": target.trajectory_id,
            "stepIndex": target.step_index,
            "permission": {"allow": allow, "scope": ONCE},
        }))
    }
}

fn visible_text(value: &Value, limit: usize, allow_multiline: bool) -> Option<&str> {
    bounded_text(value, limit).filter(|text| {
        !text.chars().any(|ch| {
            (ch.is_control() && !(allow_multiline && matches!(ch, '\n' | '\t')))
                || matches!(ch, '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
        })
    })
}

#[cfg(test)]
mod tests {
    use super::super::{response, views};
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
        for action in ["read_file", "unsandboxed"] {
            let native = trajectory.pointer_mut(permission).unwrap();
            native["resource"]["action"] = json!(action);
            assert_eq!(views(&trajectory, false)[0]["kind"], "unsupported");
        }
        trajectory["steps"][1]["requestedInteraction"]["permission"]["resource"]["action"] =
            json!("command");
        trajectory["steps"][1]["generic"]["args"]["BypassSandbox"] = json!("true");
        assert_eq!(views(&trajectory, false)[0]["kind"], "unsupported");
        assert!(response(&trajectory, &answer).is_err());
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
}
