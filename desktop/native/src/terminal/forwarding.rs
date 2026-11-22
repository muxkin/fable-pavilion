use anyhow::{Context, Result, ensure};
use rand::RngCore;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};
use uuid::Uuid;

const MAX_FORWARDS: usize = 32;
const MAX_HTTP_PREVIEW_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCapabilities {
    pub pty_backend: &'static str,
    pub x11_host_display: Option<String>,
    pub wayland_host_display: Option<String>,
    pub has_xvfb: bool,
    pub has_xpra: bool,
    pub has_waypipe: bool,
    pub has_wsl: bool,
}

pub fn probe_capabilities() -> HostCapabilities {
    HostCapabilities {
        pty_backend: if cfg!(windows) { "conpty" } else { "posix-pty" },
        x11_host_display: env::var("DISPLAY").ok().filter(|v| !v.is_empty()),
        wayland_host_display: env::var("WAYLAND_DISPLAY").ok().filter(|v| !v.is_empty()),
        has_xvfb: find_on_path("Xvfb").is_some(),
        has_xpra: find_on_path("xpra").is_some(),
        has_waypipe: find_on_path("waypipe").is_some(),
        has_wsl: cfg!(windows) && find_on_path("wsl.exe").is_some(),
    }
}

pub(super) fn find_on_path(binary: &str) -> Option<PathBuf> {
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            let candidate = dir.join(binary);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    #[cfg(windows)]
    if let Some(sys_root) = env::var_os("SystemRoot").or_else(|| env::var_os("WINDIR")) {
        let candidate = PathBuf::from(sys_root).join("System32").join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardSummary {
    pub id: String,
    pub kind: String,
    pub session_id: Option<String>,
    pub target_host: String,
    pub target_port: u16,
    pub display: Option<String>,
    pub active_connections: usize,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub created_at: i64,
}

struct ForwardCounters {
    active: AtomicUsize,
    bytes_in: AtomicU64,
    bytes_out: AtomicU64,
}

impl ForwardCounters {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            active: AtomicUsize::new(0),
            bytes_in: AtomicU64::new(0),
            bytes_out: AtomicU64::new(0),
        })
    }
}

struct ForwardEntry {
    id: String,
    kind: String,
    session_id: Option<String>,
    target_host: String,
    target_port: u16,
    display: Option<String>,
    created_at: i64,
    counters: Arc<ForwardCounters>,
    shutdown: Option<oneshot::Sender<()>>,
    cleanup_dir: Option<PathBuf>,
}

impl ForwardEntry {
    fn summary(&self) -> ForwardSummary {
        ForwardSummary {
            id: self.id.clone(),
            kind: self.kind.clone(),
            session_id: self.session_id.clone(),
            target_host: self.target_host.clone(),
            target_port: self.target_port,
            display: self.display.clone(),
            active_connections: self.counters.active.load(Ordering::Relaxed),
            bytes_in: self.counters.bytes_in.load(Ordering::Relaxed),
            bytes_out: self.counters.bytes_out.load(Ordering::Relaxed),
            created_at: self.created_at,
        }
    }
}

impl Drop for ForwardEntry {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(dir) = self.cleanup_dir.take() {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

#[derive(Default)]
pub struct ForwardManager {
    entries: Mutex<HashMap<String, ForwardEntry>>,
}

pub(super) struct SessionForwardSetup {
    pub env_vars: Vec<(String, String)>,
    pub x11_display: Option<String>,
    pub wayland_display: Option<String>,
    pub forward_ids: Vec<String>,
}

impl ForwardManager {
    pub fn list(&self) -> Vec<ForwardSummary> {
        let entries = self.entries.lock().expect("forwards mutex");
        let mut list: Vec<_> = entries.values().map(ForwardEntry::summary).collect();
        list.sort_by_key(|item| item.created_at);
        list
    }

    pub fn create_tcp_forward(&self, target_host: &str, target_port: u16) -> Result<ForwardSummary> {
        let host = normalize_loopback_host(target_host)?;
        ensure!(target_port > 0, "端口无效");
        let mut entries = self.entries.lock().expect("forwards mutex");
        ensure!(entries.len() < MAX_FORWARDS, "已达到最大端口转发数量");
        if let Some(existing) = entries
            .values()
            .find(|item| item.kind == "tcp" && item.target_host == host && item.target_port == target_port)
        {
            return Ok(existing.summary());
        }
        let id = Uuid::new_v4().to_string();
        let entry = ForwardEntry {
            id: id.clone(),
            kind: "tcp".into(),
            session_id: None,
            target_host: host,
            target_port,
            display: None,
            created_at: crate::state::now(),
            counters: ForwardCounters::new(),
            shutdown: None,
            cleanup_dir: None,
        };
        let summary = entry.summary();
        entries.insert(id, entry);
        Ok(summary)
    }

