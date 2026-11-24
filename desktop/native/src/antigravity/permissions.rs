use super::{Backend, Daemon, Duration, valid_id};
use crate::plugins::Delivery;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const INHERIT: &str = "antigravity:inherit";
const UNSPECIFIED: &str = "AGENT_PERMISSION_PRESET_UNSPECIFIED";

struct Preset {
    id: &'static str,
    native: &'static str,
    name: &'static str,
    description: &'static str,
}

const PRESETS: &[Preset] = &[
    Preset {
        id: "antigravity:request-review",
        native: "AGENT_PERMISSION_PRESET_REQUEST_REVIEW",
        name: "逐次审批",
        description: "每条终端命令都需要审批，工作区外的文件操作也需要审批",
    },
    Preset {
        id: "antigravity:default",
        native: "AGENT_PERMISSION_PRESET_DEFAULT",
        name: "默认权限",
        description: "终端命令在沙箱内运行，敏感操作需要审批",
    },
    Preset {
        id: "antigravity:auto",
        native: "AGENT_PERMISSION_PRESET_AUTO",
        name: "自动审查",
        description: "Antigravity 自动审查部分审批请求",
    },
    Preset {
        id: "antigravity:turbo",
        native: "AGENT_PERMISSION_PRESET_TURBO",
        name: "Turbo",
        description: "取消沙箱隔离，允许终端和文件操作；已有权限规则仍优先",
    },
];

fn read_preset(value: &Value) -> Result<Option<&'static Preset>> {
    match value {
        Value::Null => Ok(None),
        Value::String(name) if name == UNSPECIFIED => Ok(None),
        Value::String(name) => Ok(Some(
            PRESETS
                .iter()
                .find(|preset| preset.native == name)
                .context("Antigravity 权限预设不兼容")?,
        )),
        _ => anyhow::bail!("Antigravity 权限预设不兼容"),
    }
}

fn enabled(flags: &Value, name: &str) -> bool {
    flags["experimentConfig"]["experiments"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|flag| {
            flag["keyString"] == name && (flag["disabled"].is_null() || flag["disabled"] == false)
        })
}

fn unavailable() -> Value {
    json!({"product":"antigravity","permissions":[],"presets":[],"actions":[],
        "state":{"permission":null}})
}

struct PermissionView {
    current: &'static str,
    inherited: &'static str,
    inherited_from_project: bool,
    options: Vec<&'static Preset>,
    revision: String,
    unavailable_reason: Option<&'static str>,
}

impl PermissionView {
    fn catalog(self) -> Value {
        let (inherit_name, inherit_description) = if self.inherited_from_project {
            ("沿用项目权限", format!("项目预设：{}", self.inherited))
        } else {
            ("沿用全局权限", format!("全局预设：{}", self.inherited))
        };
        let permissions = std::iter::once(json!({
            "id":INHERIT,"name":inherit_name,"description":inherit_description
        }))
        .chain(self.options.iter().map(
            |preset| json!({"id":preset.id,"name":preset.name,"description":preset.description}),
        ))
        .collect::<Vec<_>>();
        json!({"product":"antigravity","permissions":permissions,"presets":[],
            "actions":if self.unavailable_reason.is_none() { vec!["permission"] } else { vec![] },
            "state":{"permission":self.current,"permissionRevision":self.revision},
            "permissionScopeDescription":"会话预设只在此会话生效。项目和全局权限规则仍然有效。",
            "permissionUnavailableReason":self.unavailable_reason})
    }
}

