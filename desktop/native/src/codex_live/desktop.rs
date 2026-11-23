use super::{Action, Outcome, Turn, View, delegated_input};
use crate::{
    app_tools::AppTools,
    codex::History,
    codex_peer::{Endpoint, Stream},
    files::{Attachment, attachment_prompt, message_attachment_text},
    history_media, queue, requests, settings, tool_activity,
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::{Instant, sleep, sleep_until, timeout},
};
use uuid::Uuid;

#[path = "follow_frame.rs"]
mod follow_frame;
#[path = "desktop_projection.rs"]
mod projection;
#[path = "desktop_tools.rs"]
mod desktop_tools;
#[cfg(test)]
#[path = "desktop_tests.rs"]
mod tests;
pub(crate) use projection::{native_text, native_user_text, ordered};
use projection::{compatible_state, patch, project};

const MAX_FRAME: usize = 32 * 1024 * 1024;
// Desktop sends the whole conversation, including embedded tool results, on first follow.
const MAX_FOLLOW_FRAME: usize = 128 * 1024 * 1024;
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Clone)]
pub struct Desktop {
    endpoint: Endpoint,
    history: History,
    threads: Arc<Mutex<HashMap<Uuid, Weak<Thread>>>>,
    pub tools: AppTools,
    pub reply_fork: crate::reply_fork::ReplyFork,
    pub(crate) goals: crate::codex_goal::Goals,
    pub(crate) usage: crate::usage::Usage,
}

impl Desktop {
    pub fn new(endpoint: Endpoint, history: History, cli: Option<&std::path::Path>) -> Self {
        let tools = AppTools::new(endpoint.clone());
        Self {
            usage: crate::usage::Usage::new(tools.clone()),
            goals: crate::codex_goal::Goals::new(history.home().to_owned()),
            reply_fork: crate::reply_fork::ReplyFork::new(endpoint.executable(), cli),
            tools,
            endpoint,
            history,
            threads: Default::default(),
        }
    }

    pub(crate) async fn ipc_available(&self) -> bool {
        self.endpoint.open().await.is_ok()
    }

    pub(crate) async fn models(&self) -> Result<Value> {
        let history = self.history.clone();
        // A successful CLI child can return a valid but different product catalog.
        if let Ok(Some(catalog)) =
            tokio::task::spawn_blocking(move || history.desktop_models()).await?
        {
            return Ok(catalog);
        }
        if let Ok(catalog) = self.reply_fork.models(self.history.home()).await {
            return Ok(catalog);
        }
        let history = self.history.clone();
        tokio::task::spawn_blocking(move || history.models()).await?
    }

    pub fn subscribe(&self, id: Uuid) -> Option<Arc<Thread>> {
        let mut threads = self.threads.lock().expect("desktop mutex poisoned");
        threads.retain(|_, thread| thread.strong_count() > 0);
        if let Some(thread) = threads.get(&id).and_then(Weak::upgrade) {
            return Some(thread);
        }
        if threads.len() >= 24 {
            return None;
        }
        let (commands, inputs) = mpsc::channel(1);
        let (state, view) = watch::channel(None);
        let task = tokio::spawn(run_thread(
            self.endpoint.clone(),
            self.tools.clone(),
            self.history.clone(),
            id,
            inputs,
            state,
        ));
        let thread = Arc::new(Thread {
            commands,
            view,
            task,
        });
        threads.insert(id, Arc::downgrade(&thread));
        Some(thread)
    }
}

pub struct Thread {
    commands: mpsc::Sender<Command>,
    pub view: watch::Receiver<Option<Arc<View>>>,
    task: JoinHandle<()>,
}

impl Drop for Thread {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Thread {
    pub fn reply_forkable(&self, turn: &str) -> Option<bool> {
        let view = self.view.borrow();
        let view = view.as_ref()?;
        let live = view.turns.iter().find(|entry| entry.id == turn)?;
        if live.state != "completed" {
            return Some(false);
        }
        view.reply_turns.contains(turn).then_some(true)
    }

