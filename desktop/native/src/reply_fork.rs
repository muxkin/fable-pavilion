use crate::codex_live::Outcome;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, RwLock},
    time::{Duration, SystemTime},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
    time::{Instant, timeout},
};
use uuid::Uuid;

const CLIENT: &str = "pocket_reply_fork";
const FIRST_TURN_CLIENT: &str = "agent_space_first_turn";
const PROBE_CLIENT: &str = "agent_space_reply_probe";
const MODEL_CLIENT: &str = "codex_work_desktop";
const LINE_LIMIT: u64 = 256 * 1024;

#[derive(Clone, Default)]
pub struct ReplyFork {
    executable: Option<PathBuf>,
    checking: Arc<Mutex<()>>,
    checked: Arc<RwLock<Option<Probe>>>,
}

#[derive(PartialEq, Eq)]
struct Executable {
    path: PathBuf,
    modified: SystemTime,
    size: u64,
    #[cfg(unix)]
    identity: (u64, u64),
}

impl Executable {
    fn resolve(path: PathBuf) -> Option<Self> {
        let path = path.canonicalize().ok()?;
        let metadata = fs::metadata(&path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Some(Self {
            path,
            modified: metadata.modified().ok()?,
            size: metadata.len(),
            #[cfg(unix)]
            identity: (metadata.dev(), metadata.ino()),
        })
    }
}

#[derive(Clone, Copy, Default)]
struct Capabilities {
    blank: bool,
    fork: Option<bool>,
}

struct Probe {
    executable: Executable,
    capabilities: Capabilities,
    checked: Instant,
}

impl ReplyFork {
    pub fn new(desktop: Option<&Path>, cli: Option<&Path>) -> Self {
        let executable = cli
            .map(Path::to_path_buf)
            .or_else(|| desktop.and_then(cli_for_desktop))
            .filter(|path| path.is_absolute());
        Self {
            executable,
            ..Default::default()
        }
    }

    async fn executable(&self) -> Option<Executable> {
        let executable = self.executable.clone();
        #[cfg(windows)]
        let executable = match executable {
            Some(path) => Some(path),
            None => tokio::task::spawn_blocking(crate::codex_peer::windows_executable)
                .await
                .ok()
                .and_then(Result::ok)
                .as_deref()
                .and_then(cli_for_desktop),
        };
        Executable::resolve(executable?)
    }

    pub fn supported(&self) -> bool {
        self.capabilities().fork == Some(true)
    }

    pub fn supports_blank(&self) -> bool {
        self.capabilities().blank
    }

    fn capabilities(&self) -> Capabilities {
        self.checked
            .read()
            .expect("Codex executable capability lock")
            .as_ref()
            .map(|probe| probe.capabilities)
            .unwrap_or_default()
    }

    pub async fn probe(&self) {
        let _ = self.verified_executable().await;
    }

    /// Discovery only: never starts, resumes or changes a conversation. Use the
    /// bundled executable selected for this Desktop and the same account home.
    pub(crate) async fn models(&self, home: &Path) -> Result<Value> {
        let executable = self
            .executable()
            .await
            .context("本机 Codex 模型接口不可用")?;
        timeout(Duration::from_secs(6), async {
            let mut server = AppServer::connect(&executable.path, home, MODEL_CLIENT).await?;
            let models = server.models().await?;
            server.finish(Duration::from_millis(200)).await;
            crate::codex::live_models(&models)
        })
        .await?
    }

    async fn verified_executable(&self) -> Option<(PathBuf, Capabilities)> {
        let _checking = self.checking.lock().await;
        let executable = self.executable().await;
        {
            let mut checked = self
                .checked
                .write()
                .expect("Codex executable capability lock");
            if let Some(probe) = checked.as_ref()
                && executable.as_ref() == Some(&probe.executable)
                && (probe.capabilities.fork.is_some()
                    || probe.checked.elapsed() < Duration::from_secs(30))
            {
                return Some((probe.executable.path.clone(), probe.capabilities));
            }
            *checked = None;
        }
        let executable = executable?;
        let caps = probe_executable(&executable.path).await.ok()?;
        let current = self.executable().await?;
        if current != executable {
            return None;
        }
        let path = current.path.clone();
        *self
            .checked
            .write()
            .expect("Codex executable capability lock") = Some(Probe {
            executable: current,
            capabilities: caps,
            checked: Instant::now(),
        });
        Some((path, caps))
    }

