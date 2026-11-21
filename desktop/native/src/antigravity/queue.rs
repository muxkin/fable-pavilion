use super::{Backend, Daemon, delivery, stream, valid_id, valid_text};
use crate::{plugins::Delivery, state::hash};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use prost::Message;
use serde_json::{Value, json};
use std::{collections::HashSet, time::Duration};
use uuid::Uuid;

const WHEN_IDLE: &str = "MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE";
const MAX_FRAME: usize = 2 * 1024 * 1024;
const MAX_QUEUE: usize = 30;

// AgentMessage.stepPayload contains a native gemini_coder.Step. Decode only
// the user-input fields needed for displaying and identifying queued prompts.
#[derive(Clone, PartialEq, Message)]
struct Step {
    #[prost(message, optional, tag = "19")]
    user_input: Option<UserInput>,
}

#[derive(Clone, PartialEq, Message)]
struct UserInput {
    #[prost(string, tag = "2")]
    response: String,
    #[prost(message, repeated, tag = "3")]
    items: Vec<TextItem>,
}

#[derive(Clone, PartialEq, Message)]
struct TextItem {
    #[prost(string, tag = "1")]
    text: String,
}

pub(super) struct Snapshot {
    fingerprint: String,
    running: bool,
    rows: Vec<Value>,
}

impl Snapshot {
    pub(super) fn from_frame(frame: &Value, thread: &str) -> Result<Self> {
        let update = &frame["update"];
        ensure!(
            update["conversationId"] == thread && update["mainTrajectoryUpdate"].is_object(),
            "Antigravity 队列快照无效"
        );
        let running = matches!(
            update["status"].as_str(),
            Some("CASCADE_RUN_STATUS_RUNNING" | "CASCADE_RUN_STATUS_BUSY")
        );
        let pending = &update["pendingAgentMessagesUpdate"];
        let messages = pending["pendingAgentMessages"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        ensure!(
            pending["totalLength"].as_u64().unwrap_or_default() == messages.len() as u64,
            "Antigravity 队列快照不完整"
        );
        if !messages.is_empty() {
            let indices = pending["indices"]
                .as_array()
                .context("Antigravity 队列缺少顺序")?;
            ensure!(
                indices.len() == messages.len()
                    && indices
                        .iter()
                        .enumerate()
                        .all(|(index, actual)| actual.as_u64() == Some(index as u64)),
                "Antigravity 队列快照不完整"
            );
        }
        let mut ids = HashSet::new();
        let mut rows = Vec::new();
        for message in messages {
            if message["deliveryStrategy"] != WHEN_IDLE || message["recipient"] != thread {
                continue;
            }
            let Some(encoded) = message["stepPayload"].as_str() else {
                continue;
            };
            let Ok(bytes) = STANDARD.decode(encoded) else {
                continue;
            };
            let Some(input) = Step::decode(bytes.as_slice())
                .ok()
                .and_then(|step| step.user_input)
            else {
                continue;
            };
            let id = message["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 200 && !id.chars().any(char::is_control))
                .context("Antigravity 队列消息标识无效")?;
            ensure!(ids.insert(id), "Antigravity 队列消息标识重复");
            let mut text = input
                .items
                .into_iter()
                .map(|item| item.text)
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if text.is_empty() {
                text = input.response;
            }
            rows.push(json!({"id":id,"text":&text[..text.floor_char_boundary(text.len().min(12_000))],"status":"queued"}));
        }
        Ok(Self {
            fingerprint: hash(&json!(messages).to_string()),
            running,
            rows,
        })
    }

    pub(super) fn display(&self, view: &mut Value) {
        view["queueFingerprint"] = json!(self.fingerprint);
        view["queuedMessages"] = json!(&self.rows[..self.rows.len().min(MAX_QUEUE)]);
    }
}

pub(super) async fn read(backend: &Backend, daemon: &Daemon, thread: &str) -> Result<Snapshot> {
    let frame = stream::first_update(
        backend,
        daemon,
        thread,
        0..0,
        MAX_FRAME,
        Duration::from_secs(2),
    )
    .await?;
    Snapshot::from_frame(&frame, thread)
}

async fn current(backend: &Backend, thread: &str, expected: &str) -> Result<(Daemon, Snapshot)> {
    valid_id(thread)?;
    let daemon = backend.daemon().await?;
    let queue = read(backend, &daemon, thread).await?;
    ensure!(
        queue.fingerprint == expected,
        "Antigravity 队列已变化，请刷新后重试"
    );
    Ok((daemon, queue))
}

pub(super) async fn add(
    backend: &Backend,
    thread: &str,
    request: Uuid,
    expected: &str,
    text: &str,
) -> Delivery {
    if !valid_text(text) {
        return Delivery::Rejected("请输入队列消息（最多 16000 字符）");
    }
    let Ok((daemon, queue)) = current(backend, thread, expected).await else {
        return Delivery::Rejected("Antigravity 队列无法核对，请刷新后重试");
    };
    if !queue.running || queue.rows.len() >= MAX_QUEUE {
        return Delivery::Rejected("当前会话无法添加队列消息");
    }
    delivery(
        backend.call_at(&daemon, "SendUserCascadeMessage", &json!({
            "cascadeId":thread,"items":[{"text":text.trim()}],"clientMessageId":request,"deliveryStrategy":WHEN_IDLE,
        }), true).await,
        Delivery::Completed(None),
    )
}

pub(super) async fn remove(
    backend: &Backend,
    thread: &str,
    expected: &str,
    message: &str,
) -> Delivery {
    let Ok((daemon, queue)) = current(backend, thread, expected).await else {
        return Delivery::Rejected("Antigravity 队列无法核对，请刷新后重试");
    };
    if !queue.rows.iter().any(|row| row["id"] == message) {
        return Delivery::Rejected("消息已离开 Antigravity 队列");
    }
    delivery(
        backend
            .call_at(
                &daemon,
                "DeleteAgentMessage",
                &json!({"recipient":thread,"messageId":message}),
                true,
            )
            .await,
        Delivery::Completed(None),
    )
}