    pub async fn execute(&self, kind: Action, request: Uuid) -> Outcome {
        let (reply, result) = oneshot::channel();
        if self
            .commands
            .try_send(Command {
                kind,
                request,
                reply,
            })
            .is_err()
        {
            return Outcome::Rejected("当前会话有另一个请求正在确认".into());
        }
        result.await.unwrap_or(Outcome::Uncertain)
    }
}

impl Action {
    fn request(&self, id: Uuid, request: Uuid, view: &View) -> Result<(&'static str, u32, Value)> {
        let active = view.thread["activeTurnId"].as_str();
        let pending = view.thread["pendingRequests"].as_u64().unwrap_or(1);
        Ok(match self {
            Self::Send { text, files, tools } | Self::FirstSend { text, files, tools }
                if view.thread["canSend"] == true
                    && (!matches!(self, Self::FirstSend { .. })
                        || (view.turns.is_empty() && view.messages.is_empty())) =>
            {
                let (mut input, attachments) = native_input(text, files)?;
                input.extend(tools.iter().cloned());
                (
                    "thread-follower-start-turn",
                    2,
                    json!({
                        "conversationId": id, "turnStart": {
                            "request": {"threadId": id, "input": input, "clientUserMessageId": request},
                            "context": {"inheritThreadSettings": true, "attachments": attachments},
                        },
                    }),
                )
            }
            Self::Steer {
                text,
                expected,
                files,
            } if active == Some(expected.as_str()) && pending == 0 => {
                let (input, attachments) = native_input(text, files)?;
                (
                    "thread-follower-steer-turn",
                    1,
                    json!({
                        "conversationId": id, "input": input, "attachments": attachments,
                        "clientUserMessageId": request, "restoreMessage": {
                            "id": request, "text": text, "cwd": view.thread["cwd"],
                            "context": {"fileAttachments": attachments},
                        },
                    }),
                )
            }
            Self::Interrupt { expected } if active == Some(expected.as_str()) => (
                "thread-follower-interrupt-turn",
                4,
                json!({"conversationId": id, "expectedTurnId": expected, "mode": "user-stop"}),
            ),
            Self::Settings { input } => (
                "thread-follower-update-thread-settings",
                2,
                json!({"conversationId":id,"threadSettings":settings::model_request(view, input)?,
                    "condition":{"ifModelEquals":input["expectedModel"],"ifEffortEquals":input["expectedEffort"]}}),
            ),
            Self::Permission { input } => (
                "thread-follower-update-thread-settings",
                2,
                json!({"conversationId":id,"threadSettings":settings::permission_request(view, input)?}),
            ),
            Self::Respond { response } => response.native(id, view)?,
            _ => bail!("桌面会话状态已变化"),
        })
    }

