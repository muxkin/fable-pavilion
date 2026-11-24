use super::{Action, Command, Outcome, View, app_server_tools};
use crate::{
    app_tools::{self, AppTools, Tool},
    codex::History,
    codex_peer::{Endpoint, Stream},
    files::attachment_prompt,
    settings,
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::{
    sync::{mpsc, watch},
    time::{MissedTickBehavior, interval, timeout},
};
use uuid::Uuid;

pub(super) async fn run(
    endpoint: &Endpoint,
    tools: &AppTools,
    history: &History,
    id: Uuid,
    commands: &mut mpsc::Receiver<Command>,
    updates: &watch::Sender<Option<Arc<View>>>,
) -> Result<()> {
    ensure!(
        tools.refresh().await.can_message(),
        "Codex 桌面未提供会话消息接口"
    );
    let lookup = history.clone();
    let anchor = tokio::task::spawn_blocking(move || lookup.anchor(&id.to_string())).await??;
    let mut stream = tools.connect(Tool::ReadThread).await?;
    let epoch = Uuid::new_v4();
    let mut revision = 0;
    let mut refresh = interval(Duration::from_secs(2));
    refresh.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut check_legacy = interval(Duration::from_secs(5));
    check_legacy.set_missed_tick_behavior(MissedTickBehavior::Delay);
    check_legacy.reset();
    let mut previous = None;
    let mut last_active = false;
    let mut force_refresh = false;
    loop {
        tokio::select! {
            _ = refresh.tick() => {
                let mut activity = read_status(&mut stream, &anchor, id, last_active).await?;
                if !last_active
                    && activity.status == "active"
                    && let Ok(latest) = read_status(&mut stream, &anchor, id, true).await
                {
                    activity = latest;
                }
                last_active = activity.status == "active";
                let session = app_server_tools::probe(history.home(), id).await;
                let store = history.clone();
                let prior = previous.take();
                let force = std::mem::take(&mut force_refresh);
                let (view, stamp) = tokio::task::spawn_blocking(move || {
                    let stamp = rollout_stamp(&store, id)
                        .map(|file| (activity.clone(), session.clone(), file));
                    let view = if !force && stamp.is_some() && stamp == prior {
                        None
                    } else {
                        Some(read_view(&store, id, activity, session, epoch)?)
                    };
                    Ok::<_, anyhow::Error>((view, stamp))
                }).await??;
                previous = stamp;
                let Some(mut view) = view else { continue };
                view.thread["revision"] = json!(revision);
                if !updates.borrow().as_ref().is_some_and(|last| {
                    last.epoch == epoch
                        && last.app_server == view.app_server
                        && last.disabled_plugins == view.disabled_plugins
                        && last.thread == view.thread
                        && last.messages == view.messages
                }) {
                    revision += 1;
                    view.thread["revision"] = json!(revision);
                    updates.send_replace(Some(Arc::new(view)));
                }
            }
            _ = check_legacy.tick() => {
                if timeout(Duration::from_millis(750), endpoint.open()).await.is_ok_and(|result| result.is_ok()) {
                    bail!("Codex 实时 IPC 已恢复");
                }
            }
            command = commands.recv() => {
                let Some(command) = command else { return Ok(()) };
                let current = updates.borrow().clone().filter(|view| view.epoch == epoch);
                let outcome = match current.as_deref() {
                    Some(view) if view.app_server => {
                        execute_app_server(
                            history.home(),
                            &mut stream,
                            &anchor,
                            id,
                            view,
                            command.request,
                            command.kind,
                        )
                        .await
                    }
                    Some(view) => {
                        let capability = if matches!(&command.kind, Action::Steer { .. }) {
                            "canSteer"
                        } else {
                            "canSend"
                        };
                        if view.thread[capability] == true {
                            send(&mut stream, &anchor, id, command.request, command.kind).await
                        } else {
                            Outcome::Rejected("当前 Codex 会话暂不可发送".into())
                        }
                    }
                    None => Outcome::Rejected("当前 Codex 会话暂不可发送".into()),
                };
                let _ = command.reply.send(outcome);
                force_refresh = true;
                refresh.reset_immediately();
            }
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
struct Activity {
    status: String,
    can_send: bool,
    active_turn: Option<String>,
    pending: bool,
    updated_at: Option<u64>,
}

impl Activity {
    fn can_steer(&self) -> bool {
        self.active_turn.is_some() && !self.pending
    }
}

async fn read_status(
    stream: &mut Stream,
    anchor: &str,
    id: Uuid,
    include_turn: bool,
) -> Result<Activity> {
    let mut args = json!({"threadId":id,"hostId":"local","includeTurns":include_turn});
    if include_turn {
        args["turnLimit"] = json!(1);
        args["includeOutputs"] = json!(false);
        args["maxOutputCharsPerItem"] = json!(0);
    }
    let value = app_tools::call(stream, anchor, Uuid::new_v4(), Tool::ReadThread, args).await?;
    let thread = &value["thread"];
    ensure!(
        value["schemaVersion"] == 1
            && thread["id"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok())
                == Some(id)
            && thread["kind"] == "codex"
            && thread["hostId"] == "local",
        "未确认本机 Codex 会话身份"
    );
    let status = thread["status"]["type"]
        .as_str()
        .filter(|status| matches!(*status, "notLoaded" | "idle" | "active" | "systemError"))
        .context("桌面会话状态无效")?;
    let flags = &thread["status"]["activeFlags"];
    let empty_flags = flags.as_array().is_some_and(Vec::is_empty);
    let active_turn =
        if status == "active" && include_turn && value["page"]["order"] == "newest_first" {
            value["turns"]
                .as_array()
                .and_then(|turns| match turns.as_slice() {
                    [turn] if turn["status"] == "inProgress" => turn["id"].as_str(),
                    _ => None,
                })
                .filter(|turn| {
                    (1..=200).contains(&turn.encode_utf16().count())
                        && !turn.chars().any(char::is_control)
                })
                .map(str::to_owned)
        } else {
            None
        };
    Ok(Activity {
        status: status.to_owned(),
        can_send: matches!(status, "notLoaded" | "idle") && (flags.is_null() || empty_flags),
        active_turn,
        pending: status == "active" && !empty_flags,
        updated_at: thread["updatedAt"].as_u64(),
    })
}

fn rollout_stamp(history: &History, id: Uuid) -> Option<(PathBuf, u64, SystemTime)> {
    let (_, path) = history.media_context(id).ok()?;
    let path = history.home().join(path);
    let (path, metadata) = match fs::metadata(&path) {
        Ok(metadata) => (path, metadata),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl")) =>
        {
            let path = path.with_extension("jsonl.zst");
            let metadata = fs::metadata(&path).ok()?;
            (path, metadata)
        }
        _ => return None,
    };
    if metadata.is_file() {
        Some((path, metadata.len(), metadata.modified().ok()?))
    } else {
        None
    }
}

fn read_view(
    history: &History,
    id: Uuid,
    activity: Activity,
    session: Option<app_server_tools::SessionInfo>,
    epoch: Uuid,
) -> Result<View> {
    let params = json!({"id":id});
    let page = history
        .rpc("history.read", &params, &Value::Null)
        .or_else(|_| history.rpc("thread.read", &params, &Value::Null))?
        .context("找不到本机会话")?;
    let mut thread = page["thread"].clone();
    ensure!(thread["id"] == json!(id), "历史会话与桌面会话不匹配");
    let app_server = session.is_some();
    let owner = session.as_ref().is_some_and(|s| s.loaded) && activity.status != "notLoaded";
    thread["owner"] = json!(owner);
    thread["synchronized"] = json!(true);
    thread["runtimeStatus"] = json!(activity.status);
    thread["canSend"] = json!(activity.can_send);
    thread["canSteer"] = json!(activity.can_steer());
    thread["activeTurnId"] = json!(activity.active_turn);
    thread["canResumeForSend"] = json!(activity.can_send);
    thread["textOnlySend"] = json!(!app_server);
    thread["canSendFileReferences"] = json!(true);
    thread["pendingRequests"] = json!(usize::from(activity.pending));
    thread["canInterrupt"] = json!(app_server && activity.active_turn.is_some());
    let (controls, disabled_plugins) = if let Some(session) = session {
        if let Some(model) = session.model {
            thread["model"] = json!(model);
        }
        if let Some(effort) = session.effort {
            thread["reasoningEffort"] = json!(effort);
        }
        if let Some(tier) = session.service_tier {
            thread["serviceTier"] = json!(tier);
        }
        if let Some(mode) = session.mode {
            thread["mode"] = json!(mode);
        }
        (session.controls, session.disabled_plugins)
    } else {
        (settings::permission(&Value::Null), Vec::new())
    };
    thread["controls"] = controls;
    if !activity.can_send && !activity.can_steer() {
        thread["reason"] = json!("请等待 Codex 当前操作结束，或在本机查看会话状态。");
    }
    let messages = page["messages"].as_array().cloned().unwrap_or_default();
    Ok(View {
        thread,
        messages,
        epoch,
        app_tools: true,
        app_server,
        turns: Vec::new(),
        native_goal: None,
        expanded: Default::default(),
        activities: Default::default(),
        pending: Default::default(),
        inline: Default::default(),
        reply_turns: Default::default(),
        disabled_plugins,
    })
}

async fn execute_app_server(
    home: &std::path::Path,
    stream: &mut Stream,
    anchor: &str,
    id: Uuid,
    view: &View,
    request: Uuid,
    action: Action,
) -> Outcome {
    let first_send = matches!(action, Action::FirstSend { .. });
    match action {
        Action::Permission { input } => app_server_tools::set_permission(home, id, view, &input).await,
        Action::Settings { input } => app_server_tools::set_settings(home, id, view, &input).await,
        Action::Interrupt { expected } => {
            if view.thread["activeTurnId"].as_str() == Some(expected.as_str()) {
                app_server_tools::interrupt_turn(home, id, &expected).await
            } else {
                Outcome::Rejected("当前任务已结束或已变化".into())
            }
        }
        Action::Send { text, files, tools } | Action::FirstSend { text, files, tools } => {
            if first_send && (!view.turns.is_empty() || !view.messages.is_empty()) {
                return Outcome::Rejected("桌面会话状态已变化".into());
            }
            if !read_status(stream, anchor, id, false)
                .await
                .is_ok_and(|activity| activity.can_send)
            {
                return Outcome::Rejected("未确认 Codex 当前会话可以发送，请刷新后重试".into());
            }
            app_server_tools::send_turn(home, id, request, &text, &files, &tools).await
        }
        Action::Steer {
            text,
            expected,
            files,
        } => {
            if !read_status(stream, anchor, id, true)
                .await
                .is_ok_and(|activity| {
                    activity.can_steer() && activity.active_turn.as_deref() == Some(expected.as_str())
                })
            {
                return Outcome::Rejected("未确认 Codex 当前会话可以追加，请刷新后重试".into());
            }
            app_server_tools::steer_turn(home, id, request, &expected, &text, &files).await
        }
        _ => Outcome::Rejected("Codex 桌面接口不支持此操作".into()),
    }
}

async fn send(
    stream: &mut Stream,
    anchor: &str,
    id: Uuid,
    request: Uuid,
    action: Action,
) -> Outcome {
    let (text, files, expected) = match action {
        Action::Send { text, files, tools } if tools.is_empty() => (text, files, None),
        Action::Steer {
            text,
            expected,
            files,
        } => (text, files, Some(expected)),
        Action::Send { .. } => {
            return Outcome::Rejected("Codex 桌面接口不支持随此消息发送技能或插件".into());
        }
        _ => return Outcome::Rejected("Codex 桌面接口不支持此操作".into()),
    };
    if text.trim().is_empty() && files.is_empty() {
        return Outcome::Rejected("请输入消息或选择附件".into());
    }
    // The desktop message tool takes a string. Reuse the same verified local file
    // references as Desktop's app-tool creation path.
    let Ok(prompt) = attachment_prompt(&text, &files, false) else {
        return Outcome::Rejected("无法读取附件路径，请重新上传".into());
    };
    if !read_status(stream, anchor, id, expected.is_some())
        .await
        .is_ok_and(|activity| match expected.as_deref() {
            Some(turn) => activity.can_steer() && activity.active_turn.as_deref() == Some(turn),
            None => activity.can_send,
        })
    {
        return Outcome::Rejected("未确认 Codex 当前会话可以发送，请刷新后重试".into());
    }
    let result = app_tools::call(
        stream,
        anchor,
        request,
        Tool::SendMessage,
        json!({"threadId":id,"hostId":"local","prompt":prompt}),
    )
    .await;
    if result.is_ok_and(|value| value["threadId"] == json!(id)) {
        Outcome::Completed(None)
    } else {
        Outcome::Uncertain
    }
}