    pub fn close(&self, id: &str) -> bool {
        self.entries
            .lock()
            .expect("forwards mutex")
            .remove(id)
            .is_some()
    }

    pub fn close_for_session(&self, session_id: &str) {
        self.entries
            .lock()
            .expect("forwards mutex")
            .retain(|_, entry| entry.session_id.as_deref() != Some(session_id));
    }

    pub fn close_all(&self) {
        self.entries.lock().expect("forwards mutex").clear();
    }

    pub async fn http_proxy(
        &self,
        id: &str,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<Value> {
        let (host, port, counters) = {
            let entries = self.entries.lock().expect("forwards mutex");
            let entry = entries.get(id).context("端口转发不存在")?;
            ensure!(entry.kind == "tcp", "仅支持对 TCP 端口转发执行 HTTP 预览请求");
            (entry.target_host.clone(), entry.target_port, entry.counters.clone())
        };
        ensure!(
            matches!(method, "GET" | "HEAD" | "POST"),
            "HTTP 方法不受支持"
        );
        ensure!(
            path.starts_with('/') && !path.contains('\r') && !path.contains('\n') && path.len() <= 2048,
            "HTTP 路径无效"
        );
        let url = format!("http://{host}:{port}{path}");
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::limited(4))
            .timeout(Duration::from_secs(10))
            .build()?;
        counters.active.fetch_add(1, Ordering::Relaxed);
        let result = async {
            let req = match method {
                "HEAD" => client.head(&url),
                "POST" => {
                    let payload = body.unwrap_or_default().to_owned();
                    counters
                        .bytes_in
                        .fetch_add(payload.len() as u64, Ordering::Relaxed);
                    client.post(&url).body(payload)
                }
                _ => client.get(&url),
            };
            let response = req.send().await.context("无法连接目标本机服务")?;
            let status = response.status().as_u16();
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_owned();
            let bytes = response.bytes().await?;
            let truncated = bytes.len() > MAX_HTTP_PREVIEW_BYTES;
            let slice = &bytes[..bytes.len().min(MAX_HTTP_PREVIEW_BYTES)];
            counters
                .bytes_out
                .fetch_add(slice.len() as u64, Ordering::Relaxed);
            let is_text = content_type.starts_with("text/")
                || content_type.contains("json")
                || content_type.contains("xml")
                || content_type.contains("javascript")
                || content_type.contains("svg");
            let text = if is_text {
                Some(String::from_utf8_lossy(slice).into_owned())
            } else {
                None
            };
            Ok::<Value, anyhow::Error>(json!({
                "status": status,
                "contentType": content_type,
                "bytes": slice.len(),
                "truncated": truncated,
                "body": text,
            }))
        }
        .await;
        counters.active.fetch_sub(1, Ordering::Relaxed);
        result
    }

    pub(super) async fn setup_session_forwards(
        &self,
        session_id: &str,
        enable_x11: bool,
        enable_wayland: bool,
        runtime_root: &Path,
    ) -> Result<SessionForwardSetup> {
        let mut setup = SessionForwardSetup {
            env_vars: Vec::new(),
            x11_display: None,
            wayland_display: None,
            forward_ids: Vec::new(),
        };

        if enable_x11 {
            if let Ok((id, display, xauth)) = self
                .start_x11_forward(session_id, runtime_root)
                .await
            {
                setup.env_vars.push(("DISPLAY".into(), display.clone()));
                if let Some(xauth) = xauth {
                    setup.env_vars.push(("XAUTHORITY".into(), xauth));
                }
                setup.x11_display = Some(display);
                setup.forward_ids.push(id);
            }
        }

        if enable_wayland {
            #[cfg(unix)]
            if let Ok((id, wayland_display, runtime_dir)) = self
                .start_wayland_forward(session_id, runtime_root)
                .await
            {
                setup
                    .env_vars
                    .push(("WAYLAND_DISPLAY".into(), wayland_display.clone()));
                if let Some(dir) = runtime_dir {
                    setup.env_vars.push(("XDG_RUNTIME_DIR".into(), dir));
                }
                setup.wayland_display = Some(wayland_display);
                setup.forward_ids.push(id);
            }
            #[cfg(windows)]
            {
                let _ = runtime_root;
            }
        }

        Ok(setup)
    }