    async fn outcome(
        &self,
        response: &Value,
        method: &str,
        wire: &mut Wire,
        follower: &mut Follower<'_>,
    ) -> Outcome {
        match self {
            Self::Settings { input } | Self::Permission { input } => {
                if response["result"]["applied"] == false {
                    return Outcome::Rejected("桌面设置已变化，请重新打开面板".into());
                }
                if response["result"]["applied"] != true {
                    return Outcome::Uncertain;
                }
                if matches!(self, Self::Settings { .. }) {
                    let owner = follower.owner.clone();
                    let confirmed = wire
                        .call(
                            "thread-follower-read-model-settings",
                            1,
                            Some(&owner),
                            json!({"conversationId":follower.id}),
                            Some(follower),
                            Duration::from_secs(5),
                        )
                        .await;
                    let Ok(confirmed) = confirmed else {
                        return Outcome::Uncertain;
                    };
                    let actual = &confirmed["result"]["settings"];
                    if actual["model"] != input["model"]
                        || actual["reasoningEffort"] != input["effort"]
                    {
                        return Outcome::Uncertain;
                    }
                }
                let matches = |state: &Value| {
                    let settings = &state["latestThreadSettings"];
                    match self {
                        Self::Permission { .. } => settings::permission_applied(settings, input),
                        _ => {
                            input.get("mode").is_none_or(|mode| {
                                *mode == state["latestCollaborationMode"]["mode"]
                            }) && input.get("serviceTier").is_none_or(|tier| {
                                let actual = &settings["serviceTier"];
                                *tier == *actual || (tier == "default" && actual.is_null())
                            })
                        }
                    }
                };
                let observed = timeout(Duration::from_secs(5), async {
                    while !matches(&follower.state) {
                        let value = wire.incoming.recv().await.context("Codex 已断开")?;
                        wire.incoming_message(value, Some(follower)).await?;
                    }
                    Ok::<_, anyhow::Error>(())
                })
                .await;
                if observed.is_ok_and(|result| result.is_ok()) {
                    Outcome::Completed(None)
                } else {
                    Outcome::Uncertain
                }
            }
            Self::Respond { .. } | Self::Send { .. } | Self::FirstSend { .. }
                if method == "thread-follower-start-turn" =>
            {
                let result = &response["result"]["result"];
                result["turn"]["id"]
                    .as_str()
                    .or_else(|| result["turnId"].as_str())
                    .or_else(|| result["id"].as_str())
                    .filter(|value| !value.is_empty())
                    .map_or(Outcome::Uncertain, |id| Outcome::Accepted(id.to_owned()))
            }
            Self::Respond { response: answered } => {
                if response["result"]["ok"] == false || response["result"]["accepted"] == false {
                    return Outcome::Uncertain;
                }
                let id = &answered.target_request_id;
                let still_pending = |view: &View| {
                    if id.starts_with("async:") {
                        view.thread["requests"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|request| request["id"] == *id)
                    } else {
                        view.pending
                            .iter()
                            .any(|request| requests::request_id(request).as_ref() == Some(id))
                    }
                };
                let observed = timeout(Duration::from_secs(5), async {
                    while follower.revision.is_none()
                        || follower
                            .updates
                            .borrow()
                            .as_ref()
                            .is_none_or(|view| still_pending(view))
                    {
                        let value = wire.incoming.recv().await.context("Codex 已断开")?;
                        wire.incoming_message(value, Some(follower)).await?;
                    }
                    Ok::<_, anyhow::Error>(())
                })
                .await;
                if observed.is_ok_and(|result| result.is_ok()) {
                    Outcome::Completed(None)
                } else {
                    Outcome::Uncertain
                }
            }
            Self::Queue { change } => {
                if change.confirmed(response) {
                    Outcome::Completed(None)
                } else {
                    Outcome::Uncertain
                }
            }
            Self::Send { .. } | Self::FirstSend { .. } | Self::Goal { .. } => Outcome::Uncertain,
            Self::Steer { expected, .. } => Outcome::Accepted(expected.clone()),
            Self::Interrupt { expected } => Outcome::Interrupted(
                response["result"]["interruptedTurnId"]
                    .as_str()
                    .unwrap_or(expected)
                    .to_owned(),
            ),
        }
    }
}

fn native_input(text: &str, files: &[Attachment]) -> Result<(Vec<Value>, Vec<Value>)> {
    let mut attachments = Vec::new();
    let mut input = Vec::new();
    let prompt = attachment_prompt(text, files, true)?;
    for file in files {
        let path = file.path.to_str().context("附件路径不能表示为文字")?;
        let mut metadata = json!({"label":file.name,"path":path,"fsPath":path});
        if file.image() {
            input.push(json!({"type":"localImage","path":path}));
            metadata["isImageAttachment"] = json!(true);
        }
        attachments.push(metadata);
    }
    input.insert(0, json!({"type":"text","text":prompt,"text_elements":[]}));
    Ok((input, attachments))
}

struct Command {
    kind: Action,
    request: Uuid,
    reply: oneshot::Sender<Outcome>,
}

async fn run_thread(
    endpoint: Endpoint,
    tools: AppTools,
    history: History,
    id: Uuid,
    mut commands: mpsc::Receiver<Command>,
    updates: watch::Sender<Option<Arc<View>>>,
) {
    loop {
        let result = match endpoint.open().await {
            Ok(stream) => follow(stream, &history, id, &mut commands, &updates).await,
            Err(_) => desktop_tools::run(&endpoint, &tools, &history, id, &mut commands, &updates).await,
        };
        updates.send_replace(None);
        if result.is_ok() {
            return;
        }
        let retry = sleep(Duration::from_millis(1250));
        tokio::pin!(retry);
        loop {
            tokio::select! {
                _ = &mut retry => break,
                command = commands.recv() => {
                    let Some(command) = command else { return };
                    let _ = command.reply.send(Outcome::Rejected("桌面会话暂未同步".into()));
                }
            }
        }
    }
}

async fn follow(
    stream: Stream,
    history: &History,
    id: Uuid,
    commands: &mut mpsc::Receiver<Command>,
    updates: &watch::Sender<Option<Arc<View>>>,
) -> Result<()> {
    let mut wire = Wire::new(stream);
    let initial = wire
        .call(
            "initialize",
            0,
            None,
            json!({"clientType": "codex-pocket-remote"}),
            None,
            Duration::from_secs(5),
        )
        .await?;
    wire.client_id = initial["result"]["clientId"]
        .as_str()
        .context("Codex 初始化未确认")?
        .to_owned();
    let owner = wire
        .call(
            "thread-owner-discovery",
            1,
            None,
            json!({"hostId": "local", "conversationId": id}),
            None,
            Duration::from_secs(5),
        )
        .await?;
    let owner = owner["handledByClientId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .context("Codex 会话尚未打开")?
        .to_owned();
    let mut follower = Follower {
        id,
        owner,
        revision: None,
        state: Value::Null,
        updates,
        epoch: Uuid::new_v4(),
        queue: None,
        snapshot_deadline: Instant::now() + SNAPSHOT_TIMEOUT,
    };
    wire.follow(&follower, true).await?;
    let mut awaiting_turn = None;
    let mut queue_tick = tokio::time::interval(Duration::from_millis(850));
    queue_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = sleep_until(follower.snapshot_deadline), if follower.state.is_null() => bail!("Codex 会话未发送快照"),
            _ = queue_tick.tick() => {
                follower.update_queue(read_queue(history, id).await);
            }
            value = wire.incoming.recv() => {
                let value = value.context("Codex 已断开")?;
                wire.incoming_message(value, Some(&mut follower)).await?;
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    let _ = wire.follow(&follower, false).await;
                    return Ok(());
                };
                let current_queue = if matches!(command.kind, Action::Queue { .. }) {
                    read_queue(history, id).await
                } else { None };
                let request = updates.borrow().as_ref().and_then(|view| {
                    if let Some(turn) = &awaiting_turn {
                        if view.turns.iter().any(|entry| &entry.id == turn) {
                            awaiting_turn = None;
                        }
                    }
                    let request = match &command.kind {
                        Action::Queue { change } => change.request(id, view, &follower.state, current_queue?).ok()?,
                        action => action.request(id, command.request, view).ok()?,
                    };
                    if awaiting_turn.is_some() && request.0 == "thread-follower-start-turn" {
                        return None;
                    }
                    Some(request)
                });
                let Some((method, version, params)) = request else {
                    let _ = command.reply.send(Outcome::Rejected("会话尚未同步或目标任务已变化".into()));
                    continue;
                };
                let owner = follower.owner.clone();
                let duration = Duration::from_secs(match command.kind {
                    _ if method == "thread-follower-start-turn" || method == "thread-follower-steer-turn" => 30,
                    _ => 15,
                });
                let mut result = wire.call(method, version, Some(&owner), params, Some(&mut follower), duration).await;
                if method == queue::SET_QUEUED_FOLLOW_UPS
                    && result.as_ref().is_err_and(|error| matches!(error.downcast_ref(), Some(RoutingFailure::IncompatibleVersion)))
                    && let Action::Queue { change } = &command.kind
                {
                    // Codex rejects the incompatible version before invoking the handler.
                    let current = read_queue(history, id).await;
                    let retry = updates.borrow().as_ref().and_then(|view| {
                        change.request(id, view, &follower.state, current?).ok()
                    });
                    let Some((_, _, params)) = retry else {
                        let _ = command.reply.send(Outcome::Rejected("桌面队列已变化或会话未同步，请刷新后重试".into()));
                        continue;
                    };
                    result = wire.call(method, queue::LEGACY_SET_VERSION, Some(&owner), params, Some(&mut follower), duration).await;
                }
                let (outcome, lost) = match result {
                    Ok(value) => {
                        let outcome = command.kind.outcome(&value, method, &mut wire, &mut follower).await;
                        if matches!(command.kind, Action::Queue { .. }) {
                            follower.update_queue(read_queue(history, id).await);
                        }
                        let lost = matches!(outcome, Outcome::Uncertain);
                        if let ("thread-follower-start-turn", Outcome::Accepted(turn)) = (method, &outcome) {
                            awaiting_turn = Some(turn.clone());
                        }
                        (outcome, lost)
                    }
                    Err(error) if matches!(error.downcast_ref(), Some(RoutingFailure::IncompatibleVersion)) => (
                        Outcome::Rejected("此操作与当前 Codex 桌面版本不兼容".into()), false,
                    ),
                    Err(error) if matches!(error.downcast_ref(), Some(RoutingFailure::MissingHandler)) => (
                        Outcome::Rejected("桌面未接收请求，请确认会话仍然打开".into()), true,
                    ),
                    Err(_) => (Outcome::Uncertain, true),
                };
                let _ = command.reply.send(outcome);
                if lost {
                    bail!("桌面操作需重新确认连接");
                }
            }
        }
    }
}

