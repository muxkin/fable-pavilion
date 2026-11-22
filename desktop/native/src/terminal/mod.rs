pub mod forwarding;
#[cfg(unix)]
mod pty_unix;
#[cfg(windows)]
mod pty_windows;

#[cfg(unix)]
use pty_unix::PtyHandle;
#[cfg(windows)]
use pty_windows::PtyHandle;

use anyhow::{Context, Result, ensure};
use forwarding::{ForwardManager, ForwardSummary, HostCapabilities, find_on_path, probe_capabilities};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};
use tokio::sync::broadcast;
use uuid::Uuid;

pub const BACKEND_ID: &str = "terminal-local";
pub const PRODUCT: &str = "terminal";
pub const PACKAGE_NAME: &str = "@agent-remote/plugin-terminal";

const SCROLLBACK_LIMIT: usize = 256 * 1024;
const MAX_UPLOAD_BYTES: usize = 32 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub default_shell: String,
    #[serde(default)]
    pub default_cwd: String,
    #[serde(default)]
    pub allow_x11_forwarding: bool,
    #[serde(default)]
    pub allow_wayland_forwarding: bool,
    #[serde(default)]
    pub allow_port_forwarding: bool,
    #[serde(default = "default_true")]
    pub allow_osc52_clipboard: bool,
    #[serde(default = "default_max_sessions")]
    pub max_sessions: u8,
}

fn default_true() -> bool {
    true
}

fn default_max_sessions() -> u8 {
    8
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            default_shell: String::new(),
            default_cwd: String::new(),
            allow_x11_forwarding: false,
            allow_wayland_forwarding: false,
            allow_port_forwarding: false,
            allow_osc52_clipboard: true,
            max_sessions: 8,
        }
    }
}

