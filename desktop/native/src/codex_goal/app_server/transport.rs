use anyhow::Result;
use serde_json::Value;
use std::path::Path;

#[cfg(unix)]
use {
    anyhow::{Context, ensure},
    futures::{SinkExt, StreamExt},
    serde_json::json,
    std::{
        fs,
        os::unix::fs::{FileTypeExt, MetadataExt},
    },
    tokio::net::UnixStream,
    tokio_tungstenite::{
        WebSocketStream, client_async_with_config,
        tungstenite::{Message, protocol::WebSocketConfig},
    },
};

pub(super) struct AppServer {
    #[cfg(unix)]
    socket: WebSocketStream<UnixStream>,
    #[cfg(unix)]
    request_id: u64,
}

#[cfg(unix)]
impl AppServer {
    pub(super) async fn connect(home: &Path) -> Result<Self> {
        let directory = home.join("app-server-control");
        let socket = directory.join("app-server-control.sock");
        let directory = fs::symlink_metadata(directory)?;
        let metadata = fs::symlink_metadata(&socket)?;
        let uid = rustix::process::geteuid().as_raw();
        ensure!(
            directory.is_dir()
                && directory.uid() == uid
                && directory.mode() & 0o777 == 0o700
                && metadata.file_type().is_socket()
                && metadata.uid() == uid
                && metadata.mode() & 0o777 == 0o600,
            "Codex App Server Socket 权限无效"
        );
        let stream = UnixStream::connect(socket).await?;
        ensure!(
            stream.peer_cred()?.uid() == uid,
            "Codex App Server 用户不匹配"
        );
        let config = WebSocketConfig::default()
            .max_message_size(Some(512 * 1024))
            .max_frame_size(Some(512 * 1024));
        let (socket, _) = client_async_with_config("ws://localhost/", stream, Some(config)).await?;
        let mut server = Self {
            socket,
            request_id: 0,
        };
        let response = server
            .request(
                "initialize",
                json!({
                    "clientInfo":{"name":"agent_space_goal","version":"1.0.0"},
                    "capabilities":{"experimentalApi":true},
                }),
            )
            .await?;
        let connected = response["result"]["codexHome"]
            .as_str()
            .context("Codex App Server 未确认会话目录")?;
        ensure!(
            response["error"].is_null()
                && Path::new(connected).canonicalize()? == home.canonicalize()?,
            "Codex App Server 会话目录不匹配"
        );
        server.send(json!({"method":"initialized"})).await?;
        Ok(server)
    }

    pub(super) async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.request_id += 1;
        let id = self.request_id;
        self.send(json!({"id":id,"method":method,"params":params}))
            .await?;
        while let Some(frame) = self.socket.next().await {
            if let Message::Text(text) = frame? {
                let reply: Value = serde_json::from_str(&text)?;
                if reply["id"] == id && reply.get("method").is_none() {
                    return Ok(reply);
                }
            }
        }
        anyhow::bail!("Codex App Server 已断开")
    }

    async fn send(&mut self, packet: Value) -> Result<()> {
        self.socket
            .send(Message::Text(packet.to_string().into()))
            .await?;
        Ok(())
    }
}

#[cfg(not(unix))]
impl AppServer {
    pub(super) async fn connect(_home: &Path) -> Result<Self> {
        anyhow::bail!("此平台未提供共享 Codex App Server Socket")
    }

    pub(super) async fn request(&mut self, _method: &str, _params: Value) -> Result<Value> {
        anyhow::bail!("此平台未提供共享 Codex App Server Socket")
    }
}