async fn read_queue(history: &History, id: Uuid) -> Option<queue::Snapshot> {
    let history = history.clone();
    tokio::task::spawn_blocking(move || queue::Snapshot::read(&history, id))
        .await
        .ok()
        .and_then(Result::ok)
}

#[derive(Debug)]
enum RoutingFailure {
    IncompatibleVersion,
    MissingHandler,
}
impl std::fmt::Display for RoutingFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::IncompatibleVersion => "Codex request version mismatch",
            Self::MissingHandler => "Codex request handler unavailable",
        })
    }
}
impl std::error::Error for RoutingFailure {}

struct Wire {
    client_id: String,
    output: tokio::io::WriteHalf<Stream>,
    incoming: mpsc::Receiver<Value>,
    reader: JoinHandle<()>,
}

impl Drop for Wire {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl Wire {
    fn new(stream: Stream) -> Self {
        let (mut input, output) = tokio::io::split(stream);
        let (send, incoming) = mpsc::channel(1);
        let reader = tokio::spawn(async move {
            while let Ok(value) = follow_frame::read(&mut input, MAX_FOLLOW_FRAME).await {
                if send.send(value).await.is_err() {
                    break;
                }
            }
        });
        Self {
            client_id: "pocket-uninitialized".into(),
            output,
            incoming,
            reader,
        }
    }

