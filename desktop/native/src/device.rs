use crate::{
    appearance,
    codex_backend::{Backend, Group, ID as CODEX, Live, LiveTransport, VoiceSession},
    codex_live::Action,
    codex_service::voice_sdp,
    conversations,
    files::{Attachment, Download, Scope, VerifiedUpload},
    gateway::{Database, Packet, reply, reply_packet},
    history_media,
    plugins::{
        Adapter, Control, CreationSettings, Delivery, Media, ModelSettings, Subscription, Write,
    },
    queue, requests, settings,
    state::Device,
    usage::{ResetError, ResetProofVerifier},
};
use anyhow::{Context, Result, ensure};
use futures::AsyncWrite;
use libp2p_identity::PeerId;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    sync::mpsc,
    task::JoinSet,
    time::{Instant, interval, timeout},
};
use uuid::Uuid;


mod files;
mod plugin_request;
mod rpc;
#[cfg(test)]
mod maintenance_tests;
mod watch;
use plugin_request::*;
#[derive(Clone)]
pub struct Backends {
    pub codex: Group,
    pub direct: Option<crate::direct::Direct>,
    pub storage: Option<crate::storage::Storage>,
    pub update_gate: crate::update::UpdateGate,
    pub plugins: crate::plugins::Registry,
    pub plugin_manager: Option<crate::plugin_management::PluginManager>,
    pub terminal: Option<Arc<crate::terminal::TerminalService>>,
    pub(crate) usage_reset: ResetProofVerifier,
    pub(crate) account_security: Option<crate::offline_security_rpc::Service>,
}

pub struct DeviceSession {
    db: Database,
    peer: PeerId,
    device: Device,
    backends: Backends,
    watches: HashMap<(String, Uuid), Watch>,
    plugin_watches: HashMap<(String, String), PluginWatch>,
    terminal_tasks: HashMap<String, tokio::task::JoinHandle<()>>,
    terminal_tx: mpsc::UnboundedSender<(Value, Vec<u8>)>,
    terminal_rx: Option<mpsc::UnboundedReceiver<(Value, Vec<u8>)>>,
    last_status: HashMap<String, Value>,
    bulk: bool,
    signaling: Option<Uuid>,
    connection: Option<Arc<dyn webrtc::peer_connection::PeerConnection>>,
    voice: Option<DeviceVoice>,
    activity: Option<Arc<crate::update::Client>>,
    uploads: HashMap<Uuid, (Arc<crate::update::Client>, Instant)>,
}

const VOICE_LEASE: Duration = Duration::from_secs(60);

struct DeviceVoice {
    backend: String,
    session: VoiceSession,
    deadline: Instant,
    _activity: Option<Arc<crate::update::Client>>,
}

