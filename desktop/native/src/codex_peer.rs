use anyhow::{Context, Result, bail, ensure};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncWrite};

pub trait Transport: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Transport for T {}
pub type Stream = Box<dyn Transport>;

#[derive(Clone)]
pub struct Endpoint {
    socket: PathBuf,
    executable: Option<PathBuf>,
    app_tools: Option<PathBuf>,
    discover_tools: bool,
}

impl Endpoint {
    pub fn discover(
        home: &Path,
        options: &crate::codex_service::Options,
        named: bool,
    ) -> Option<Self> {
        if cfg!(windows) && named && options.socket.is_none() {
            return None;
        }
        let socket = options.socket.clone().unwrap_or_else(|| {
            if cfg!(windows) {
                PathBuf::from(r"\\.\pipe\codex-ipc")
            } else {
                home.join("ipc/ipc.sock")
            }
        });
        let executable = options.executable.clone().or_else(|| {
            if let Some(root) = &options.root {
                let candidates = if cfg!(target_os = "macos") {
                    ["Contents/MacOS/Codex", "Contents/MacOS/ChatGPT"]
                } else if cfg!(windows) {
                    ["Codex.exe", "ChatGPT.exe"]
                } else {
                    ["ChatGPT", "Codex"]
                };
                return candidates
                    .into_iter()
                    .map(|name| root.join(name))
                    .find(|path| path.is_file())
                    .or_else(|| Some(root.join(candidates[0])));
            }
            if cfg!(target_os = "linux") {
                Some(PathBuf::from("/usr/lib/chatgpt/ChatGPT"))
            } else if cfg!(target_os = "macos") {
                let candidates = [
                    Some(PathBuf::from(
                        "/Applications/Codex.app/Contents/MacOS/Codex",
                    )),
                    Some(PathBuf::from(
                        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
                    )),
                    dirs::home_dir()
                        .map(|home| home.join("Applications/Codex.app/Contents/MacOS/Codex")),
                ]
                .into_iter()
                .flatten()
                .filter_map(|path| path.canonicalize().ok())
                .filter(|path| path.is_file())
                .collect::<std::collections::BTreeSet<_>>();
                (candidates.len() == 1).then(|| candidates.into_iter().next().unwrap())
            } else {
                None
            }
        });
        Some(Self {
            socket,
            executable,
            app_tools: options.app_tools.clone(),
            discover_tools: !named,
        })
    }

    pub fn executable(&self) -> Option<&Path> {
        self.executable.as_deref()
    }

    pub async fn open(&self) -> Result<Stream> {
        tokio::time::timeout(Duration::from_secs(5), self.connect(&self.socket, false)).await?
    }

    pub async fn open_app_tools(&self) -> Result<Stream> {
        tokio::time::timeout(Duration::from_secs(5), async {
            if let Some(socket) = &self.app_tools {
                return self.connect(socket, true).await;
            }
            if self.discover_tools {
                let paths = tokio::task::spawn_blocking(app_tools_candidates).await??;
                return self.select_app_tools(&paths).await;
            }
            bail!("本机桌面应用工具不可用")
        })
        .await?
    }

    async fn select_app_tools(&self, paths: &[PathBuf]) -> Result<Stream> {
        ensure!(!paths.is_empty(), "本机桌面应用工具不可用");
        ensure!(paths.len() <= 32, "桌面应用工具端点过多，请显式配置其路径");
        #[cfg(windows)]
        let executables = if let Some(path) = &self.executable {
            vec![path.clone()]
        } else {
            tokio::task::spawn_blocking(windows_executables).await?
        };
        // Discovery has one policy on every platform: ignore stale/unverified
        // endpoints, select exactly one verified live peer, and reject ambiguity.
        // Only the OS transport/peer identity check differs. No tool message is
        // sent until the live endpoint has passed that check.
        let probes = paths.iter().map(|path| {
            tokio::time::timeout(Duration::from_millis(400), async {
                #[cfg(windows)]
                {
                    crate::windows::codex_pipe(path, &executables).await
                }
                #[cfg(not(windows))]
                {
                    self.connect(path, true).await
                }
            })
        });
        let mut connected = None;
        for probe in futures::future::join_all(probes).await {
            if let Ok(Ok(stream)) = probe {
                ensure!(connected.is_none(), "存在多个活动的桌面应用工具端点");
                connected = Some(stream);
            }
        }
        connected.context("本机桌面应用工具不可用")
    }