    async fn call(
        &mut self,
        method: &str,
        version: u32,
        owner: Option<&str>,
        params: Value,
        mut follower: Option<&mut Follower<'_>>,
        duration: Duration,
    ) -> Result<Value> {
        let id = Uuid::new_v4().to_string();
        let mut request = json!({
            "type": "request", "requestId": id, "sourceClientId": self.client_id,
            "method": method, "params": params, "version": version, "timeoutMs": duration.as_millis() - 250,
        });
        if let Some(owner) = owner {
            request["targetClientId"] = json!(owner);
        }
        timeout(duration, async {
            self.send(request).await?;
            loop {
                let value = self.incoming.recv().await.context("Codex 已断开")?;
                if value["type"] == "response" && value["requestId"] == id {
                    if value["resultType"] == "success" {
                        return Ok(value);
                    }
                    return match value["error"].as_str() {
                        Some("request-version-mismatch") => {
                            Err(RoutingFailure::IncompatibleVersion.into())
                        }
                        Some("no-client-found" | "no-handler-for-request") => {
                            Err(RoutingFailure::MissingHandler.into())
                        }
                        _ => bail!("Codex 未确认请求"),
                    };
                }
                self.incoming_message(value, follower.as_deref_mut())
                    .await?;
            }
        })
        .await?
    }

    async fn send(&mut self, value: Value) -> Result<()> {
        let bytes = serde_json::to_vec(&value)?;
        ensure!((1..=MAX_FRAME).contains(&bytes.len()), "Codex IPC 请求过大");
        timeout(Duration::from_secs(5), async {
            self.output.write_u32_le(bytes.len() as u32).await?;
            self.output.write_all(&bytes).await?;
            self.output.flush().await
        })
        .await??;
        Ok(())
    }

    async fn follow(&mut self, follower: &Follower<'_>, following: bool) -> Result<()> {
        self.send(json!({
            "type": "broadcast", "sourceClientId": self.client_id, "targetClientIds": [&follower.owner],
            "method": "thread-stream-following-changed", "version": 1,
            "params": {"hostId": "local", "conversationId": follower.id, "following": following},
        })).await
    }