    async fn start_x11_forward(
        &self,
        session_id: &str,
        runtime_root: &Path,
    ) -> Result<(String, String, Option<String>)> {
        let mut bound = None;
        for display_num in 10u16..=60u16 {
            let port = 6000 + display_num;
            if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
                bound = Some((display_num, port, listener));
                break;
            }
        }
        let (display_num, port, listener) = bound.context("无法分配本地 X11 转发端口")?;
        let display = format!("127.0.0.1:{display_num}.0");
        let dir = runtime_root.join(format!("x11-{session_id}"));
        crate::state::private_directory(&dir)?;

        let mut cookie = [0u8; 16];
        rand::rng().fill_bytes(&mut cookie);
        let xauth_path = dir.join("Xauthority");
        let xauth_bytes = build_xauthority(&display_num.to_string(), &cookie);
        let mut xauth_file = crate::state::private_file(&xauth_path, true)?;
        std::io::Write::write_all(&mut xauth_file, &xauth_bytes)?;

        let host_display = env::var("DISPLAY").ok().filter(|v| !v.is_empty());
        let counters = ForwardCounters::new();
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
        let bridge_counters = counters.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((mut incoming, _)) = accepted else { break };
                        let counters = bridge_counters.clone();
                        let upstream = host_display.clone();
                        tokio::spawn(async move {
                            counters.active.fetch_add(1, Ordering::Relaxed);
                            if let Some(target) = upstream.as_deref() {
                                let _ = bridge_x11_connection(&mut incoming, target, &counters).await;
                            }
                            counters.active.fetch_sub(1, Ordering::Relaxed);
                        });
                    }
                }
            }
        });

        let id = Uuid::new_v4().to_string();
        let entry = ForwardEntry {
            id: id.clone(),
            kind: "x11".into(),
            session_id: Some(session_id.to_owned()),
            target_host: "127.0.0.1".into(),
            target_port: port,
            display: Some(display.clone()),
            created_at: crate::state::now(),
            counters,
            shutdown: Some(shutdown_tx),
            cleanup_dir: Some(dir),
        };
        self.entries
            .lock()
            .expect("forwards mutex")
            .insert(id.clone(), entry);
        Ok((id, display, Some(xauth_path.to_string_lossy().into_owned())))
    }

    #[cfg(unix)]
    async fn start_wayland_forward(
        &self,
        session_id: &str,
        runtime_root: &Path,
    ) -> Result<(String, String, Option<String>)> {
        use tokio::net::{UnixListener, UnixStream};

        let dir = runtime_root.join(format!("wayland-{session_id}"));
        crate::state::private_directory(&dir)?;
        let short = &session_id[..session_id.len().min(8)];
        let socket_name = format!("wayland-fp-{short}");
        let socket_path = dir.join(&socket_name);
        let _ = fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).context("无法创建 Wayland 转发套接字")?;

        let upstream = env::var("WAYLAND_DISPLAY")
            .ok()
            .filter(|v| !v.is_empty())
            .and_then(|display| {
                let candidate = PathBuf::from(&display);
                if candidate.is_absolute() {
                    Some(candidate)
                } else {
                    env::var_os("XDG_RUNTIME_DIR").map(|base| PathBuf::from(base).join(display))
                }
            })
            .filter(|path| path.exists());

        let counters = ForwardCounters::new();
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
        let bridge_counters = counters.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((mut incoming, _)) = accepted else { break };
                        let counters = bridge_counters.clone();
                        let upstream = upstream.clone();
                        tokio::spawn(async move {
                            counters.active.fetch_add(1, Ordering::Relaxed);
                            if let Some(target) = upstream
                                && let Ok(mut target_stream) = UnixStream::connect(&target).await
                            {
                                let _ = copy_bidirectional_counted(&mut incoming, &mut target_stream, &counters).await;
                            }
                            counters.active.fetch_sub(1, Ordering::Relaxed);
                        });
                    }
                }
            }
        });

        let id = Uuid::new_v4().to_string();
        let entry = ForwardEntry {
            id: id.clone(),
            kind: "wayland".into(),
            session_id: Some(session_id.to_owned()),
            target_host: "unix".into(),
            target_port: 0,
            display: Some(socket_name.clone()),
            created_at: crate::state::now(),
            counters,
            shutdown: Some(shutdown_tx),
            cleanup_dir: Some(dir.clone()),
        };
        self.entries
            .lock()
            .expect("forwards mutex")
            .insert(id.clone(), entry);
        Ok((id, socket_name, Some(dir.to_string_lossy().into_owned())))
    }
}