    #[cfg(unix)]
    async fn connect(&self, socket_path: &Path, app_tools: bool) -> Result<Stream> {
        use std::os::unix::{
            ffi::OsStrExt,
            fs::{FileTypeExt, MetadataExt},
        };
        let uid = rustix::process::geteuid();
        let parent = socket_path.parent().context("Codex Socket 路径无效")?;
        let directory = std::fs::symlink_metadata(parent)?;
        let socket = std::fs::symlink_metadata(socket_path)?;
        ensure!(
            directory.is_dir()
                && directory.uid() == uid.as_raw()
                && (directory.mode() & 0o777 == 0o700
                    || (app_tools && directory.mode() & 0o777 == 0o755))
                && socket.file_type().is_socket()
                && socket.uid() == uid.as_raw()
                && socket.mode() & 0o777 == 0o600,
            "Codex Socket 权限无效",
        );
        let limit = if cfg!(target_os = "macos") { 103 } else { 107 };
        let path = if socket_path.as_os_str().as_bytes().len() > limit {
            use sha2::{Digest, Sha256};
            let directory = parent.canonicalize()?;
            let base = PathBuf::from(format!("/tmp/codex-ipc-{}", uid.as_raw()));
            let metadata = std::fs::symlink_metadata(&base)?;
            ensure!(
                metadata.is_dir()
                    && metadata.uid() == uid.as_raw()
                    && metadata.mode() & 0o777 == 0o700,
                "Codex 短路径目录不安全"
            );
            let alias = base.join(format!(
                "{:x}",
                Sha256::digest(directory.as_os_str().as_bytes())
            ));
            ensure!(
                std::fs::symlink_metadata(&alias)?.uid() == uid.as_raw()
                    && alias.canonicalize()? == directory,
                "Codex 短路径指向错误"
            );
            alias.join(socket_path.file_name().context("Codex Socket 路径无效")?)
        } else {
            socket_path.to_owned()
        };
        let stream = tokio::net::UnixStream::connect(path).await?;
        verify_unix(
            &stream,
            self.executable.as_deref().context("未找到 Codex 程序")?,
            uid.as_raw(),
        )?;
        Ok(Box::new(stream))
    }

    #[cfg(windows)]
    async fn connect(&self, socket: &Path, _app_tools: bool) -> Result<Stream> {
        let candidates = if let Some(path) = &self.executable {
            vec![path.clone()]
        } else {
            tokio::task::spawn_blocking(windows_executables).await?
        };
        crate::windows::codex_pipe(socket, &candidates).await
    }

    #[cfg(not(any(unix, windows)))]
    async fn connect(&self, _socket: &Path, _app_tools: bool) -> Result<Stream> {
        let _ = &self.executable;
        bail!("本平台的 Codex IPC 身份校验尚不可用")
    }
}

#[cfg(any(windows, test))]
fn windows_app_tools_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.strip_prefix("codex-app-tools-")
        .is_some_and(|suffix| suffix.len() == 36 && uuid::Uuid::parse_str(suffix).is_ok())
}

#[cfg(windows)]
fn app_tools_candidates() -> Result<Vec<PathBuf>> {
    let root = Path::new(r"\\.\pipe\");
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        if name.to_str().is_some_and(windows_app_tools_name) {
            ensure!(paths.len() < 32, "桌面应用工具端点过多，请显式配置其路径");
            paths.push(root.join(name));
        }
    }
    paths.sort();
    Ok(paths)
}

#[cfg(unix)]
fn app_tools_candidates() -> Result<Vec<PathBuf>> {
    let uid = rustix::process::geteuid().as_raw();
    // The desktop uses /tmp on both Unix targets; retain the environment temp
    // root as an additional compatible location without double-counting aliases.
    let directories: Vec<_> = [PathBuf::from("/tmp"), std::env::temp_dir()]
        .into_iter()
        .flat_map(|root| {
            [
                root.join(format!("codex-app-tools-{uid}")),
                root.join("codex-app-tools"),
            ]
        })
        .collect();
    Ok(unix_app_tools_candidates(&directories))
}

#[cfg(unix)]
fn unix_app_tools_candidates(directories: &[PathBuf]) -> Vec<PathBuf> {
    use std::os::unix::fs::FileTypeExt;
    directories
        .iter()
        .filter_map(|directory| directory.canonicalize().ok())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter_map(|directory| std::fs::read_dir(directory).ok())
        .flatten()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            (entry.file_type().ok()?.is_socket()
                && path.extension()?.eq_ignore_ascii_case("sock")
                && uuid::Uuid::parse_str(path.file_stem()?.to_str()?).is_ok())
            .then_some(path)
        })
        .collect()
}

