use super::native_input;
use super::super::{Outcome, View};
use crate::{
    codex_goal::{AppServer, thread_loaded},
    files::Attachment,
    settings,
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::time::timeout;
use uuid::Uuid;

#[derive(Clone, Eq, PartialEq)]
pub(super) struct SessionInfo {
    pub controls: Value,
    pub disabled_plugins: Vec<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub service_tier: Option<String>,
    pub mode: Option<String>,
    pub loaded: bool,
}

fn permission_from_resume(result: &Value) -> Value {
    let sandbox = &result["sandbox"];
    let sandbox_type = sandbox["type"].as_str();
    let policy = result["approvalPolicy"].as_str();
    let profile = match (sandbox_type, policy) {
        (Some("readOnly"), Some("on-request")) => Some(":read-only"),
        (Some("workspaceWrite"), Some("on-request")) => Some(":workspace"),
        (Some("dangerFullAccess"), Some("never")) => Some(":danger-full-access"),
        _ => None,
    };
    let synthetic = if sandbox.is_null() && result["approvalPolicy"].is_null() {
        Value::Null
    } else {
        json!({
            "activePermissionProfile": profile.map(|id| json!({"id": id})).unwrap_or(Value::Null),
            "sandboxPolicy": sandbox,
            "approvalPolicy": result["approvalPolicy"],
            "approvalsReviewer": result["approvalsReviewer"],
        })
    };
    settings::permission(&synthetic)
}

fn permission_wire(id: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match id {
        ":read-only" => Some(("read-only", "readOnly", "on-request")),
        ":workspace" => Some(("workspace-write", "workspaceWrite", "on-request")),
        ":danger-full-access" => Some(("danger-full-access", "dangerFullAccess", "never")),
        _ => None,
    }
}

pub(super) async fn probe(home: &Path, id: Uuid) -> Option<SessionInfo> {
    let result = timeout(Duration::from_secs(2), async {
        let mut server = AppServer::connect(home).await?;
        let loaded = thread_loaded(&mut server, id).await.unwrap_or(false);
        if !loaded {
            return Ok::<_, anyhow::Error>(SessionInfo {
                controls: settings::permission(&Value::Null),
                disabled_plugins: Vec::new(),
                model: None,
                effort: None,
                service_tier: None,
                mode: None,
                loaded: false,
            });
        }
        let reply = server
            .request("thread/resume", json!({"threadId": id, "excludeTurns": true}))
            .await?;
        if !reply["error"].is_null() {
            return Ok(SessionInfo {
                controls: settings::permission(&Value::Null),
                disabled_plugins: Vec::new(),
                model: None,
                effort: None,
                service_tier: None,
                mode: None,
                loaded: true,
            });
        }
        let data = &reply["result"];
        let disabled_plugins = data["disabledPluginIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        Ok(SessionInfo {
            controls: permission_from_resume(data),
            disabled_plugins,
            model: data["model"].as_str().map(str::to_owned),
            effort: data["reasoningEffort"].as_str().map(str::to_owned),
            service_tier: data["serviceTier"].as_str().map(str::to_owned),
            mode: data["collaborationMode"]["mode"]
                .as_str()
                .map(str::to_owned),
            loaded: true,
        })
    })
    .await;
    result.ok().and_then(Result::ok)
}

pub(super) async fn set_permission(home: &Path, id: Uuid, view: &View, input: &Value) -> Outcome {
    if settings::permission_request(view, input).is_err() {
        return Outcome::Rejected("会话权限已变化，请重新打开权限面板".into());
    }
    let Some(permission_id) = input["value"].as_str() else {
        return Outcome::Rejected("权限选项无效".into());
    };
    let Some((sandbox_mode, sandbox_type, approval_policy)) = permission_wire(permission_id) else {
        return Outcome::Rejected("权限选项无效".into());
    };
    let mut sent = false;
    let result = timeout(Duration::from_secs(8), async {
        let mut server = AppServer::connect(home).await?;
        sent = true;
        let reply = server
            .request(
                "thread/resume",
                json!({
                    "threadId": id,
                    "excludeTurns": true,
                    "sandbox": sandbox_mode,
                    "approvalPolicy": approval_policy,
                    "approvalsReviewer": "user",
                }),
            )
            .await?;
        if reply["error"]["code"].as_i64().is_some() {
            return Ok::<_, anyhow::Error>(Outcome::Rejected(
                "Codex 拒绝更新会话权限，请刷新后重试".into(),
            ));
        }
        let data = &reply["result"];
        if data["sandbox"]["type"] == sandbox_type && data["approvalPolicy"] == approval_policy {
            Ok(Outcome::Completed(None))
        } else {
            Ok(Outcome::Uncertain)
        }
    })
    .await;
    match result {
        Ok(Ok(outcome)) => outcome,
        _ if sent => Outcome::Uncertain,
        _ => Outcome::Rejected("无法连接本机 Codex 会话服务".into()),
    }
}