    async fn incoming_message(
        &mut self,
        value: Value,
        follower: Option<&mut Follower<'_>>,
    ) -> Result<()> {
        if value["type"] == "client-discovery-request" {
            return self
                .send(json!({
                    "type": "client-discovery-response", "requestId": value["requestId"],
                    "response": {"canHandle": false},
                }))
                .await;
        }
        if value["type"] == "broadcast" {
            if let Some(follower) = follower {
                match follower.receive(value)? {
                    Change::Follow => self.follow(follower, true).await?,
                    Change::None => {}
                }
            }
        }
        Ok(())
    }
}

pub(crate) async fn read_frame(input: &mut (impl AsyncRead + Unpin)) -> Result<Value> {
    read_frame_with_limit(input, MAX_FRAME).await
}

async fn read_frame_with_limit(
    input: &mut (impl AsyncRead + Unpin),
    limit: usize,
) -> Result<Value> {
    let size = input.read_u32_le().await? as usize;
    ensure!((1..=limit).contains(&size), "Codex IPC 消息大小无效");
    let mut data = vec![0; size];
    input.read_exact(&mut data).await?;
    let value: Value = serde_json::from_slice(&data)?;
    ensure!(value.is_object(), "Codex IPC 消息格式无效");
    Ok(value)
}

enum Change {
    None,
    Follow,
}

struct Follower<'a> {
    id: Uuid,
    owner: String,
    revision: Option<u64>,
    state: Value,
    updates: &'a watch::Sender<Option<Arc<View>>>,
    epoch: Uuid,
    queue: Option<queue::Snapshot>,
    snapshot_deadline: Instant,
}

impl Follower<'_> {
    fn receive(&mut self, mut value: Value) -> Result<Change> {
        let params = &value["params"];
        let method = value["method"].as_str().unwrap_or_default();
        if method == "client-status-changed"
            && params["status"] == "disconnected"
            && params["clientId"] == self.owner
        {
            bail!("Codex 会话拥有者已断开");
        }
        if value["sourceClientId"] != self.owner
            || params["hostId"] != "local"
            || params["conversationId"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok())
                != Some(self.id)
        {
            return Ok(Change::None);
        }
        if method == "thread-stream-following-status-requested" {
            return Ok(Change::Follow);
        }
        if method != "thread-stream-state-changed" {
            return Ok(Change::None);
        }
        let change = &mut value["params"]["change"];
        let Some(revision) = change["revision"].as_u64() else {
            return Ok(self.resync());
        };
        if self.revision.is_some_and(|current| {
            revision < current || (revision == current && !self.state.is_null())
        }) {
            return Ok(Change::None);
        }

        match change["type"].as_str() {
            Some("snapshot") => {
                let state = change["conversationState"].take();
                if !compatible_state(self.id, &state) {
                    return Ok(self.resync());
                }
                self.state = state;
            }
            Some("patches") => {
                if self.state.is_null() {
                    return Ok(Change::None);
                }
                if change["baseRevision"].as_u64() != self.revision
                    || !change["patches"].as_array_mut().is_some_and(|patches| {
                        patches
                            .iter_mut()
                            .all(|entry| patch(&mut self.state, entry).is_ok())
                    })
                    || !compatible_state(self.id, &self.state)
                {
                    return Ok(self.resync());
                }
            }
            _ => return Ok(self.resync()),
        }
        self.revision = Some(revision);
        let mut view = project(self.id, &self.state, revision, self.epoch);
        if let Some(queue) = &self.queue {
            queue.display(&mut view.thread);
        }
        self.updates.send_replace(Some(Arc::new(view)));
        Ok(Change::None)
    }

    fn update_queue(&mut self, queue: Option<queue::Snapshot>) {
        if queue == self.queue {
            return;
        }
        self.queue = queue;
        self.updates.send_if_modified(|view| {
            let Some(view) = view else {
                return false;
            };
            let view = Arc::make_mut(view);
            if let Some(queue) = &self.queue {
                queue.display(&mut view.thread);
            } else if let Some(thread) = view.thread.as_object_mut() {
                thread.remove("queueFingerprint");
                thread.remove("queuedMessages");
            }
            true
        });
    }

    fn resync(&mut self) -> Change {
        if self.state.is_null() {
            return Change::None;
        }
        self.state = Value::Null;
        self.epoch = Uuid::new_v4();
        self.snapshot_deadline = Instant::now() + SNAPSHOT_TIMEOUT;
        self.updates.send_replace(None);
        Change::Follow
    }
}

