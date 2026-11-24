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

pub(crate) struct AppServer {
    #[cfg(unix)]
    socket: WebSocketStream<UnixStream>,
    #[cfg(unix)]
    request_id: u64,
}

#[cfg(unix)]
fn resolve_socket_path(home: &Path) -> Result<std::path::PathBuf> {
    let dir_path = home.join("app-server-control");
    let link_path = dir_path.join("app-server-control.sock");
    let dir_meta = fs::symlink_metadata(&dir_path)?;
    let link_meta = fs::symlink_metadata(&link_path)?;
    let uid = rustix::process::geteuid().as_raw();
    ensure!(
        dir_meta.is_dir() && dir_meta.uid() == uid && dir_meta.mode() & 0o777 == 0o700,
        "Codex App Server Socket 目录权限无效"
    );
    if link_meta.file_type().is_symlink() {
        ensure!(
            link_meta.uid() == uid,
            "Codex App Server Socket 链接所有者无效"
        );
        let raw_target = fs::read_link(&link_path)?;
        let target = if raw_target.is_absolute() {
            raw_target
        } else {
            dir_path.join(raw_target)
        };
        let parent = target
            .parent()
            .context("Codex App Server Socket 目标目录无效")?;
        let parent_meta = fs::symlink_metadata(parent)?;
        let target_meta = fs::symlink_metadata(&target)?;
        ensure!(
            parent_meta.is_dir()
                && parent_meta.uid() == uid
                && parent_meta.mode() & 0o777 == 0o700
                && target_meta.file_type().is_socket()
                && target_meta.uid() == uid
                && target_meta.mode() & 0o777 == 0o600,
            "Codex App Server Socket 目标权限无效"
        );
        Ok(target)
    } else {
        ensure!(
            link_meta.file_type().is_socket()
                && link_meta.uid() == uid
                && link_meta.mode() & 0o777 == 0o600,
            "Codex App Server Socket 权限无效"
        );
        Ok(link_path)
    }
}

#[cfg(unix)]
impl AppServer {
    pub(crate) async fn connect(home: &Path) -> Result<Self> {
        let uid = rustix::process::geteuid().as_raw();
        let socket = resolve_socket_path(home)?;
        let stream = UnixStream::connect(&socket).await?;
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

    pub(crate) async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
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
    pub(crate) async fn connect(_home: &Path) -> Result<Self> {
        anyhow::bail!("此平台未提供共享 Codex App Server Socket")
    }

    pub(crate) async fn request(&mut self, _method: &str, _params: Value) -> Result<Value> {
        anyhow::bail!("此平台未提供共享 Codex App Server Socket")
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::resolve_socket_path;
    use std::{
        fs,
        os::unix::{fs as unix_fs, fs::PermissionsExt, net::UnixListener},
    };

    #[test]
    fn accepts_direct_and_secure_symlinked_control_sockets() {
        let dir = tempfile::Builder::new()
            .prefix("c-")
            .tempdir_in("/tmp")
            .unwrap();
        let home = dir.path().join("h");
        let control = home.join("app-server-control");
        fs::create_dir_all(&control).unwrap();
        fs::set_permissions(&control, fs::Permissions::from_mode(0o700)).unwrap();

        let direct = control.join("app-server-control.sock");
        let _listener = UnixListener::bind(&direct).unwrap();
        fs::set_permissions(&direct, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(resolve_socket_path(&home).unwrap(), direct);
        drop(_listener);
        fs::remove_file(&direct).unwrap();

        let target_dir = dir.path().join("daemon");
        fs::create_dir_all(&target_dir).unwrap();
        fs::set_permissions(&target_dir, fs::Permissions::from_mode(0o700)).unwrap();
        let target_sock = target_dir.join("daemon.sock");
        let _listener = UnixListener::bind(&target_sock).unwrap();
        fs::set_permissions(&target_sock, fs::Permissions::from_mode(0o600)).unwrap();
        unix_fs::symlink(&target_sock, &direct).unwrap();
        assert_eq!(resolve_socket_path(&home).unwrap(), target_sock);

        fs::set_permissions(&target_dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(resolve_socket_path(&home).is_err());
    }
}