impl Backend {
    async fn permission_view(
        &self,
        daemon: &Daemon,
        thread: &str,
        summary: &Value,
    ) -> Result<PermissionView> {
        let project_id = summary["trajectoryMetadata"]["projectId"]
            .as_str()
            .filter(|id| !matches!(*id, "" | "outside-of-project"));
        if let Some(id) = project_id {
            valid_id(id)?;
        }
        let flags_request = json!({});
        let settings_request = json!({});
        let admin_request = json!({});
        let configuration_request = json!({});
        let project = async {
            let Some(id) = project_id else {
                return Ok(Value::Null);
            };
            let value = self
                .call_at(daemon, "ReadProject", &json!({"id":id}), false)
                .await?;
            ensure!(
                value["project"]["id"] == id
                    && value["notFoundOnDisk"] != true
                    && value["project"]["archived"] != true
                    && (value["project"]["backendType"].is_null()
                        || matches!(
                            value["project"]["backendType"].as_str(),
                            Some("BACKEND_TYPE_UNSPECIFIED" | "BACKEND_TYPE_LOCAL")
                        )),
                "Antigravity 本地项目已变化"
            );
            Ok::<_, anyhow::Error>(value["project"]["settings"].clone())
        };
        let (flags, settings, admin, configuration, project) = tokio::try_join!(
            self.call_at(daemon, "GetMendelFlags", &flags_request, false),
            self.call_at(daemon, "GetPermissionSettings", &settings_request, false),
            self.call_at(daemon, "FetchAdminControls", &admin_request, false),
            self.call_at(
                daemon,
                "GetServerConfiguration",
                &configuration_request,
                false
            ),
            project
        )?;
        ensure!(
            settings.is_object() && admin.is_object(),
            "Antigravity 权限设置不可用"
        );
        let global = read_preset(&settings["globalPreset"])?;
        let project_preset = read_preset(&project["permissionPreset"])?;
        // Legacy explicit project settings can override the global display even
        // without a modern preset. Do not claim to know the inherited preset.
        let legacy_project_settings = project_preset.is_none()
            && (project["sandboxMode"].is_boolean()
                || has_setting(&project["autoExecutionPolicy"])
                || has_setting(&project["fileAccessPolicy"]));
        let inherited = if legacy_project_settings {
            "项目自定义权限"
        } else {
            project_preset
                .or(global)
                .map_or("本机设置", |preset| preset.name)
        };
        let current = read_preset(&summary["annotations"]["permissionPreset"])?;
        let conversation_preset = enabled(&flags, "permission-v2")
            && enabled(&flags, "enable-conversation-scoped-permissions");
        let admin_allows = (admin["adminControlsApplicable"].is_null()
            || admin["adminControlsApplicable"] == false)
            && admin["agentControls"]["permissionPresetLocked"] != true;
        let supports_sandbox = configuration["config"]["sandboxAvailable"] == true;
        let options = PRESETS
            .iter()
            .filter(|preset| match preset.id {
                "antigravity:auto" => {
                    supports_sandbox && enabled(&flags, "enable-auto-permission-preset")
                }
                "antigravity:default" => supports_sandbox,
                _ => true,
            })
            .collect::<Vec<_>>();
        let current_id = current.map_or(INHERIT, |preset| preset.id);
        let revision = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!([
                thread,
                summary["trajectoryId"],
                project_id,
                summary["annotations"]["permissionPreset"],
                project["permissionPreset"],
                project["sandboxMode"],
                project["autoExecutionPolicy"],
                project["fileAccessPolicy"],
                settings["globalPreset"],
                conversation_preset,
                admin_allows,
                options.iter().map(|preset| preset.id).collect::<Vec<_>>()
            ]))?)
        );
        let unavailable_reason = if self.read_only {
            Some("Antigravity 当前为只读模式。")
        } else if !admin_allows {
            Some("此 Antigravity 账号的权限受组织策略管理，请在电脑上查看。")
        } else if !conversation_preset {
            Some("此 Antigravity 暂未启用会话权限，请在电脑上调整项目或全局权限。")
        } else {
            None
        };
        Ok(PermissionView {
            current: current_id,
            inherited,
            inherited_from_project: project_preset.is_some() || legacy_project_settings,
            options,
            revision,
            unavailable_reason,
        })
    }

    pub(super) async fn permission_catalog(&self, thread: &str) -> Value {
        let result = tokio::time::timeout(Duration::from_secs(8), async {
            let (daemon, summary) = self.conversation(thread).await?;
            self.permission_view(&daemon, thread, &summary).await
        })
        .await;
        match result {
            Ok(Ok(view)) => view.catalog(),
            Ok(Err(error)) => {
                eprintln!("[antigravity] 无法读取会话 {thread} 的权限配置：{error:#}");
                unavailable()
            }
            Err(_) => {
                eprintln!("[antigravity] 读取会话 {thread} 的权限配置超时");
                unavailable()
            }
        }
    }

    pub(super) async fn set_permission(
        &self,
        thread: &str,
        value: &str,
        expected: Option<&str>,
        expected_revision: Option<&str>,
    ) -> Delivery {
        let _write = self.permission_write.lock().await;
        let Ok((daemon, summary)) = self.conversation(thread).await else {
            return Delivery::Rejected("找不到此 Antigravity 会话");
        };
        let Ok(view) = self.permission_view(&daemon, thread, &summary).await else {
            return Delivery::Rejected("无法确认此 Antigravity 会话的权限");
        };
        if let Some(reason) = view.unavailable_reason {
            return Delivery::Rejected(reason);
        }
        if expected != Some(view.current) || expected_revision != Some(view.revision.as_str()) {
            return Delivery::Rejected("Antigravity 会话权限已变化，请重新选择");
        }
        let Some(native) = requested_preset(value, &view.options) else {
            return Delivery::Rejected("此 Antigravity 会话不支持所选权限");
        };
        if value == view.current {
            return Delivery::Completed(None);
        }
        let unchanged = self.summaries_at(&daemon).await.is_ok_and(|summaries| {
            summaries.get(thread).is_some_and(|current| {
                current["trajectoryId"] == summary["trajectoryId"]
                    && current["trajectoryMetadata"]["projectId"]
                        == summary["trajectoryMetadata"]["projectId"]
                    && current["annotations"]["permissionPreset"]
                        == summary["annotations"]["permissionPreset"]
            })
        });
        if !unchanged {
            return Delivery::Rejected("Antigravity 会话权限已变化，请重新选择");
        }
        let result = self
            .call_at(
                &daemon,
                "UpdateConversationAnnotations",
                &json!({"cascadeIds":[thread],"annotations":{"permissionPreset":native},"mergeAnnotations":true}),
                true,
            )
            .await;
        if result.is_err() {
            return Delivery::Uncertain;
        }
        let confirmed = self.summaries_at(&daemon).await.ok().and_then(|summaries| {
            let summary = summaries.get(thread)?;
            read_preset(&summary["annotations"]["permissionPreset"]).ok()
        });
        if confirmed.is_some_and(|preset| preset.map_or(INHERIT, |preset| preset.id) == value) {
            Delivery::Completed(None)
        } else {
            Delivery::Uncertain
        }
    }
}

fn requested_preset(value: &str, options: &[&Preset]) -> Option<&'static str> {
    if value == INHERIT {
        Some(UNSPECIFIED)
    } else {
        options
            .iter()
            .find(|preset| preset.id == value)
            .map(|preset| preset.native)
    }
}

fn has_setting(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|setting| !setting.ends_with("_UNSPECIFIED"))
}