#[derive(Debug)]
struct VoiceError(&'static str);

impl std::fmt::Display for VoiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for VoiceError {}

struct Watch {
    live: Option<Live>,
    summary: Value,
    fallback: Option<Value>,
    // Let an already sent request finish on the shared plugin connection when a watch closes.
    history: Option<tokio::task::JoinHandle<Option<Value>>>,
    fallback_epoch: Uuid,
    fallback_after: Instant,
    published: Option<(Uuid, u64, Option<String>)>,
    versions: HashMap<String, [u8; 32]>,
    operations: HashMap<String, Value>,
}

struct PluginWatch {
    live: Arc<Subscription>,
    epoch: Uuid,
    revision: Option<u64>,
    versions: HashMap<String, [u8; 32]>,
    operations: HashMap<String, Value>,
}

// Accepted storage jobs outlive a closed read connection, holding their update lease
// until network receipt and local writes have settled.
struct StorageJobs<T: 'static>(JoinSet<T>);
impl<T: 'static> std::ops::Deref for StorageJobs<T> {
    type Target = JoinSet<T>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl<T: 'static> std::ops::DerefMut for StorageJobs<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl<T: 'static> Drop for StorageJobs<T> {
    fn drop(&mut self) {
        self.0.detach_all();
    }
}

fn rpc_activity(method: &str) -> bool {
    !(method.ends_with(".read")
        || method.ends_with(".list")
        || method == "security.backup.status"
        || method == "plugins.manage.read")
}
fn needs_activity(request: &Value) -> bool {
    match request["type"].as_str() {
        Some("rpc") => rpc_activity(request["call"]["method"].as_str().unwrap_or_default()),
        Some("file") => request["action"] != "read",
        Some("voice-start" | "terminal-attach") => true,
        _ => false,
    }
}

impl DeviceSession {
    pub fn new(
        db: Database,
        peer: PeerId,
        device: Device,
        backends: Backends,
        bulk: bool,
        signaling: Option<Uuid>,
    ) -> Self {
        let (terminal_tx, terminal_rx) = mpsc::unbounded_channel();
        Self {
            db,
            peer,
            device,
            last_status: HashMap::from([(CODEX.into(), backends.codex.main().status(None))]),
            backends,
            watches: HashMap::new(),
            plugin_watches: HashMap::new(),
            terminal_tasks: HashMap::new(),
            terminal_tx,
            terminal_rx: Some(terminal_rx),
            bulk,
            signaling,
            connection: None,
            voice: None,
            activity: None,
            uploads: HashMap::new(),
        }
    }

    pub async fn run(
        mut self,
        mut requests: mpsc::Receiver<Packet>,
        io: &mut (impl AsyncWrite + Unpin),
    ) -> Result<()> {
        let mut updates = interval(Duration::from_millis(160));
        let mut storage_jobs = StorageJobs(JoinSet::new());
        let mut upload_expiry = interval(Duration::from_secs(1));
        let mut desktop_probe = interval(Duration::from_secs(10));
        let mut probing = JoinSet::new();
        let mut terminal_rx = self
            .terminal_rx
            .take()
            .expect("terminal receiver available once");
        loop {
            tokio::select! {
                Some((event, payload)) = terminal_rx.recv(), if !self.bulk => {
                    self.ensure_device()?;
                    reply_packet(io, event, &payload).await?;
                }
                _ = upload_expiry.tick(), if !self.uploads.is_empty() => {
                    let store = self.db.lock().expect("database mutex poisoned");
                    self.uploads.retain(|id, (_, deadline)| {
                        *deadline > Instant::now() && match store.db.query_row("SELECT complete=0 FROM native_uploads WHERE id=?1", [id.to_string()], |row| row.get::<_, bool>(0)) { Ok(incomplete) => incomplete, Err(rusqlite::Error::QueryReturnedNoRows) => false, Err(_) => true }
                    });
                }
                Some(result) = storage_jobs.join_next(), if !storage_jobs.is_empty() => {
                    if let Ok((id, result)) = result {
                        self.ensure_device()?;
                        let response = match result {
                            Ok(value) => json!({"type":"response","id":id,"result":value}),
                            Err(_) => json!({"type":"response","id":id,"status":503,"error":"对象存储操作未完成"}),
                        };
                        reply(io, response).await?;
                    }
                }
                _ = desktop_probe.tick(), if !self.bulk && probing.is_empty() && self.backends.codex.configured() => {
                    let backend = self.backends.codex.clone();
                    probing.spawn(async move { backend.refresh().await; });
                }
                Some(_) = probing.join_next(), if !probing.is_empty() => {
                    self.ensure_device()?;
                    self.publish(io).await?;
                }
                _ = updates.tick(), if !self.bulk && !(self.watches.is_empty() && self.plugin_watches.is_empty()) => {
                    self.ensure_device()?;
                    self.publish(io).await?;
                    self.publish_plugins(io).await?;
                }
                event = async {
                    let voice = self.voice.as_mut().expect("voice session");
                    tokio::select! {
                        value = voice.session.next() => value.unwrap_or_else(|| json!({"type":"closed"})),
                        _ = tokio::time::sleep_until(voice.deadline) => json!({"type":"closed"}),
                    }
                }, if self.voice.is_some() => {
                    self.ensure_device()?;
                    let voice = self.voice.as_ref().expect("voice session");
                    reply(io, json!({
                        "type":"voice-event","backendId":voice.backend,"threadId":voice.session.thread,
                        "sessionId":voice.session.id,"event":event,
                    })).await?;
                    if matches!(event["type"].as_str(), Some("closed" | "error")) {
                        self.voice = None;
                    }
                }
                request = requests.recv() => {
                    let Some(Packet { value: request, bytes }) = request else { return Ok(()) };
                    self.ensure_device()?;
                    let Some(id) = request["id"].as_str().and_then(|value| Uuid::parse_str(value).ok()) else { continue };
                    self.activity = None;
                    if needs_activity(&request) {
                        let Some(activity) = self.backends.update_gate.admit() else {
                            reply(io, json!({"type":"response","id":id,"status":503,"error":"正在准备更新，请稍后重试"})).await?;
                            continue;
                        };
                        self.activity = Some(Arc::new(activity));
                    }
                    if request["type"] == "file" && bytes.is_empty()
                        && matches!(request["action"].as_str(), Some("storage-plan" | "storage-import" | "storage-done"))
                    {
                        if let Some(storage) = self.backends.storage.clone().filter(|_| storage_jobs.len() < 2) {
                            let db = self.db.clone();
                            let device = self.device.id.clone();
                            let scope = self.file_scope(&request);
                            let activity = self.activity.clone();
                            storage_jobs.spawn(async move {
                                let _activity = activity;
                                let result = async {
                                    let scope = scope?;
                                    let transfer = thread_id(&request["fileId"])?;
                                    let action = request["action"].as_str().unwrap();
                                    storage.handle(db, device, scope, transfer, action, &request).await
                                }.await;
                                (id, result)
                            });
                        } else {
                            reply(io, json!({"type":"response","id":id,"status":503,"error":"对象存储当前不可用"})).await?;
                        }
                        self.activity = None;
                        continue;
                    }
                    let mut reply_bytes = Vec::new();
                    let result = match request["type"].as_str() {
                        Some("rpc") if !self.bulk && request["call"]["method"] == "upload.chunk" =>
                            self.legacy_upload_chunk(&request["call"], bytes).await,
                        Some("rpc") if !self.bulk && request["call"]["method"] == "terminal.session.upload" =>
                            self.terminal_upload(&request["call"], &bytes),
                        Some("rpc") if !self.bulk && request["call"]["method"] == "terminal.session.download" =>
                            self.terminal_download(&request["call"]).map(|(meta, data)| {
                                reply_bytes = data;
                                Some(meta)
                            }),
                        Some("rpc") if !self.bulk && bytes.is_empty() => self.rpc(request["call"].clone()).await,
                        Some("file") => self.file(request.clone(), bytes).await.map(|(value, bytes)| {
                            reply_bytes = bytes;
                            Some(value)
                        }),
                        Some("terminal-attach") if !self.bulk && bytes.is_empty() => {
                            self.terminal_attach(&request).map(|(meta, scrollback)| {
                                reply_bytes = scrollback;
                                Some(meta)
                            })
                        }
                        Some("terminal-detach") if !self.bulk && bytes.is_empty() => {
                            if let Some(session_id) = request["sessionId"].as_str()
                                && let Some(handle) = self.terminal_tasks.remove(session_id)
                            {
                                handle.abort();
                            }
                            Ok(Some(json!({"ok": true})))
                        }
                        Some("terminal-input") if !self.bulk => {
                            self.terminal_input(&request, &bytes).map(|()| Some(json!({"ok": true})))
                        }
                        Some("terminal-resize") if !self.bulk && bytes.is_empty() => {
                            self.terminal_resize(&request).map(|()| Some(json!({"ok": true})))
                        }
                        Some("watch") if !self.bulk && bytes.is_empty() => {
                            if let Some(id) = backend_id(&request).filter(|id| self.backends.codex.get(id).is_some()) {
                                self.watch(id, &request).await.map(Some)
                            } else {
                                self.plugin_watch(&request)
                            }
                        },
                        Some("offer") if bytes.is_empty() && self.signaling.is_some() => self.offer(&request).await.map(Some),
                        Some("candidate") if bytes.is_empty() && self.signaling.is_some() => {
                            match &self.connection {
                                Some(connection) => crate::direct::candidate(connection.as_ref(), request["candidate"].clone()).await.map(|()| Some(json!({"ok":true}))),
                                None => Ok(None),
                            }
                        }
                        Some("unwatch") if !self.bulk && bytes.is_empty() => {
                            if let Some(id) = backend_id(&request).filter(|id| self.backends.codex.get(id).is_some()) {
                                self.watches.remove(&(id.to_owned(), thread_id(&request["threadId"])?));
                            } else if let (Some(backend), Some(thread)) = (request["backendId"].as_str(), request["threadId"].as_str()) {
                                self.plugin_watches.remove(&(backend.to_owned(), thread.to_owned()));
                            }
                            Ok(Some(json!({"ok": true})))
                        }
                        Some("voice-start" | "voice-stop" | "voice-keepalive") if !self.bulk && bytes.is_empty() => {
                            self.voice_request(&request).map(Some)
                        }
                        Some("ping") => Ok(Some(json!({"ok": true}))),
                        _ => Ok(None),
                    };
                    self.track_upload(&request, result.as_ref().ok().and_then(Option::as_ref));
                    let value = match result {
                        Ok(Some(result)) => json!({"type":"response","id":id,"result":result}),
                        Ok(None) => json!({"type":"response","id":id,"status":404,"error":"会话或功能不可用"}),
                        Err(error) if error.is::<Conflict>() => {
                            json!({"type":"response","id":id,"status":409,"error":"请求 ID 已用于其他操作"})
                        }
                        Err(error) if error.is::<appearance::RevisionConflict>() => {
                            json!({"type":"response","id":id,"status":409,"error":error.to_string()})
                        }
                        Err(error) if error.is::<history_media::MissingAttachment>() => {
                            json!({"type":"response","id":id,"status":404,"error":error.to_string()})
                        }
                        Err(error) if error.is::<history_media::HistoryUnavailable>() => {
                            json!({"type":"response","id":id,"status":404,"error":error.to_string()})
                        }
                        Err(error) if error.is::<VoiceError>() => {
                            json!({"type":"response","id":id,"status":409,"error":error.to_string()})
                        }
                        Err(ref error) if let Some(failure) = error.downcast_ref::<ResetError>() => {
                            json!({"type":"response","id":id,"status":failure.status(),"error":failure.to_string()})
                        }
                        Err(error) if error.is::<crate::offline_security_rpc::LocalProtection>() => {
                            json!({"type":"response","id":id,"status":409,"error":error.to_string()})
                        }
                        Err(_) => json!({"type":"response","id":id,"status":400,"error":"请求未完成，请核对本机会话和参数"}),
                    };
                    reply_packet(io, value, &reply_bytes).await?;
                    self.activity = None;
                    if !self.bulk && request["call"]["method"] == "device.revoke" {
                        // Let the encrypted response reach the requesting client.
                        tokio::time::sleep(Duration::from_millis(35)).await;
                        return Ok(());
                    }
                }
            }
        }
    }


    fn voice_request(&mut self, request: &Value) -> Result<Value> {
        let backend = backend_id(request).context("Codex 实例无效")?;
        let thread = thread_id(&request["threadId"])?;
        let id = thread_id(&request["sessionId"])?;
        let matches = self.voice.as_ref().is_some_and(|voice| {
            voice.backend == backend && voice.session.thread == thread && voice.session.id == id
        });
        match request["type"].as_str() {
            Some("voice-start") => {
                ensure!(
                    request["mode"] == "fork",
                    VoiceError("请先确认创建只读语音分支")
                );
                if matches {
                    return Ok(json!({"ok":true}));
                }
                ensure!(
                    self.voice.is_none(),
                    VoiceError("此设备已有 Codex 语音通话")
                );
                let sdp = request["sdp"]
                    .as_str()
                    .filter(|sdp| voice_sdp(sdp))
                    .context(VoiceError("手机未提供有效的语音连接信息"))?;
                let connector = self
                    .backends
                    .codex
                    .get(backend)
                    .context(VoiceError("当前实例未启用 Codex 语音"))?;
                let admission = connector.admit_write()?;
                let session = connector.voice(thread, id, sdp.to_owned(), admission)?;
                self.voice = Some(DeviceVoice {
                    backend: backend.to_owned(),
                    session,
                    deadline: Instant::now() + VOICE_LEASE,
                    _activity: self.activity.clone(),
                });
            }
            Some("voice-keepalive") => {
                ensure!(matches, VoiceError("语音通话已结束"));
                self.voice
                    .as_mut()
                    .expect("matching voice session")
                    .deadline = Instant::now() + VOICE_LEASE;
            }
            Some("voice-stop") if matches => {
                self.voice = None;
            }
            _ => {}
        }
        Ok(json!({"ok":true}))
    }

    async fn offer(&mut self, request: &Value) -> Result<Value> {
        let direct = self.backends.direct.clone().context("直连未启用")?;
        let session = self.signaling.context("此通道不能协商直连")?;
        let sdp = request["sdp"].as_str().context("WebRTC offer 无效")?;
        if let Some(previous) = self.connection.take() {
            let _ = previous.close().await;
        }
        let (connection, answer) = direct
            .answer(
                sdp.to_owned(),
                self.db.clone(),
                self.peer,
                self.device.ticket.clone(),
                session,
                self.backends.clone(),
            )
            .await?;
        self.connection = Some(connection);
        Ok(json!({"sdp":answer}))
    }

    fn ensure_device(&self) -> Result<()> {
        let db = self.db.lock().expect("database mutex poisoned");
        ensure!(!db.relay_revoked, "电脑的服务授权已撤销");
        let current = db.device(self.peer)?;
        ensure!(
            current.is_some_and(|value| value.id == self.device.id),
            "设备已撤销"
        );
        Ok(())
    }

    fn live_transport(&self, backend: &str) -> Option<LiveTransport> {
        self.watches
            .iter()
            .filter(|((id, _), _)| id == backend)
            .filter_map(|(_, watch)| watch.live.as_ref().and_then(Live::view))
            .map(|view| {
                if view.app_tools {
                    LiveTransport::AppTools
                } else {
                    LiveTransport::Follower
                }
            })
            .max()
    }

    fn terminal_attach(&mut self, request: &Value) -> Result<(Value, Vec<u8>)> {
        let terminal = self
            .backends
            .terminal
            .as_ref()
            .context("终端服务不可用")?;
        let session_id = request["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 80)
            .context("终端会话 ID 无效")?;
        if let Some(old) = self.terminal_tasks.remove(session_id) {
            old.abort();
        }
        let (summary, scrollback, mut rx) = terminal.attach(session_id)?;
        let tx = self.terminal_tx.clone();
        let sid = session_id.to_owned();
        let handle = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(crate::terminal::TerminalEvent::Output(chunk)) => {
                        if tx
                            .send((
                                json!({"type": "terminal-output", "sessionId": sid}),
                                chunk,
                            ))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(crate::terminal::TerminalEvent::Exit(code)) => {
                        let _ = tx.send((
                            json!({"type": "terminal-exit", "sessionId": sid, "exitCode": code}),
                            Vec::new(),
                        ));
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        self.terminal_tasks.insert(session_id.to_owned(), handle);
        Ok((json!({"session": summary}), scrollback))
    }

    fn terminal_input(&self, request: &Value, bytes: &[u8]) -> Result<()> {
        let terminal = self
            .backends
            .terminal
            .as_ref()
            .context("终端服务不可用")?;
        let session_id = request["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 80)
            .context("终端会话 ID 无效")?;
        if !bytes.is_empty() {
            terminal.write_input(session_id, bytes)
        } else if let Some(text) = request["data"].as_str() {
            terminal.write_input(session_id, text.as_bytes())
        } else {
            Ok(())
        }
    }

    fn terminal_resize(&self, request: &Value) -> Result<()> {
        let terminal = self
            .backends
            .terminal
            .as_ref()
            .context("终端服务不可用")?;
        let session_id = request["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 80)
            .context("终端会话 ID 无效")?;
        let cols = request["cols"].as_u64().unwrap_or(100) as u16;
        let rows = request["rows"].as_u64().unwrap_or(30) as u16;
        terminal.resize(session_id, cols, rows)
    }

    fn terminal_upload(&self, call: &Value, bytes: &[u8]) -> Result<Option<Value>> {
        let terminal = self
            .backends
            .terminal
            .as_ref()
            .context("终端服务不可用")?;
        let session_id = call["params"]["id"]
            .as_str()
            .context("终端会话 ID 无效")?;
        let name = call["body"]["name"]
            .as_str()
            .context("上传文件名无效")?;
        let directory = call["body"]["directory"].as_str();
        let result = terminal.upload_file(session_id, name, bytes, directory)?;
        Ok(Some(result))
    }

    fn terminal_download(&self, call: &Value) -> Result<(Value, Vec<u8>)> {
        let terminal = self
            .backends
            .terminal
            .as_ref()
            .context("终端服务不可用")?;
        let session_id = call["params"]["id"]
            .as_str()
            .context("终端会话 ID 无效")?;
        let path = call["body"]["path"]
            .as_str()
            .context("下载路径无效")?;
        let (name, bytes) = terminal.download_file(session_id, path)?;
        Ok((json!({"name": name, "size": bytes.len()}), bytes))
    }
}

impl Drop for DeviceSession {
    fn drop(&mut self) {
        for (_, handle) in self.terminal_tasks.drain() {
            handle.abort();
        }
    }
}
