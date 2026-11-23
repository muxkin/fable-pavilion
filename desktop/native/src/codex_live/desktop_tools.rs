use super::{Action, Command, Outcome, View};
use crate::{
    app_tools::{self, AppTools, Tool},
    codex::History,
    codex_peer::{Endpoint, Stream},
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
    let mut force_refresh = false;
    loop {
        tokio::select! {
            _ = refresh.tick() => {
                let activity = read_status(&mut stream, &anchor, id).await?;
                let store = history.clone();
                let prior = previous.take();
                let force = std::mem::take(&mut force_refresh);
                let (view, stamp) = tokio::task::spawn_blocking(move || {
                    let stamp = rollout_stamp(&store, id).map(|file| (activity.clone(), file));
                    let view = if !force && stamp.is_some() && stamp == prior {
                        None
                    } else {
                        Some(read_view(&store, id, activity, epoch)?)
                    };
                    Ok::<_, anyhow::Error>((view, stamp))
                }).await??;
                previous = stamp;
                let Some(mut view) = view else { continue };
                view.thread["revision"] = json!(revision);
                if !updates.borrow().as_ref().is_some_and(|last| {
                    last.epoch == epoch && last.thread == view.thread && last.messages == view.messages
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
                let ready = updates.borrow().as_ref().is_some_and(|view| {
                    view.epoch == epoch && view.thread["canSend"] == true
                });
                let outcome = if ready {
                    send(&mut stream, &anchor, id, command.request, command.kind).await
                } else {
                    Outcome::Rejected("当前 Codex 会话暂不可发送".into())
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
    updated_at: Option<u64>,
}

async fn read_status(stream: &mut Stream, anchor: &str, id: Uuid) -> Result<Activity> {
    let value = app_tools::call(
        stream,
        anchor,
        Uuid::new_v4(),
        Tool::ReadThread,
        json!({"threadId":id,"hostId":"local","includeTurns":false}),
    )
    .await?;
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
    Ok(Activity {
        status: status.to_owned(),
        can_send: matches!(status, "notLoaded" | "idle")
            && (flags.is_null() || flags.as_array().is_some_and(Vec::is_empty)),
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

fn read_view(history: &History, id: Uuid, activity: Activity, epoch: Uuid) -> Result<View> {
    let params = json!({"id":id});
    let page = history
        .rpc("history.read", &params, &Value::Null)
        .or_else(|_| history.rpc("thread.read", &params, &Value::Null))?
        .context("找不到本机会话")?;
    let mut thread = page["thread"].clone();
    ensure!(thread["id"] == json!(id), "历史会话与桌面会话不匹配");
    thread["owner"] = json!(false);
    thread["synchronized"] = json!(true);
    thread["runtimeStatus"] = json!(activity.status);
    thread["canSend"] = json!(activity.can_send);
    thread["canResumeForSend"] = json!(activity.can_send);
    thread["textOnlySend"] = json!(true);
    thread["pendingRequests"] = json!(0);
    thread["canInterrupt"] = json!(false);
    thread["controls"] = settings::permission(&Value::Null);
    if !activity.can_send {
        thread["reason"] = json!("请等待 Codex 当前操作结束，或在本机查看会话状态。");
    }
    let messages = page["messages"].as_array().cloned().unwrap_or_default();
    Ok(View {
        thread,
        messages,
        epoch,
        app_tools: true,
        turns: Vec::new(),
        native_goal: None,
        expanded: Default::default(),
        activities: Default::default(),
        pending: Default::default(),
        inline: Default::default(),
        reply_turns: Default::default(),
        disabled_plugins: Default::default(),
    })
}

async fn send(
    stream: &mut Stream,
    anchor: &str,
    id: Uuid,
    request: Uuid,
    action: Action,
) -> Outcome {
    let Action::Send { text, files, tools } = action else {
        return Outcome::Rejected("Codex 桌面消息接口仅支持发送文字".into());
    };
    if !files.is_empty() || !tools.is_empty() || text.trim().is_empty() {
        return Outcome::Rejected("Codex 桌面消息接口仅支持发送不含附件或工具的文字".into());
    }
    if !read_status(stream, anchor, id)
        .await
        .is_ok_and(|activity| activity.can_send)
    {
        return Outcome::Rejected("未确认 Codex 当前会话可以发送，请刷新后重试".into());
    }
    let result = app_tools::call(
        stream,
        anchor,
        request,
        Tool::SendMessage,
        json!({"threadId":id,"hostId":"local","prompt":text}),
    )
    .await;
    if result.is_ok_and(|value| value["threadId"] == json!(id)) {
        Outcome::Completed(None)
    } else {
        Outcome::Uncertain
    }
}