pub(super) async fn set_settings(home: &Path, id: Uuid, view: &View, input: &Value) -> Outcome {
    if settings::model_request(view, input).is_err() {
        return Outcome::Rejected("桌面设置已变化，请刷新后重试".into());
    }
    if input
        .get("mode")
        .is_some_and(|mode| *mode != view.thread["mode"])
    {
        return Outcome::Rejected("当前 Codex 会话暂不支持切换计划模式".into());
    }
    let (Some(model), Some(effort)) = (input["model"].as_str(), input["effort"].as_str()) else {
        return Outcome::Rejected("模型设置无效".into());
    };
    let mut params = json!({
        "threadId": id,
        "excludeTurns": true,
        "model": model,
        "config": {"model_reasoning_effort": effort},
    });
    if let Some(tier) = input.get("serviceTier").filter(|v| v.is_string()) {
        params["serviceTier"] = tier.clone();
    }
    let mut sent = false;
    let result = timeout(Duration::from_secs(8), async {
        let mut server = AppServer::connect(home).await?;
        sent = true;
        let reply = server.request("thread/resume", params).await?;
        if reply["error"]["code"].as_i64().is_some() {
            return Ok::<_, anyhow::Error>(Outcome::Rejected(
                "Codex 拒绝更新模型设置，请刷新后重试".into(),
            ));
        }
        let data = &reply["result"];
        if data["model"] == model && data["reasoningEffort"] == effort {
            Ok(Outcome::Completed(None))
        } else {
            Ok(Outcome::Uncertain)
        }
    })
    .await;
    match result {
        Ok(Ok(outcome)) => outcome,
        _ if sent => Outcome::Uncertain,
        _ => Outcome::Rejected("无法连接本机 Codex 会话服务".into()),
    }
}

pub(super) async fn send_turn(
    home: &Path,
    id: Uuid,
    request: Uuid,
    text: &str,
    files: &[Attachment],
    tools: &[Value],
) -> Outcome {
    let Ok((mut input, _)) = native_input(text, files) else {
        return Outcome::Rejected("无法读取附件路径，请重新上传".into());
    };
    input.extend(tools.iter().cloned());
    if input.is_empty() {
        return Outcome::Rejected("请输入消息或选择附件".into());
    }
    let mut sent = false;
    let result = timeout(Duration::from_secs(20), async {
        let mut server = AppServer::connect(home).await?;
        if !thread_loaded(&mut server, id).await.unwrap_or(false) {
            let resumed = server
                .request("thread/resume", json!({"threadId": id, "excludeTurns": true}))
                .await?;
            if !resumed["error"].is_null() {
                return Ok::<_, anyhow::Error>(Outcome::Rejected(
                    "无法在 Codex 会话服务中恢复此会话".into(),
                ));
            }
        }
        sent = true;
        let reply = server
            .request(
                "turn/start",
                json!({
                    "threadId": id,
                    "input": input,
                    "clientUserMessageId": request,
                }),
            )
            .await?;
        if reply["error"]["code"].as_i64().is_some() {
            return Ok(Outcome::Rejected("Codex 拒绝发送此消息，请刷新后重试".into()));
        }
        let turn_id = reply["result"]["turn"]["id"]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(str::to_owned);
        Ok(turn_id.map_or(Outcome::Uncertain, Outcome::Accepted))
    })
    .await;
    match result {
        Ok(Ok(outcome)) => outcome,
        _ if sent => Outcome::Uncertain,
        _ => Outcome::Rejected("无法连接本机 Codex 会话服务".into()),
    }
}

pub(super) async fn steer_turn(
    home: &Path,
    id: Uuid,
    request: Uuid,
    expected: &str,
    text: &str,
    files: &[Attachment],
) -> Outcome {
    let Ok((input, _)) = native_input(text, files) else {
        return Outcome::Rejected("无法读取附件路径，请重新上传".into());
    };
    if input.is_empty() {
        return Outcome::Rejected("请输入消息或选择附件".into());
    }
    let mut sent = false;
    let result = timeout(Duration::from_secs(20), async {
        let mut server = AppServer::connect(home).await?;
        sent = true;
        let reply = server
            .request(
                "turn/steer",
                json!({
                    "threadId": id,
                    "expectedTurnId": expected,
                    "input": input,
                    "clientUserMessageId": request,
                }),
            )
            .await?;
        if reply["error"]["code"].as_i64().is_some() {
            return Ok::<_, anyhow::Error>(Outcome::Rejected(
                "当前任务已变化，无法追加指令".into(),
            ));
        }
        let turn = reply["result"]["turnId"]
            .as_str()
            .filter(|v| !v.is_empty())
            .unwrap_or(expected)
            .to_owned();
        Ok(Outcome::Accepted(turn))
    })
    .await;
    match result {
        Ok(Ok(outcome)) => outcome,
        _ if sent => Outcome::Uncertain,
        _ => Outcome::Rejected("无法连接本机 Codex 会话服务".into()),
    }
}