fn normalize_loopback_host(host: &str) -> Result<String> {
    let trimmed = host.trim();
    match trimmed {
        "" | "127.0.0.1" | "localhost" => Ok("127.0.0.1".into()),
        "::1" | "[::1]" => Ok("[::1]".into()),
        _ => anyhow::bail!("安全限制：端口转发目标仅允许本机回环地址（127.0.0.1 / localhost / ::1）"),
    }
}

fn build_xauthority(display_num: &str, cookie: &[u8; 16]) -> Vec<u8> {
    let mut out = Vec::new();
    let push_entry = |out: &mut Vec<u8>, family: u16, addr: &[u8]| {
        out.extend_from_slice(&family.to_be_bytes());
        out.extend_from_slice(&(addr.len() as u16).to_be_bytes());
        out.extend_from_slice(addr);
        let num = display_num.as_bytes();
        out.extend_from_slice(&(num.len() as u16).to_be_bytes());
        out.extend_from_slice(num);
        let name = b"MIT-MAGIC-COOKIE-1";
        out.extend_from_slice(&(name.len() as u16).to_be_bytes());
        out.extend_from_slice(name);
        out.extend_from_slice(&(cookie.len() as u16).to_be_bytes());
        out.extend_from_slice(cookie);
    };
    // FamilyInternet (0) for 127.0.0.1
    push_entry(&mut out, 0, &[127, 0, 0, 1]);
    // FamilyWild (65535) for local matching
    push_entry(&mut out, 65535, &[]);
    out
}

async fn bridge_x11_connection(
    incoming: &mut TcpStream,
    host_display: &str,
    counters: &ForwardCounters,
) -> Result<()> {
    let display = host_display.trim();
    #[cfg(unix)]
    if let Some(rest) = display.strip_prefix(':') {
        let num = rest.split('.').next().unwrap_or("0");
        let path = format!("/tmp/.X11-unix/X{num}");
        if let Ok(mut target) = tokio::net::UnixStream::connect(&path).await {
            copy_bidirectional_counted(incoming, &mut target, counters).await?;
            return Ok(());
        }
    }
    if let Some((host, rest)) = display.split_once(':') {
        let host = if host.is_empty() { "127.0.0.1" } else { host };
        let num: u16 = rest.split('.').next().unwrap_or("0").parse().unwrap_or(0);
        if matches!(host, "127.0.0.1" | "localhost")
            && let Ok(mut target) = TcpStream::connect((host, 6000 + num)).await
        {
            copy_bidirectional_counted(incoming, &mut target, counters).await?;
        }
    }
    Ok(())
}

async fn copy_bidirectional_counted<A, B>(
    a: &mut A,
    b: &mut B,
    counters: &ForwardCounters,
) -> Result<()>
where
    A: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    B: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut ar, mut aw) = tokio::io::split(a);
    let (mut br, mut bw) = tokio::io::split(b);
    let a_to_b = async {
        let mut buf = [0u8; 8192];
        loop {
            let n = ar.read(&mut buf).await?;
            if n == 0 {
                let _ = bw.shutdown().await;
                break;
            }
            bw.write_all(&buf[..n]).await?;
            counters.bytes_in.fetch_add(n as u64, Ordering::Relaxed);
        }
        Ok::<(), anyhow::Error>(())
    };
    let b_to_a = async {
        let mut buf = [0u8; 8192];
        loop {
            let n = br.read(&mut buf).await?;
            if n == 0 {
                let _ = aw.shutdown().await;
                break;
            }
            aw.write_all(&buf[..n]).await?;
            counters.bytes_out.fetch_add(n as u64, Ordering::Relaxed);
        }
        Ok::<(), anyhow::Error>(())
    };
    let _ = tokio::try_join!(a_to_b, b_to_a);
    Ok(())
}
