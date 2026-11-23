use crate::{
    codex_live::read_frame,
    codex_peer::{Endpoint, Stream},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{io::AsyncWriteExt, time::timeout};
use uuid::Uuid;

#[derive(Clone, Copy)]
pub enum Tool {
    Open,
    ReadThread,
    SendMessage,
    Create,
    Projects,
    Rename,
    Fork,
    Usage,
    UsageReset,
}

impl Tool {
    fn name(self) -> &'static str {
        match self {
            Self::Open => "navigate_to_codex_page",
            Self::ReadThread => "read_thread",
            Self::SendMessage => "send_message_to_thread",
            Self::Create => "create_thread",
            Self::Projects => "list_projects",
            Self::Rename => "set_thread_title",
            Self::Fork => "fork_thread",
            Self::Usage => "get_usage_limits",
            Self::UsageReset => "consume_usage_reset",
        }
    }
}

#[derive(Clone, Default)]
pub struct Catalog(Vec<String>);

impl Catalog {
    pub fn has(&self, tool: Tool) -> bool {
        self.0.iter().any(|name| name == tool.name())
    }

    pub fn can_create(&self) -> bool {
        self.has(Tool::Create) && self.has(Tool::Projects)
    }

    pub(crate) fn can_message(&self) -> bool {
        self.has(Tool::ReadThread) && self.has(Tool::SendMessage)
    }
}

#[derive(Clone)]
pub struct AppTools {
    endpoint: Endpoint,
    cached: Arc<Mutex<(Option<Instant>, Catalog)>>,
    refreshing: Arc<tokio::sync::Mutex<()>>,
}

impl AppTools {
    pub fn new(endpoint: Endpoint) -> Self {
        Self {
            endpoint,
            cached: Default::default(),
            refreshing: Default::default(),
        }
    }

    pub fn catalog(&self) -> Catalog {
        self.cached
            .lock()
            .expect("catalog mutex poisoned")
            .1
            .clone()
    }

    pub async fn refresh(&self) -> Catalog {
        let _refresh = self.refreshing.lock().await;
        {
            let cache = self.cached.lock().expect("catalog mutex poisoned");
            if cache
                .0
                .is_some_and(|time| time.elapsed() < Duration::from_secs(10))
            {
                return cache.1.clone();
            }
        }
        let found = timeout(Duration::from_secs(2), async {
            let mut stream = self.endpoint.open_app_tools().await?;
            let value =
                request(&mut stream, "tools/list", json!({"threadStartKind":"all"})).await?;
            Ok::<_, anyhow::Error>(Catalog(
                value["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|tool| tool["namespace"] == "codex_app")
                    .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
                    .collect(),
            ))
        })
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
        *self.cached.lock().expect("catalog mutex poisoned") =
            (Some(Instant::now()), found.clone());
        found
    }

    pub async fn connect(&self, tool: Tool) -> Result<Stream> {
        ensure!(self.refresh().await.has(tool), "桌面未提供此功能");
        timeout(Duration::from_secs(2), self.endpoint.open_app_tools()).await?
    }
}

pub async fn call(
    stream: &mut Stream,
    anchor: &str,
    id: Uuid,
    tool: Tool,
    arguments: Value,
) -> Result<Value> {
    let reply = invoke(stream, anchor, id, tool, arguments).await?;
    ensure!(reply["success"] == true, "桌面未确认操作");
    if matches!(tool, Tool::Open | Tool::Rename) {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(
        tool_text(&reply).context("桌面响应格式无效")?,
    )?)
}

pub(crate) async fn invoke(
    stream: &mut Stream,
    anchor: &str,
    id: Uuid,
    tool: Tool,
    arguments: Value,
) -> Result<Value> {
    let duration = Duration::from_secs(match tool {
        Tool::ReadThread => 4,
        Tool::SendMessage => 20,
        _ => 12,
    });
    timeout(duration, request(stream, "tools/call", json!({
        "arguments":arguments,"callerSource":"codex","callId":format!("pocket-{id}"),"hostId":"local",
        "namespace":"codex_app","threadId":anchor,"tool":tool.name(),"turnId":format!("pocket-control-{id}"),
    }))).await?
}

pub(crate) fn tool_text(reply: &Value) -> Option<&str> {
    reply["contentItems"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| item["type"] == "inputText")
        .and_then(|item| item["text"].as_str())
}

async fn request(stream: &mut Stream, method: &str, params: Value) -> Result<Value> {
    let id = Uuid::new_v4().to_string();
    let body =
        serde_json::to_vec(&json!({"id":id,"jsonrpc":"2.0","method":method,"params":params}))?;
    stream.write_u32_le(body.len() as u32).await?;
    stream.write_all(&body).await?;
    loop {
        let response = read_frame(stream).await?;
        if response["id"] == id {
            ensure!(response.get("error").is_none(), "桌面工具拒绝请求");
            return response.get("result").cloned().context("桌面响应缺少结果");
        }
    }
}