    pub async fn fork(&self, home: &Path, thread: &str, turn: &str) -> Outcome {
        let Some((executable, _)) = self
            .verified_executable()
            .await
            .filter(|(_, caps)| caps.fork == Some(true))
        else {
            return Outcome::Rejected("本机 Codex 未确认支持从指定回复创建分支".into());
        };
        let mut dispatched = false;
        let result = timeout(
            Duration::from_secs(15),
            Self::run(&executable, home, thread, turn, &mut dispatched),
        )
        .await;
        match result {
            Ok(Ok(outcome)) => outcome,
            _ if dispatched => Outcome::Uncertain,
            _ => Outcome::Rejected("本机分支接口暂不可用".into()),
        }
    }

    async fn run(
        executable: &Path,
        home: &Path,
        thread: &str,
        turn: &str,
        dispatched: &mut bool,
    ) -> Result<Outcome> {
        let mut server = AppServer::connect(executable, home, CLIENT).await?;
        *dispatched = true;
        let result = server
            .request(
                2,
                "thread/fork",
                json!({
                    "threadId":thread,"lastTurnId":turn,"excludeTurns":true,"threadSource":"user",
                }),
            )
            .await?;
        if result["error"]["code"] == -32600 {
            return Ok(Outcome::Rejected(
                "无法从所选回复创建分支，请刷新后重试".into(),
            ));
        }
        let fork = &result["result"]["thread"];
        ensure!(fork["forkedFromId"] == thread, "分支来源未经确认");
        let id = Uuid::parse_str(fork["id"].as_str().context("缺少分支 ID")?)?;
        ensure!(id.to_string() != thread, "返回了原会话");
        Ok(Outcome::Completed(Some(id)))
    }