impl TerminalSettings {
    pub fn sanitized(mut self) -> Self {
        self.default_shell = self.default_shell.trim().chars().take(512).collect();
        self.default_cwd = self.default_cwd.trim().chars().take(1024).collect();
        self.max_sessions = self.max_sessions.clamp(1, 16);
        self
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOption {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    pub platform: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub shell: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub platform: &'static str,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub created_at: i64,
    pub x11_display: Option<String>,
    pub wayland_display: Option<String>,
}

#[derive(Clone, Debug)]
pub enum TerminalEvent {
    Output(Vec<u8>),
    Exit(Option<i32>),
}

pub(super) struct PtySpawnConfig {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub extra_env: Vec<(String, String)>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
    #[serde(default)]
    pub enable_x11: bool,
    #[serde(default)]
    pub enable_wayland: bool,
}

struct SessionRuntime {
    id: String,
    title: String,
    shell: String,
    cwd: PathBuf,
    created_at: i64,
    x11_display: Option<String>,
    wayland_display: Option<String>,
    dims: Mutex<(u16, u16)>,
    running: AtomicBool,
    exit_code: Mutex<Option<i32>>,
    scrollback: Mutex<VecDeque<u8>>,
    writer: Mutex<Box<dyn Write + Send>>,
    pty: Arc<PtyHandle>,
    events: broadcast::Sender<TerminalEvent>,
}

impl SessionRuntime {
    fn summary(&self) -> SessionSummary {
        let (cols, rows) = *self.dims.lock().expect("dims mutex");
        SessionSummary {
            id: self.id.clone(),
            title: self.title.clone(),
            shell: self.shell.clone(),
            cwd: self.cwd.to_string_lossy().into_owned(),
            cols,
            rows,
            platform: current_platform(),
            running: self.running.load(Ordering::Relaxed),
            exit_code: *self.exit_code.lock().expect("exit mutex"),
            created_at: self.created_at,
            x11_display: self.x11_display.clone(),
            wayland_display: self.wayland_display.clone(),
        }
    }

    fn append_scrollback(&self, chunk: &[u8]) {
        let mut buf = self.scrollback.lock().expect("scrollback mutex");
        if chunk.len() >= SCROLLBACK_LIMIT {
            buf.clear();
            buf.extend(&chunk[chunk.len() - SCROLLBACK_LIMIT..]);
            return;
        }
        while buf.len() + chunk.len() > SCROLLBACK_LIMIT {
            buf.pop_front();
        }
        buf.extend(chunk);
    }

    fn snapshot_scrollback(&self) -> Vec<u8> {
        let buf = self.scrollback.lock().expect("scrollback mutex");
        buf.iter().copied().collect()
    }
}

pub struct TerminalService {
    runtime_root: PathBuf,
    settings: RwLock<TerminalSettings>,
    sessions: Mutex<HashMap<String, Arc<SessionRuntime>>>,
    forwards: ForwardManager,
}

impl TerminalService {
    pub fn new(state_dir: &Path, settings: TerminalSettings) -> Self {
        Self {
            runtime_root: state_dir.join("terminal-runtime"),
            settings: RwLock::new(settings.sanitized()),
            sessions: Mutex::new(HashMap::new()),
            forwards: ForwardManager::default(),
        }
    }

    pub fn settings(&self) -> TerminalSettings {
        self.settings.read().expect("terminal settings lock").clone()
    }

    pub fn is_enabled(&self) -> bool {
        self.settings.read().expect("terminal settings lock").enabled
    }

    pub fn update_settings(&self, next: TerminalSettings) -> TerminalSettings {
        let next = next.sanitized();
        let was_enabled = {
            let mut guard = self.settings.write().expect("terminal settings lock");
            let prev = guard.enabled;
            *guard = next.clone();
            prev
        };
        if was_enabled && !next.enabled {
            self.shutdown_all();
        }
        next
    }

    pub fn capabilities(&self) -> HostCapabilities {
        probe_capabilities()
    }

    pub fn backend_info(&self) -> Option<Value> {
        let settings = self.settings();
        if !settings.enabled {
            return None;
        }
        let disabled = |reason: &str| json!({"state": "unsupported", "reason": reason});
        Some(json!({
            "id": BACKEND_ID,
            "product": PRODUCT,
            "name": "终端",
            "connected": true,
            "version": env!("CARGO_PKG_VERSION"),
            "profile": if cfg!(windows) { "windows-conpty" } else { "posix-pty" },
            "presentation": {
                "description": if cfg!(windows) {
                    "交互式终端（Windows ConPTY · lrzsz · trzsz · 图片）"
                } else {
                    "交互式终端（PTY · lrzsz · trzsz · 图片 · 转发）"
                },
                "creation": {
                    "empty": false,
                    "permission": "native",
                    "preset": false,
                    "plan": false,
                },
                "plan": "none",
                "fileReferences": false,
                "exportLog": false,
                "nativeCommands": false,
            },
            "capabilities": {
                "history": disabled("终端使用实时会话流"),
                "send": disabled("终端使用交互式流输入"),
                "steer": disabled("终端不支持引导"),
                "interrupt": disabled("终端使用 Ctrl+C"),
                "respond": disabled("终端无审批卡片"),
                "settings": disabled("请在设置 → 插件管理中调整终端选项"),
                "queue": disabled("终端无消息队列"),
                "create": disabled("请在终端工作区新建标签页"),
                "open": {"state": "supported"},
                "attachments": {"state": "supported"},
                "skills": disabled("终端无技能目录"),
                "plugins": disabled("终端无子插件"),
            }
        }))
    }

    pub fn status(&self) -> Value {
        let settings = self.settings();
        let active = self
            .sessions
            .lock()
            .expect("terminal sessions mutex")
            .values()
            .filter(|s| s.running.load(Ordering::Relaxed))
            .count();
        json!({
            "connected": settings.enabled,
            "enabled": settings.enabled,
            "activeSessions": active,
            "platform": current_platform(),
            "capabilities": self.capabilities(),
            "settings": settings,
            "shells": available_shells(),
        })
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionSummary>> {
        ensure!(self.is_enabled(), "终端插件尚未启用，请在设置 → 插件管理中开启");
        let sessions = self.sessions.lock().expect("terminal sessions mutex");
        let mut list: Vec<_> = sessions.values().map(|s| s.summary()).collect();
        list.sort_by_key(|s| s.created_at);
        Ok(list)
    }

    pub async fn create_session(&self, req: CreateSessionRequest) -> Result<SessionSummary> {
        let settings = self.settings();
        ensure!(settings.enabled, "终端插件尚未启用，请在设置 → 插件管理中开启");
        {
            let mut sessions = self.sessions.lock().expect("terminal sessions mutex");
            sessions.retain(|_, s| s.running.load(Ordering::Relaxed));
            ensure!(
                sessions.len() < settings.max_sessions as usize,
                "已达到最大并发终端数量（{}）",
                settings.max_sessions
            );
        }

        let (program, args, display_name) = resolve_shell(
            req.shell.as_deref(),
            &req.args,
            &settings.default_shell,
        )?;
        let cwd = resolve_cwd(req.cwd.as_deref(), &settings.default_cwd)?;
        let cols = req.cols.unwrap_or(100).clamp(20, 500);
        let rows = req.rows.unwrap_or(30).clamp(5, 200);
        let session_id = Uuid::new_v4().to_string();

        let enable_x11 = req.enable_x11 && settings.allow_x11_forwarding;
        let enable_wayland = req.enable_wayland && settings.allow_wayland_forwarding;
        let forward_setup = self
            .forwards
            .setup_session_forwards(&session_id, enable_x11, enable_wayland, &self.runtime_root)
            .await?;

        let spawn_cfg = PtySpawnConfig {
            program: program.clone(),
            args,
            cwd: cwd.clone(),
            cols,
            rows,
            extra_env: forward_setup.env_vars,
        };
        let spawned = PtyHandle::spawn(spawn_cfg);
        let (pty, mut reader, writer) = match spawned {
            Ok(parts) => parts,
            Err(error) => {
                for id in forward_setup.forward_ids {
                    self.forwards.close(&id);
                }
                return Err(error);
            }
        };
        let pty = Arc::new(pty);
        let (events, _) = broadcast::channel(512);
        let title = req
            .title
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.chars().take(80).collect())
            .unwrap_or(display_name);

        let runtime = Arc::new(SessionRuntime {
            id: session_id.clone(),
            title,
            shell: program,
            cwd,
            created_at: crate::state::now(),
            x11_display: forward_setup.x11_display,
            wayland_display: forward_setup.wayland_display,
            dims: Mutex::new((cols, rows)),
            running: AtomicBool::new(true),
            exit_code: Mutex::new(None),
            scrollback: Mutex::new(VecDeque::with_capacity(16 * 1024)),
            writer: Mutex::new(writer),
            pty: pty.clone(),
            events,
        });

        let summary = runtime.summary();
        self.sessions
            .lock()
            .expect("terminal sessions mutex")
            .insert(session_id.clone(), runtime.clone());

        let reader_runtime = runtime.clone();
        thread::Builder::new()
            .name(format!("pty-read-{}", &session_id[..8]))
            .spawn(move || {
                let mut buf = [0u8; 16384];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = buf[..n].to_vec();
                            reader_runtime.append_scrollback(&chunk);
                            let _ = reader_runtime.events.send(TerminalEvent::Output(chunk));
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                let code = pty.wait_exit();
                *reader_runtime.exit_code.lock().expect("exit mutex") = code;
                reader_runtime.running.store(false, Ordering::Relaxed);
                let _ = reader_runtime.events.send(TerminalEvent::Exit(code));
            })
            .context("无法启动终端输出读取线程")?;

        Ok(summary)
    }

    pub fn attach(
        &self,
        id: &str,
    ) -> Result<(SessionSummary, Vec<u8>, broadcast::Receiver<TerminalEvent>)> {
        ensure!(self.is_enabled(), "终端插件尚未启用");
        let session = self
            .sessions
            .lock()
            .expect("terminal sessions mutex")
            .get(id)
            .cloned()
            .context("终端会话不存在或已关闭")?;
        let rx = session.events.subscribe();
        let scrollback = session.snapshot_scrollback();
        Ok((session.summary(), scrollback, rx))
    }

    pub fn write_input(&self, id: &str, bytes: &[u8]) -> Result<()> {
        ensure!(self.is_enabled(), "终端插件尚未启用");
        ensure!(bytes.len() <= 256 * 1024, "单次终端输入过大");
        let session = self
            .sessions
            .lock()
            .expect("terminal sessions mutex")
            .get(id)
            .cloned()
            .context("终端会话不存在或已关闭")?;
        ensure!(session.running.load(Ordering::Relaxed), "终端会话已结束");
        let mut writer = session.writer.lock().expect("pty writer mutex");
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        ensure!(self.is_enabled(), "终端插件尚未启用");
        let cols = cols.clamp(20, 500);
        let rows = rows.clamp(5, 200);
        let session = self
            .sessions
            .lock()
            .expect("terminal sessions mutex")
            .get(id)
            .cloned()
            .context("终端会话不存在或已关闭")?;
        session.pty.resize(cols, rows)?;
        *session.dims.lock().expect("dims mutex") = (cols, rows);
        Ok(())
    }

    pub fn close_session(&self, id: &str) -> Result<bool> {
        let removed = self
            .sessions
            .lock()
            .expect("terminal sessions mutex")
            .remove(id);
        self.forwards.close_for_session(id);
        if let Some(session) = removed {
            session.running.store(false, Ordering::Relaxed);
            session.pty.kill();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn upload_file(
        &self,
        id: &str,
        raw_name: &str,
        bytes: &[u8],
        directory: Option<&str>,
    ) -> Result<Value> {
        ensure!(self.is_enabled(), "终端插件尚未启用");
        ensure!(bytes.len() <= MAX_UPLOAD_BYTES, "上传文件超过 32 MiB 限制");
        let session = self
            .sessions
            .lock()
            .expect("terminal sessions mutex")
            .get(id)
            .cloned()
            .context("终端会话不存在或已关闭")?;
        let safe_name = sanitize_filename(raw_name)?;
        let base_dir = directory
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| session.cwd.clone());
        ensure!(base_dir.is_dir(), "目标目录不可写");
        let target = unique_destination(&base_dir, &safe_name);
        fs::write(&target, bytes).context("写入上传文件失败")?;
        let path_str = target.to_string_lossy().into_owned();
        let shell_path = shell_escape_path(&path_str, cfg!(windows));
        Ok(json!({
            "name": target.file_name().and_then(|n| n.to_str()).unwrap_or(&safe_name),
            "path": path_str,
            "shellPath": shell_path,
            "size": bytes.len(),
        }))
    }

    pub fn download_file(&self, id: &str, raw_path: &str) -> Result<(String, Vec<u8>)> {
        ensure!(self.is_enabled(), "终端插件尚未启用");
        let session = self
            .sessions
            .lock()
            .expect("terminal sessions mutex")
            .get(id)
            .cloned()
            .context("终端会话不存在或已关闭")?;
        let candidate = PathBuf::from(raw_path.trim());
        let resolved = if candidate.is_absolute() {
            candidate
        } else {
            session.cwd.join(candidate)
        };
        let meta = fs::metadata(&resolved).context("文件不存在")?;
        ensure!(meta.is_file(), "目标不是普通文件");
        ensure!(meta.len() <= MAX_DOWNLOAD_BYTES as u64, "文件超过 16 MiB 直接下载上限，请使用 trzsz / lrzsz");
        let bytes = fs::read(&resolved).context("读取文件失败")?;
        let name = resolved
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("download.bin")
            .to_owned();
        Ok((name, bytes))
    }

    pub fn list_forwards(&self) -> Result<Vec<ForwardSummary>> {
        ensure!(self.is_enabled(), "终端插件尚未启用");
        Ok(self.forwards.list())
    }

    pub fn create_tcp_forward(&self, host: &str, port: u16) -> Result<ForwardSummary> {
        let settings = self.settings();
        ensure!(settings.enabled, "终端插件尚未启用");
        ensure!(
            settings.allow_port_forwarding,
            "端口转发尚未开启，请在设置 → 插件管理 → 终端中允许端口转发"
        );
        self.forwards.create_tcp_forward(host, port)
    }

    pub fn close_forward(&self, id: &str) -> Result<bool> {
        ensure!(self.is_enabled(), "终端插件尚未启用");
        Ok(self.forwards.close(id))
    }

    pub async fn forward_http(
        &self,
        id: &str,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<Value> {
        let settings = self.settings();
        ensure!(settings.enabled && settings.allow_port_forwarding, "端口转发未启用");
        self.forwards.http_proxy(id, method, path, body).await
    }

    pub fn shutdown_all(&self) {
        let drained: Vec<_> = self
            .sessions
            .lock()
            .expect("terminal sessions mutex")
            .drain()
            .map(|(_, session)| session)
            .collect();
        for session in drained {
            session.running.store(false, Ordering::Relaxed);
            session.pty.kill();
        }
        self.forwards.close_all();
    }
}

pub fn current_platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

pub fn available_shells() -> Vec<ShellOption> {
    let mut shells = Vec::new();
    let mut seen = HashSet::new();
    let mut push_unique = |id: &str, name: &str, path: PathBuf, args: Vec<String>| {
        let key = path.to_string_lossy().to_ascii_lowercase();
        if path.is_file() && seen.insert(key) {
            shells.push(ShellOption {
                id: id.to_owned(),
                name: name.to_owned(),
                path: path.to_string_lossy().into_owned(),
                args,
                platform: current_platform(),
            });
        }
    };

    #[cfg(windows)]
    {
        if let Some(p) = find_on_path("pwsh.exe").or_else(|| {
            env::var_os("ProgramFiles")
                .map(|d| PathBuf::from(d).join("PowerShell\\7\\pwsh.exe"))
        }) {
            push_unique("pwsh", "PowerShell 7", p, vec!["-NoLogo".into()]);
        }
        if let Some(p) = find_on_path("powershell.exe").or_else(|| {
            env::var_os("SystemRoot").map(|d| {
                PathBuf::from(d).join("System32\\WindowsPowerShell\\v1.0\\powershell.exe")
            })
        }) {
            push_unique("powershell", "Windows PowerShell", p, vec!["-NoLogo".into()]);
        }
        if let Some(p) = env::var_os("COMSPEC")
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .or_else(|| find_on_path("cmd.exe"))
        {
            push_unique("cmd", "命令提示符 (cmd)", p, vec![]);
        }
        if let Some(p) = env::var_os("ProgramFiles")
            .map(|d| PathBuf::from(d).join("Git\\bin\\bash.exe"))
            .filter(|p| p.is_file())
        {
            push_unique("git-bash", "Git Bash", p, vec!["--login".into(), "-i".into()]);
        }
        if let Some(p) = find_on_path("wsl.exe") {
            push_unique("wsl", "WSL", p, vec![]);
        }
    }

    #[cfg(unix)]
    {
        if let Ok(default_shell) = env::var("SHELL")
            && !default_shell.trim().is_empty()
        {
            let p = PathBuf::from(default_shell.trim());
            let label = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("Default Shell");
            push_unique("default", &format!("默认 Shell ({label})"), p, vec!["-l".into()]);
        }
        for (id, name, candidates) in [
            ("zsh", "Zsh", ["/bin/zsh", "/usr/bin/zsh", "/opt/homebrew/bin/zsh"].as_slice()),
            ("bash", "Bash", ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"].as_slice()),
            ("fish", "Fish", ["/usr/bin/fish", "/usr/local/bin/fish", "/opt/homebrew/bin/fish"].as_slice()),
            ("sh", "POSIX sh", ["/bin/sh"].as_slice()),
        ] {
            for candidate in candidates {
                let p = PathBuf::from(candidate);
                if p.is_file() {
                    let args = if id == "sh" { vec![] } else { vec!["-l".into()] };
                    push_unique(id, name, p, args);
                    break;
                }
            }
        }
    }

    shells
}

fn resolve_shell(
    requested: Option<&str>,
    requested_args: &[String],
    default_shell: &str,
) -> Result<(String, Vec<String>, String)> {
    let shells = available_shells();
    let pick = requested
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .or_else(|| {
            let trimmed = default_shell.trim();
            (!trimmed.is_empty()).then_some(trimmed)
        });
    if let Some(target) = pick {
        let found = shells.iter().find(|s| {
            let matches_id = if cfg!(windows) {
                s.id.eq_ignore_ascii_case(target)
            } else {
                s.id == target
            };
            let matches_path = if cfg!(windows) {
                s.path.eq_ignore_ascii_case(target)
            } else {
                s.path == target
            };
            let matches_name = Path::new(&s.path)
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| {
                    if cfg!(windows) {
                        n.eq_ignore_ascii_case(target)
                    } else {
                        n == target
                    }
                });
            matches_id || matches_path || matches_name
        });
        if let Some(found) = found {
            let args = if requested_args.is_empty() {
                found.args.clone()
            } else {
                requested_args.to_vec()
            };
            return Ok((found.path.clone(), args, found.name.clone()));
        }
        let path = PathBuf::from(target);
        let resolved = if path.is_file() {
            path
        } else {
            find_on_path(target).with_context(|| format!("找不到指定的 Shell: {target}"))?
        };
        let label = resolved
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Terminal")
            .to_owned();
        return Ok((
            resolved.to_string_lossy().into_owned(),
            requested_args.to_vec(),
            label,
        ));
    }
    if let Some(first) = shells.into_iter().next() {
        return Ok((first.path, first.args, first.name));
    }
    #[cfg(windows)]
    {
        Ok(("cmd.exe".into(), vec![], "cmd".into()))
    }
    #[cfg(unix)]
    {
        Ok(("/bin/sh".into(), vec![], "sh".into()))
    }
}

fn resolve_cwd(requested: Option<&str>, default_cwd: &str) -> Result<PathBuf> {
    let candidate = requested
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .or_else(|| {
            let trimmed = default_cwd.trim();
            (!trimmed.is_empty()).then_some(trimmed)
        });
    if let Some(dir) = candidate {
        let path = PathBuf::from(dir);
        ensure!(path.is_dir(), "工作目录不存在: {dir}");
        return Ok(path);
    }
    Ok(dirs::home_dir()
        .filter(|p| p.is_dir())
        .unwrap_or_else(env::temp_dir))
}

pub fn sanitize_filename(raw: &str) -> Result<String> {
    let base = raw
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    ensure!(
        !base.is_empty()
            && base != "."
            && base != ".."
            && base.len() <= 180
            && !base.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')),
        "文件名无效"
    );
    Ok(base.to_owned())
}

fn unique_destination(dir: &Path, filename: &str) -> PathBuf {
    let initial = dir.join(filename);
    if !initial.exists() {
        return initial;
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);
    let ext = path.extension().and_then(|e| e.to_str());
    for index in 1..1000 {
        let candidate = match ext {
            Some(ext) => dir.join(format!("{stem}-{index}.{ext}")),
            None => dir.join(format!("{stem}-{index}")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{}-{}", Uuid::new_v4(), filename))
}

pub fn shell_escape_path(path: &str, windows: bool) -> String {
    if windows {
        let escaped = path.replace('\'', "''");
        format!("'{escaped}'")
    } else {
        let escaped = path.replace('\'', "'\\''");
        format!("'{escaped}'")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_plugin_is_disabled_by_default() {
        let settings = TerminalSettings::default();
        assert!(!settings.enabled);
        assert!(!settings.allow_x11_forwarding);
        assert!(!settings.allow_wayland_forwarding);
        assert!(!settings.allow_port_forwarding);
        assert!(settings.allow_osc52_clipboard);
        assert_eq!(settings.max_sessions, 8);
    }

    #[test]
    fn sanitize_filename_rejects_traversal_and_keeps_basename() {
        assert_eq!(sanitize_filename("photo.png").unwrap(), "photo.png");
        assert_eq!(sanitize_filename("/tmp/dir/shot.webp").unwrap(), "shot.webp");
        assert!(sanitize_filename("..").is_err());
        assert!(sanitize_filename(".").is_err());
        assert!(sanitize_filename("").is_err());
        assert!(sanitize_filename("bad:name?.png").is_err());
    }

    #[test]
    fn shell_escape_handles_unix_and_windows() {
        assert_eq!(
            shell_escape_path("/tmp/it's here.png", false),
            "'/tmp/it'\\''s here.png'"
        );
        assert_eq!(
            shell_escape_path(r"C:\Users\me\it's.png", true),
            r"'C:\Users\me\it''s.png'"
        );
    }

    #[test]
    fn disabled_service_hides_backend_and_blocks_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let service = TerminalService::new(dir.path(), TerminalSettings::default());
        assert!(service.backend_info().is_none());
        assert!(service.list_sessions().is_err());
        service.update_settings(TerminalSettings {
            enabled: true,
            ..Default::default()
        });
        let info = service.backend_info().expect("enabled backend info");
        assert_eq!(info["id"], BACKEND_ID);
        assert_eq!(info["product"], PRODUCT);
        assert!(service.list_sessions().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_pty_runs_echo_and_resizes() {
        let dir = tempfile::tempdir().unwrap();
        let service = TerminalService::new(
            dir.path(),
            TerminalSettings {
                enabled: true,
                ..Default::default()
            },
        );
        let session = service
            .create_session(CreateSessionRequest {
                shell: Some("/bin/sh".into()),
                cwd: Some(dir.path().to_string_lossy().into_owned()),
                cols: Some(80),
                rows: Some(24),
                ..Default::default()
            })
            .await
            .unwrap();
        let (_summary, mut collected, mut rx) = service.attach(&session.id).unwrap();
        service.resize(&session.id, 120, 40).unwrap();
        service
            .write_input(&session.id, b"printf 'HELLO_FP_PTY\\n'; exit 0\n")
            .unwrap();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if String::from_utf8_lossy(&collected).contains("HELLO_FP_PTY") {
                break;
            }
            if let Ok(Ok(event)) =
                tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await
            {
                match event {
                    TerminalEvent::Output(chunk) => collected.extend(chunk),
                    TerminalEvent::Exit(_) => break,
                }
            }
        }
        assert!(
            String::from_utf8_lossy(&collected).contains("HELLO_FP_PTY"),
            "unexpected output: {}",
            String::from_utf8_lossy(&collected)
        );
        let _ = service.close_session(&session.id);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_conpty_runs_cmd_echo_and_resizes() {
        let dir = tempfile::tempdir().unwrap();
        let service = TerminalService::new(
            dir.path(),
            TerminalSettings {
                enabled: true,
                ..Default::default()
            },
        );
        let cmd = env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
        let session = service
            .create_session(CreateSessionRequest {
                shell: Some(cmd),
                cwd: Some(dir.path().to_string_lossy().into_owned()),
                cols: Some(80),
                rows: Some(24),
                ..Default::default()
            })
            .await
            .unwrap();
        let (_summary, mut collected, mut rx) = service.attach(&session.id).unwrap();
        service.resize(&session.id, 120, 40).unwrap();
        service
            .write_input(&session.id, b"echo HELLO_WIN_CONPTY\r\nexit\r\n")
            .unwrap();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while tokio::time::Instant::now() < deadline {
            if String::from_utf8_lossy(&collected).contains("HELLO_WIN_CONPTY") {
                break;
            }
            if let Ok(Ok(event)) =
                tokio::time::timeout(std::time::Duration::from_millis(250), rx.recv()).await
            {
                match event {
                    TerminalEvent::Output(chunk) => collected.extend(chunk),
                    TerminalEvent::Exit(_) => break,
                }
            }
        }
        assert!(
            String::from_utf8_lossy(&collected).contains("HELLO_WIN_CONPTY"),
            "unexpected Windows ConPTY output: {}",
            String::from_utf8_lossy(&collected)
        );
        let _ = service.close_session(&session.id);
    }
}
