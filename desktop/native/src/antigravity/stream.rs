use super::{Backend, Daemon, ResponseTooLarge, SERVICE};
use anyhow::{Result, ensure};
use futures::StreamExt;
use serde_json::{Value, json};
use std::{ops::Range, time::Duration};
use uuid::Uuid;

/// Read just the first, complete update for a fresh native subscriber.
pub(super) async fn first_update(
    backend: &Backend,
    daemon: &Daemon,
    thread: &str,
    steps: Range<usize>,
    byte_limit: usize,
    timeout: Duration,
) -> Result<Value> {
    let empty = json!({"startIndex":0,"endIndexExclusive":0});
    let executors = if steps.end > steps.start {
        json!({"startIndex":0,"endIndexExclusive":1000})
    } else {
        empty.clone()
    };
    let payload = serde_json::to_vec(&json!({
        "conversationId":thread,"subscriberId":Uuid::new_v4(),
        "initialStepsPageBounds":{"startIndex":steps.start,"endIndexExclusive":steps.end},
        "initialGeneratorMetadatasPageBounds":empty,
        "initialExecutorMetadatasPageBounds":executors,
    }))?;
    let mut request = vec![0];
    request.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    request.extend_from_slice(&payload);
    let response = backend
        .client
        .post(format!(
            "http://127.0.0.1:{}/{SERVICE}/StreamAgentStateUpdates",
            daemon.http_port
        ))
        .header("Content-Type", "application/connect+json")
        .header("Connect-Protocol-Version", "1")
        .header("x-codeium-csrf-token", &daemon.csrf_token)
        .timeout(timeout)
        .body(request)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Antigravity 会话状态连接失败"))?;
    ensure!(response.status().is_success(), "Antigravity 会话状态不可用");

    let mut bytes = response.bytes_stream();
    let mut header = Vec::with_capacity(5);
    let mut body = Vec::new();
    while let Some(chunk) = bytes.next().await {
        let chunk = chunk.map_err(|_| anyhow::anyhow!("Antigravity 会话状态读取失败"))?;
        let mut remaining = chunk.as_ref();
        if header.len() < 5 {
            let count = (5 - header.len()).min(remaining.len());
            header.extend_from_slice(&remaining[..count]);
            remaining = &remaining[count..];
            if header.len() < 5 {
                continue;
            }
        }
        ensure!(header[0] == 0, "Antigravity 会话状态格式不兼容");
        let length = u32::from_be_bytes(header[1..5].try_into()?) as usize;
        ensure!(length <= byte_limit, ResponseTooLarge);
        body.extend_from_slice(&remaining[..(length - body.len()).min(remaining.len())]);
        if body.len() == length {
            return Ok(serde_json::from_slice(&body)?);
        }
    }
    anyhow::bail!("Antigravity 会话状态不可用")
}