    pub(crate) async fn blank(&self, home: &Path, params: Value, title: &str) -> Outcome {
        let Some((executable, _)) = self
            .verified_executable()
            .await
            .filter(|(_, caps)| caps.blank)
        else {
            return Outcome::Rejected("本机 Codex 未确认支持创建带工具的新会话".into());
        };
        let mut prepared = None;
        let result = timeout(Duration::from_secs(20), async {
            let mut server = AppServer::connect(&executable, home, FIRST_TURN_CLIENT).await?;
            let result = server.request(2, "thread/start", params.clone()).await?;
            let thread = &result["result"]["thread"];
            ensure!(
                thread["projectId"] == params["projectId"],
                "未确认新会话的项目"
            );
            ensure!(
                thread["cwd"]
                    .as_str()
                    .zip(params["cwd"].as_str())
                    .is_some_and(|(actual, wanted)| same_directory(
                        Path::new(actual),
                        Path::new(wanted)
                    )),
                "未确认新会话的工作目录"
            );
            let id = Uuid::parse_str(thread["id"].as_str().context("缺少新会话标识")?)?;
            prepared = Some(id);
            let result = server
                .request(3, "thread/name/set", json!({"threadId":id,"name":title}))
                .await?;
            ensure!(result.get("result").is_some(), "无法保存空会话");
            server.finish(Duration::from_secs(3)).await;
            Ok::<_, anyhow::Error>(Outcome::Completed(Some(id)))
        })
        .await;
        if let Ok(Ok(outcome)) = result {
            return outcome;
        }
        let Some(id) = prepared else {
            return Outcome::Rejected("无法用当前 Codex 版本创建带工具的新会话".into());
        };
        // If the receipt was lost after naming, recover only a materialized rollout.
        let home = home.to_owned();
        let verified = tokio::task::spawn_blocking(move || {
            let history = crate::codex::History::open(&home)?;
            let (cwd, path) = history.media_context(id)?;
            ensure!(
                params["cwd"]
                    .as_str()
                    .is_some_and(|want| same_directory(&cwd, Path::new(want))),
                "新会话目录未确认"
            );
            history.open_rollout(&path).map(|_| ())
        })
        .await;
        if matches!(verified, Ok(Ok(()))) {
            Outcome::Completed(Some(id))
        } else {
            Outcome::Uncertain
        }
    }
}

fn same_directory(actual: &Path, requested: &Path) -> bool {
    let same_path = actual == requested;
    #[cfg(windows)]
    let same_path = same_path
        || actual
            .canonicalize()
            .ok()
            .zip(requested.canonicalize().ok())
            .is_some_and(|(actual, requested)| actual == requested);
    same_path
}

async fn probe_executable(executable: &Path) -> Result<Capabilities> {
    // Exercise the installed App Server against an isolated home. Some older
    // servers accepted lastTurnId while silently forking the entire thread.
    let sandbox = tempfile::tempdir()?;
    let home = sandbox.path().canonicalize()?;
    let Some((mut server, id)) =
        timeout(Duration::from_secs(4), probe_blank(executable, &home)).await??
    else {
        return Ok(Capabilities {
            blank: false,
            fork: Some(false),
        });
    };
    let cutoff = Uuid::new_v4();
    let fork = timeout(
        Duration::from_secs(2),
        server.request(
            4,
            "thread/fork",
            json!({
                "threadId":id,"lastTurnId":cutoff,"excludeTurns":true,"threadSource":"user",
            }),
        ),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .and_then(|result| cutoff_supported(&result, id, cutoff));
    server.finish(Duration::from_secs(1)).await;
    Ok(Capabilities { blank: true, fork })
}

async fn probe_blank(executable: &Path, home: &Path) -> Result<Option<(AppServer, Uuid)>> {
    let mut server = AppServer::connect(executable, home, PROBE_CLIENT).await?;
    let start = server
        .request(
            2,
            "thread/start",
            json!({"cwd":home,"threadSource":"user","historyMode":"paginated"}),
        )
        .await?;
    if start["error"]["code"] == -32601 {
        server.finish(Duration::from_secs(1)).await;
        return Ok(None);
    }
    let thread = &start["result"]["thread"];
    let id = Uuid::parse_str(thread["id"].as_str().context("缺少探测会话标识")?)?;
    ensure!(
        thread["cwd"]
            .as_str()
            .is_some_and(|cwd| same_directory(Path::new(cwd), home)),
        "探测会话目录不匹配"
    );
    let name = server
        .request(
            3,
            "thread/name/set",
            json!({"threadId":id,"name":"Agent Space capability probe"}),
        )
        .await?;
    if name["error"]["code"] == -32601 {
        server.finish(Duration::from_secs(1)).await;
        return Ok(None);
    }
    ensure!(name.get("result").is_some(), "无法保存探测会话");
    Ok(Some((server, id)))
}

fn cutoff_supported(result: &Value, thread: Uuid, cutoff: Uuid) -> Option<bool> {
    let missing = result["error"]["message"]
        .as_str()
        .and_then(|message| message.split_once(':'))
        .filter(|(reason, _)| reason.trim().eq_ignore_ascii_case("turn not found"))
        .and_then(|(_, id)| Uuid::parse_str(id.trim()).ok());
    match result["error"]["code"].as_i64() {
        Some(-32600) if missing == Some(cutoff) => Some(true),
        Some(-32601 | -32602) => Some(false),
        None if result["result"]["thread"]["forkedFromId"] == thread.to_string() => Some(false),
        _ => None,
    }
}

struct AppServer {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl AppServer {
    async fn connect(executable: &Path, home: &Path, client: &str) -> Result<Self> {
        let mut command = Command::new(executable);
        command.kill_on_drop(true).stderr(Stdio::null());
        if client == PROBE_CLIENT {
            command.current_dir(home);
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child = command
            .args(["app-server", "--listen", "stdio://"])
            .env("CODEX_HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let input = child.stdin.take().context("Codex 请求流不可用")?;
        let output = BufReader::new(child.stdout.take().context("Codex 响应流不可用")?);
        let mut server = AppServer {
            child,
            input,
            output,
        };
        let initial = server
            .request(
                1,
                "initialize",
                json!({
                    "clientInfo":{"name":client,"version":"1.0.0"},
                    "capabilities":{"experimentalApi":true}
                }),
            )
            .await?;
        ensure!(
            initial["result"].is_object() && initial["error"].is_null(),
            "Codex 未确认初始化"
        );
        write(&mut server.input, json!({"method":"initialized"})).await?;
        Ok(server)
    }
    async fn finish(self, deadline: Duration) {
        let Self {
            mut child, input, ..
        } = self;
        drop(input);
        let _ = timeout(deadline, child.wait()).await;
    }

    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value> {
        write(
            &mut self.input,
            json!({"id":id,"method":method,"params":params}),
        )
        .await?;
        read(&mut self.output, id).await
    }

    async fn models(&mut self) -> Result<Vec<Value>> {
        let mut models = Vec::new();
        let mut cursor = Value::Null;
        let mut seen = HashSet::new();
        for page in 0..16 {
            let response = self
                .request(
                    2 + page,
                    "model/list",
                    json!({"includeHidden":false,"cursor":cursor,"limit":100}),
                )
                .await?;
            ensure!(response["error"].is_null(), "Codex 模型目录暂不可用");
            let entries = response["result"]["data"]
                .as_array()
                .context("Codex 模型目录格式无效")?;
            ensure!(entries.len() <= 100, "Codex 模型目录分页过大");
            models.extend(entries.iter().cloned());
            cursor = response["result"]["nextCursor"].clone();
            if cursor.is_null() {
                return Ok(models);
            }
            let token = cursor
                .as_str()
                .filter(|token| !token.is_empty() && token.len() <= 4096)
                .context("Codex 模型目录游标无效")?;
            ensure!(seen.insert(token.to_owned()), "Codex 模型目录游标重复");
        }
        anyhow::bail!("Codex 模型目录分页过多")
    }
}
pub(crate) fn cli_for_desktop(desktop: &Path) -> Option<PathBuf> {
    let root = desktop.parent()?;
    let resources = if cfg!(target_os = "macos") {
        root.parent()?.join("Resources")
    } else {
        root.join("resources")
    };
    Some(resources.join(if cfg!(windows) { "codex.exe" } else { "codex" }))
}

async fn write(output: &mut (impl AsyncWrite + Unpin), value: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    output.write_all(&bytes).await?;
    output.flush().await?;
    Ok(())
}

async fn read(input: &mut (impl AsyncBufReadExt + Unpin), id: u64) -> Result<Value> {
    let mut line = Vec::new();
    loop {
        line.clear();
        input.take(LINE_LIMIT).read_until(b'\n', &mut line).await?;
        ensure!(line.last() == Some(&b'\n'), "分支响应不完整");
        let value: Value = serde_json::from_slice(&line)?;
        if value["id"] == id {
            return Ok(value);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[tokio::test]
    async fn model_discovery_paginates_refreshes_and_never_starts_a_thread() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let cli = directory.path().join("codex");
        fs::write(
            &cli,
            r#"#!/bin/sh
while IFS= read -r message; do
  printf '%s\n' "$message" >> "$CODEX_HOME/model-requests"
  case "$message" in
    *'"method":"initialize"'*) printf '{"id":1,"result":{}}\n';;
    *'"method":"model/list"'*'"id":2'*|*'"id":2'*'"method":"model/list"'*)
      name=$(cat "$CODEX_HOME/model-name")
      printf '{"id":2,"result":{"data":[{"model":"%s","hidden":false}],"nextCursor":"page-two"}}\n' "$name";;
    *'"method":"model/list"'*'"id":3'*|*'"id":3'*'"method":"model/list"'*)
      printf '{"id":3,"result":{"data":[{"model":"native-second","hidden":false},{"model":"native-hidden","hidden":true}],"nextCursor":null}}\n';;
    *'"method":"initialized"'*) :;;
    *) exit 19;;
  esac
done
"#,
        )?;
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o700))?;
        fs::write(directory.path().join("model-name"), "before-upgrade")?;
        let service = ReplyFork::new(None, Some(&cli));
        let first = service.models(directory.path()).await?;
        assert_eq!(first["models"].as_array().unwrap().len(), 2);
        assert_eq!(first["models"][0]["id"], "before-upgrade");
        fs::write(directory.path().join("model-name"), "after-upgrade")?;
        assert_eq!(
            service.models(directory.path()).await?["models"][0]["id"],
            "after-upgrade"
        );
        let requests = fs::read_to_string(directory.path().join("model-requests"))?;
        assert!(requests.contains(MODEL_CLIENT));
        assert!(!requests.contains("thread/"));
        assert!(!requests.contains("turn/"));
        assert_eq!(requests.matches("model/list").count(), 4);
        assert_eq!(requests.matches("page-two").count(), 2);
        assert!(!service.supports_blank()); // no capability probe started a disposable conversation
        Ok(())
    }

    #[tokio::test]
    async fn model_discovery_rejects_a_repeated_pagination_cursor() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let cli = directory.path().join("codex");
        fs::write(
            &cli,
            r#"#!/bin/sh
while IFS= read -r message; do
  case "$message" in
    *'"method":"initialize"'*) printf '{"id":1,"result":{}}\n';;
    *'"id":2'*) printf '{"id":2,"result":{"data":[],"nextCursor":"repeat"}}\n';;
    *'"id":3'*) printf '{"id":3,"result":{"data":[],"nextCursor":"repeat"}}\n';;
  esac