pub(super) async fn interrupt_turn(home: &Path, id: Uuid, expected: &str) -> Outcome {
    let mut sent = false;
    let result = timeout(Duration::from_secs(10), async {
        let mut server = AppServer::connect(home).await?;
        sent = true;
        let reply = server
            .request(
                "turn/interrupt",
                json!({
                    "threadId": id,
                    "turnId": expected,
                }),
            )
            .await?;
        if reply["error"]["code"].as_i64().is_some() {
            return Ok::<_, anyhow::Error>(Outcome::Rejected(
                "当前任务已结束或无法中断".into(),
            ));
        }
        Ok(Outcome::Interrupted(expected.to_owned()))
    })
    .await;
    match result {
        Ok(Ok(outcome)) => outcome,
        _ if sent => Outcome::Uncertain,
        _ => Outcome::Rejected("无法连接本机 Codex 会话服务".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_app_server_resume_permissions_to_canonical_controls() {
        let workspace = permission_from_resume(&json!({
            "sandbox": {"type": "workspaceWrite"},
            "approvalPolicy": "on-request",
            "approvalsReviewer": "user",
        }));
        assert_eq!(workspace["permission"], ":workspace");
        assert_eq!(
            workspace["permissionRevision"].as_str().map(str::len),
            Some(64)
        );

        let read_only = permission_from_resume(&json!({
            "sandbox": {"type": "readOnly"},
            "approvalPolicy": "on-request",
            "approvalsReviewer": "user",
        }));
        assert_eq!(read_only["permission"], ":read-only");

        let danger = permission_from_resume(&json!({
            "sandbox": {"type": "dangerFullAccess"},
            "approvalPolicy": "never",
            "approvalsReviewer": "user",
        }));
        assert_eq!(danger["permission"], ":danger-full-access");

        let custom = permission_from_resume(&json!({
            "sandbox": {"type": "workspaceWrite"},
            "approvalPolicy": "never",
            "approvalsReviewer": "user",
        }));
        assert_eq!(custom["permission"], "custom");
        assert_ne!(workspace["permissionRevision"], custom["permissionRevision"]);
    }

    #[test]
    fn maps_canonical_permission_ids_to_app_server_wire_values() {
        assert_eq!(
            permission_wire(":read-only"),
            Some(("read-only", "readOnly", "on-request"))
        );
        assert_eq!(
            permission_wire(":workspace"),
            Some(("workspace-write", "workspaceWrite", "on-request"))
        );
        assert_eq!(
            permission_wire(":danger-full-access"),
            Some(("danger-full-access", "dangerFullAccess", "never"))
        );
        assert_eq!(permission_wire("custom"), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probes_permissions_and_dispatches_turns_over_symlinked_app_server() {
        use futures::{SinkExt, StreamExt};
        use std::{
            fs,
            os::unix::{fs as unix_fs, fs::PermissionsExt},
            sync::{Arc, Mutex},
        };
        use tokio::net::UnixListener;
        use tokio_tungstenite::{accept_async, tungstenite::Message};

        let dir = tempfile::Builder::new()
            .prefix("c-")
            .tempdir_in("/tmp")
            .unwrap();
        let home = dir.path().join("h");
        let control = home.join("app-server-control");
        fs::create_dir_all(&control).unwrap();
        fs::set_permissions(&control, fs::Permissions::from_mode(0o700)).unwrap();

        let daemon_dir = dir.path().join("d");
        fs::create_dir_all(&daemon_dir).unwrap();
        fs::set_permissions(&daemon_dir, fs::Permissions::from_mode(0o700)).unwrap();
        let target = daemon_dir.join("d.sock");
        let listener = UnixListener::bind(&target).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        unix_fs::symlink(&target, control.join("app-server-control.sock")).unwrap();

        let thread = Uuid::new_v4();
        let canonical_home = home.canonicalize().unwrap();
        let recorded = Arc::new(Mutex::new(Vec::<Value>::new()));
        let recorded_server = recorded.clone();
        let server = tokio::spawn(async move {
            let mut sandbox_type = "workspaceWrite".to_owned();
            let mut approval_policy = "on-request".to_owned();
            while let Ok((stream, _)) = listener.accept().await {
                let Ok(mut ws) = accept_async(stream).await else {
                    continue;
                };
                while let Some(Ok(frame)) = ws.next().await {
                    let Message::Text(text) = frame else {
                        continue;
                    };
                    let msg: Value = serde_json::from_str(&text).unwrap();
                    if msg.get("id").is_none() {
                        continue;
                    }
                    let id = msg["id"].clone();
                    let method = msg["method"].as_str().unwrap_or_default().to_owned();
                    let params = msg["params"].clone();
                    recorded_server.lock().unwrap().push(msg);
                    let reply = match method.as_str() {
                        "initialize" => json!({
                            "id": id,
                            "result": {"codexHome": canonical_home},
                        }),
                        "thread/loaded/list" => json!({
                            "id": id,
                            "result": {"data": [thread]},
                        }),
                        "thread/resume" => {
                            if let Some(mode) = params["sandbox"].as_str() {
                                sandbox_type = match mode {
                                    "read-only" => "readOnly",
                                    "danger-full-access" => "dangerFullAccess",
                                    _ => "workspaceWrite",
                                }
                                .to_owned();
                            }
                            if let Some(policy) = params["approvalPolicy"].as_str() {
                                approval_policy = policy.to_owned();
                            }
                            json!({
                                "id": id,
                                "result": {
                                    "sandbox": {"type": sandbox_type},
                                    "approvalPolicy": approval_policy,
                                    "approvalsReviewer": "user",
                                    "disabledPluginIds": ["blocked@local"],
                                    "model": "gpt-5.4",
                                    "reasoningEffort": "high",
                                    "serviceTier": "fast",
                                    "collaborationMode": {"mode": "default"},
                                },
                            })
                        }
                        "turn/start" => json!({
                            "id": id,
                            "result": {"turn": {"id": "turn-1"}},
                        }),
                        "turn/steer" => json!({
                            "id": id,
                            "result": {"turnId": params["expectedTurnId"]},
                        }),
                        "turn/interrupt" => json!({
                            "id": id,
                            "result": {},
                        }),
                        _ => json!({"id": id, "result": {}}),
                    };
                    ws.send(Message::Text(reply.to_string().into()))
                        .await
                        .unwrap();
                }
            }
        });

        let info = probe(&home, thread).await.expect("probe should succeed");
        assert!(info.loaded);
        assert_eq!(info.controls["permission"], ":workspace");
        assert_eq!(info.disabled_plugins, vec!["blocked@local"]);
        assert_eq!(info.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(info.effort.as_deref(), Some("high"));

        let view = View {
            thread: json!({"id": thread, "controls": info.controls}),
            messages: Vec::new(),
            epoch: Uuid::new_v4(),
            app_tools: true,
            app_server: true,
            turns: Vec::new(),
            native_goal: None,
            expanded: Default::default(),
            activities: Default::default(),
            pending: Default::default(),
            inline: Default::default(),
            reply_turns: Default::default(),
            disabled_plugins: info.disabled_plugins,
        };
        let change = json!({
            "action": "permission",
            "value": ":read-only",
            "expected": ":workspace",
            "expectedRevision": view.thread["controls"]["permissionRevision"],
        });
        assert!(matches!(
            set_permission(&home, thread, &view, &change).await,
            Outcome::Completed(None)
        ));
        let updated = probe(&home, thread).await.expect("probe after change");
        assert_eq!(updated.controls["permission"], ":read-only");

        let tools = vec![
            json!({"type": "skill", "name": "demo-skill", "path": "/tmp/SKILL.md"}),
            json!({"type": "mention", "name": "Demo Plugin", "path": "plugin://demo@local"}),
        ];
        assert!(matches!(
            send_turn(&home, thread, Uuid::new_v4(), "hello", &[], &tools).await,
            Outcome::Accepted(ref turn) if turn == "turn-1"
        ));
        assert!(matches!(
            steer_turn(&home, thread, Uuid::new_v4(), "turn-1", "follow up", &[]).await,
            Outcome::Accepted(ref turn) if turn == "turn-1"
        ));
        assert!(matches!(
            interrupt_turn(&home, thread, "turn-1").await,
            Outcome::Interrupted(ref turn) if turn == "turn-1"
        ));

        let calls = recorded.lock().unwrap();
        let start = calls
            .iter()
            .find(|call| call["method"] == "turn/start")
            .expect("turn/start call recorded");
        assert_eq!(start["params"]["input"].as_array().map(Vec::len), Some(3));
        server.abort();
    }
}