#[cfg(not(any(unix, windows)))]
fn app_tools_candidates() -> Result<Vec<PathBuf>> {
    bail!("本平台的 Codex IPC 身份校验尚不可用")
}

#[cfg(test)]
mod candidate_tests {
    use super::*;

    #[test]
    fn windows_app_tools_names_are_limited_to_the_desktop_uuid_namespace() {
        assert!(windows_app_tools_name(
            "codex-app-tools-8e9d5d93-6939-4552-8458-c68277c4379c"
        ));
        assert!(windows_app_tools_name(
            "CODEX-APP-TOOLS-8E9D5D93-6939-4552-8458-C68277C4379C"
        ));
        for name in [
            "codex-app-tools",
            "codex-ipc",
            "codex-app-tools-8e9d5d93693945528458c68277c4379c",
            "codex-app-tools-8e9d5d93-6939-4552-8458-c68277c4379c-extra",
            r"remote\codex-app-tools-8e9d5d93-6939-4552-8458-c68277c4379c",
            "codex-app-tools-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        ] {
            assert!(!windows_app_tools_name(name));
        }
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    static EXCLUSIVE_NAMESPACE: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn path() -> PathBuf {
        PathBuf::from(format!(
            r"\\.\pipe\codex-app-tools-{}",
            uuid::Uuid::new_v4()
        ))
    }

    fn listen(path: &Path) -> NamedPipeServer {
        ServerOptions::new()
            .first_pipe_instance(true)
            .create(path)
            .unwrap()
    }

    fn endpoint() -> Endpoint {
        Endpoint {
            socket: PathBuf::from(r"\\.\pipe\unused-test-ipc"),
            executable: Some(std::env::current_exe().unwrap()),
            app_tools: None,
            discover_tools: true,
        }
    }

    #[tokio::test]
    async fn automatic_windows_discovery_uses_the_verified_server_and_ignores_stale_names() {
        let _exclusive = EXCLUSIVE_NAMESPACE.lock().unwrap();
        let live = path();
        let stale = path();
        let _server = listen(&live);
        let endpoint = endpoint();
        assert!(
            endpoint
                .select_app_tools(&[live.clone(), stale])
                .await
                .is_ok()
        );
        drop(_server);

        let _server = listen(&live);
        let foreign_executable = tempfile::NamedTempFile::new().unwrap();
        let foreign = Endpoint {
            executable: Some(foreign_executable.path().to_owned()),
            ..endpoint
        };
        assert!(foreign.select_app_tools(&[live]).await.is_err());
    }

    #[tokio::test]
    async fn windows_discovery_rejects_ambiguity_and_an_explicit_pipe_remains_authoritative() {
        let _exclusive = EXCLUSIVE_NAMESPACE.lock().unwrap();
        let one = path();
        let two = path();
        let _one = listen(&one);
        let _two = listen(&two);
        let endpoint = endpoint();
        assert!(
            endpoint
                .select_app_tools(&[one.clone(), two.clone()])
                .await
                .is_err()
        );
        drop(_one);
        drop(_two);
        let _one = listen(&one);
        let _two = listen(&two);

        let explicit = PathBuf::from(format!(
            r"\\.\pipe\agent-space-explicit-{}",
            uuid::Uuid::new_v4()
        ));
        let _explicit = listen(&explicit);
        let endpoint = Endpoint {
            app_tools: Some(explicit),
            ..endpoint
        };
        assert!(endpoint.open_app_tools().await.is_ok());
    }

    #[tokio::test]
    async fn default_windows_endpoint_discovers_tools_without_an_app_tools_override() {
        let _exclusive = EXCLUSIVE_NAMESPACE.lock().unwrap();
        let pipe = path();
        let _server = listen(&pipe);
        let endpoint = endpoint();
        let discovered = app_tools_candidates().unwrap();
        assert!(discovered.contains(&pipe));
        assert!(endpoint.open_app_tools().await.is_ok());
    }
}

#[cfg(target_os = "linux")]
fn verify_unix(stream: &tokio::net::UnixStream, expected: &Path, uid: u32) -> Result<()> {
    use std::{fs, os::unix::fs::MetadataExt};
    let credential = rustix::net::sockopt::socket_peercred(stream)?;
    ensure!(credential.uid.as_raw() == uid, "Codex 对端用户不匹配");
    let proc = PathBuf::from(format!("/proc/{}/exe", credential.pid.as_raw_nonzero()));
    let peer = fs::read_link(&proc)?;
    let expected = expected.canonicalize()?;
    if peer == expected {
        return Ok(());
    }
    // A running root-installed executable can outlive a package replacement.
    let Some(original) = peer
        .to_str()
        .and_then(|path| path.strip_suffix(" (deleted)"))
    else {
        bail!("Codex 对端程序不匹配")
    };
    ensure!(
        Path::new(original).canonicalize()? == expected,
        "Codex 对端程序不匹配"
    );
    for path in [&expected, &proc] {
        let metadata = fs::metadata(path)?;
        ensure!(
            metadata.is_file() && metadata.uid() == 0 && metadata.mode() & 0o022 == 0,
            "Codex 对端程序不受保护"
        );
    }
    for directory in expected.ancestors().skip(1) {
        let metadata = fs::metadata(directory)?;
        ensure!(
            metadata.is_dir() && metadata.uid() == 0 && metadata.mode() & 0o022 == 0,
            "Codex 安装目录不受保护"
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_unix(stream: &tokio::net::UnixStream, expected: &Path, uid: u32) -> Result<()> {
    use std::{ffi::CStr, os::unix::ffi::OsStrExt};

    let credentials = stream.peer_cred()?;
    ensure!(credentials.uid() == uid, "Codex 对端用户不匹配");
    let pid = credentials
        .pid()
        .filter(|pid| *pid > 0)
        .context("无法读取 Codex 对端进程")?;
    let mut buffer = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // The kernel returns the executable path for the PID attached to the connected socket.
    let length =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    ensure!(length > 0, "无法读取 Codex 对端程序");
    let peer = Path::new(std::ffi::OsStr::from_bytes(
        CStr::from_bytes_until_nul(&buffer)?.to_bytes(),
    ));
    ensure!(peer == expected.canonicalize()?, "Codex 对端程序不匹配");
    Ok(())
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn verify_unix(_stream: &tokio::net::UnixStream, _expected: &Path, _uid: u32) -> Result<()> {
    bail!("本平台的 Codex IPC 身份校验尚不可用")
}

#[cfg(windows)]
pub(crate) fn windows_executable() -> Result<PathBuf> {
    let mut paths = windows_executables();
    anyhow::ensure!(
        paths.len() == 1,
        "未找到唯一的 Codex 程序，请显式配置其路径"
    );
    Ok(paths.remove(0))
}

#[cfg(windows)]
fn windows_executables() -> Vec<PathBuf> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        ProcessRefreshKind::new().with_exe(UpdateKind::Always),
    );
    system
        .processes()
        .values()
        .filter(|process| {
            let name = process.name().to_string_lossy();
            name.eq_ignore_ascii_case("codex.exe") || name.eq_ignore_ascii_case("chatgpt.exe")
        })
        .filter_map(|process| process.exe()?.canonicalize().ok())
        .filter(|path| {
            path.parent()
                .is_some_and(|root| root.join("resources/app.asar").is_file())
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};
    use tokio::net::UnixListener;

    fn listen(directory: &Path, name: &str) -> UnixListener {
        let path = directory.join(name);
        let listener = UnixListener::bind(&path).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        listener
    }

    #[tokio::test]
    async fn app_tools_ignores_stale_sockets_and_rejects_ambiguous_live_sockets() {
        let directory = tempfile::tempdir_in("/tmp").unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let socket = "8e9d5d93-6939-4552-8458-c68277c4379c.sock";
        let stale = "82e6a149-c227-449e-865e-d2a46fc46f17.sock";
        let endpoint = Endpoint {
            socket: directory.path().join(socket),
            executable: Some(std::env::current_exe().unwrap()),
            app_tools: None,
            discover_tools: true,
        };
        let roots = [directory.path().to_owned(), directory.path().join(".")];
        let _active = listen(directory.path(), socket);
        drop(listen(directory.path(), stale));
        // /tmp and the environment temp directory may resolve to the same
        // directory (including /private/tmp on macOS). Never count it twice.
        assert_eq!(unix_app_tools_candidates(&roots).len(), 2);
        assert!(
            endpoint
                .select_app_tools(&unix_app_tools_candidates(&roots))
                .await
                .is_ok()
        );
        assert!(directory.path().join(stale).exists());

        fs::remove_file(directory.path().join(stale)).unwrap();
        let _second = listen(directory.path(), stale);
        assert!(
            endpoint
                .select_app_tools(&unix_app_tools_candidates(&roots))
                .await
                .is_err()
        );

        // An explicitly configured socket remains authoritative when auto-discovery is ambiguous.
        let explicit = Endpoint {
            app_tools: Some(directory.path().join(socket)),
            ..endpoint
        };
        assert!(explicit.open_app_tools().await.is_ok());
    }
}