done
"#,
        )?;
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o700))?;
        let service = ReplyFork::new(None, Some(&cli));
        assert!(
            service
                .models(directory.path())
                .await
                .unwrap_err()
                .to_string()
                .contains("游标重复")
        );
        Ok(())
    }

    #[tokio::test]
    async fn retries_a_transient_cli_probe_failure() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let cli = directory.path().join("codex");
        fs::write(&cli, "#!/bin/sh\nexit 1\n")?;
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o700))?;
        let service = ReplyFork::new(None, Some(&cli));
        service.probe().await;
        assert!(!service.supported());

        fs::write(
            &cli,
            r#"#!/bin/sh
printf '.\n' >> "$(dirname "$0")/probes"
while IFS= read -r message; do
  case "$message" in
    *'"method":"initialize"'*)
      printf '{"id":1,"result":{"userAgent":"unlisted-codex/999.0.0"}}\n';;
    *'"method":"thread/start"'*)
      printf '{"id":2,"result":{"thread":{"id":"00000000-0000-0000-0000-000000000001","cwd":"%s"}}}\n' "$CODEX_HOME";;
    *'"method":"thread/name/set"'*)
      printf '{"id":3,"result":{}}\n';;
    *'"method":"thread/fork"'*)
      cutoff=$(printf '%s\n' "$message" | sed -n 's/.*"lastTurnId":"\([^"]*\)".*/\1/p')
      printf '{"id":4,"error":{"code":-32600,"message":"turn not found: %s"}}\n' "$cutoff";;
  esac
done
"#,
        )?;
        service.probe().await;
        assert!(service.supported());
        assert!(service.supports_blank());
        service.probe().await;
        assert_eq!(fs::read_to_string(directory.path().join("probes"))?, ".\n");

        fs::write(&cli, "#!/bin/sh\nexit 1\n")?;
        service.probe().await;
        assert!(!service.supported());
        assert!(!service.supports_blank());
        Ok(())
    }

    #[test]
    fn proves_cutoff_support_without_assuming_a_successful_fork_honored_it() {
        let thread = Uuid::new_v4();
        let cutoff = Uuid::new_v4();
        assert_eq!(
            cutoff_supported(
                &json!({"error":{"code":-32600,"message":format!("turn not found: {cutoff}")}}),
                thread,
                cutoff,
            ),
            Some(true)
        );
        assert_eq!(
            cutoff_supported(
                &json!({"result":{"thread":{"id":Uuid::new_v4(),"forkedFromId":thread}}}),
                thread,
                cutoff,
            ),
            Some(false)
        );
        assert_eq!(
            cutoff_supported(
                &json!({"error":{"code":-32600,"message":format!("turn not found: {thread}")}}),
                thread,
                cutoff,
            ),
            None
        );
    }
}
