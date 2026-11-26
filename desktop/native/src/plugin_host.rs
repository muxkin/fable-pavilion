use crate::{
    history_media::{HistoryUnavailable, MissingAttachment, Source},
    plugin_catalog::{Catalog, Package, Switch},
    plugins::{Adapter, Delivery, Media, Observation, RecordCreated, Subscription, View, Write},
    state::{private_directory, private_file},
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env, fs,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex as SyncMutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock, oneshot, watch},
    time::{sleep, timeout},
};
use uuid::Uuid;

const MAX_FRAME: usize = 8 * 1024 * 1024;
const READS: &[&str] = &[
    "threads.list",
    "thread.read",
    "history.read",
    "content.read",
    "projects.list",
    "creation.projects",
    "models.list",
    "controls.read",
    "references.list",
    "usage.read",
    "skills.list",
    "plugins.list",
];

pub(crate) struct Process {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    generation: Uuid,
    ready: bool,
}

impl Process {
    pub(crate) async fn stop(&mut self) -> Result<()> {
        self.ready = false;
        drop(self.input.take());
        if let Ok(result) = timeout(Duration::from_secs(1), self.child.wait()).await {
            result?;
        } else {
            timeout(Duration::from_secs(3), self.child.kill()).await??;
        }
        Ok(())
    }

    async fn start(package: Package) -> Result<Self> {
        let official_codex = package.manifest.name == "@agent-remote/adapter-codex"
            && package.manifest.product == "codex";
        let executable = tokio::task::spawn_blocking(move || package.executable()).await??;
        let mut command = Command::new(&executable);
        command
            .current_dir(executable.parent().context("原生插件目录无效")?)
            .env_clear();
        for key in [
            "PATH",
            "Path",
            "HOME",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "LOCALAPPDATA",
            "APPDATA",
            "SystemRoot",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "TEMP",
            "TMP",
            "TMPDIR",
            "XDG_RUNTIME_DIR",
            "XDG_STATE_HOME",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "DBUS_SESSION_BUS_ADDRESS",
            "LANG",
            "LC_ALL",
        ] {
            if let Some(value) = env::var_os(key) {
                command.env(key, value);
            }
        }
        if official_codex {
            if let Some(path) = crate::migration::source() {
                command.env("POCKET_NATIVE_LEGACY_STATE", path);
            }
            // The voice plugin starts a local Codex App Server, which may need
            // the same outbound route as the user who launched the gateway.
            for key in [
                "HTTPS_PROXY",
                "HTTP_PROXY",
                "ALL_PROXY",
                "NO_PROXY",
                "https_proxy",
                "http_proxy",
                "all_proxy",
                "no_proxy",
            ] {
                if let Some(value) = env::var_os(key) {
                    command.env(key, value);
                }
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        Self::spawn(command)
    }

    pub(crate) fn spawn(mut command: Command) -> Result<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let input = child.stdin.take().context("原生插件没有输入管道")?;
        let output = BufReader::new(child.stdout.take().context("原生插件没有输出管道")?);
        Ok(Self {
            child,
            input: Some(input),
            output,
            generation: Uuid::new_v4(),
            ready: false,
        })
    }

    pub(crate) async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.request_with_progress(method, params, None).await
    }

    async fn request_with_progress(
        &mut self,
        method: &str,
        mut params: Value,
        created: Option<&RecordCreated<'_>>,
    ) -> Result<Value> {
        let id = Uuid::new_v4().to_string();
        params["generation"] = json!(self.generation);
        let body =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        ensure!((1..=MAX_FRAME).contains(&body.len()), "原生插件请求过大");
        let input = self.input.as_mut().context("原生插件输入管道已关闭")?;
        input
            .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
            .await?;
        input.write_all(&body).await?;
        input.flush().await?;
        let mut response = self.read_reply().await?;
        if let Some(created) = created
            && response["method"] == "adapter/threadCreated"
        {
            ensure!(
                response["params"]["requestId"] == id,
                "原生插件进度标识无效"
            );
            let thread = response["params"]["threadId"]
                .as_str()
                .filter(|thread| valid_id(thread))
                .context("原生插件新会话标识无效")?;
            created(thread)?;
            response = self.read_reply().await?;
        }
        ensure!(response["id"] == id, "原生插件响应标识无效");
        if response.get("error").is_some() {
            return Err(match response["error"]["code"].as_i64() {
                Some(-32004) => MissingAttachment.into(),
                Some(-32005) => HistoryUnavailable.into(),
                _ => Refused.into(),
            });
        }
        Ok(response
            .get_mut("result")
            .context("原生插件响应缺少结果")?
            .take())
    }

    async fn read_reply(&mut self) -> Result<Value> {
        let mut header = Vec::new();
        (&mut self.output)
            .take(128)
            .read_until(b'\n', &mut header)
            .await?;
        let header = std::str::from_utf8(&header)?
            .strip_suffix("\r\n")
            .context("原生插件响应帧无效")?;
        let length: usize = header
            .strip_prefix("Content-Length: ")
            .context("原生插件响应帧无效")?
            .parse()?;
        ensure!((1..=MAX_FRAME).contains(&length), "原生插件响应过大");
        let mut separator = [0; 2];
        self.output.read_exact(&mut separator).await?;
        ensure!(&separator == b"\r\n", "原生插件响应帧无效");
        let mut body = vec![0; length];
        self.output.read_exact(&mut body).await?;
        let response: Value = serde_json::from_slice(&body)?;
        ensure!(
            response["jsonrpc"] == "2.0" && response["generation"] == self.generation.to_string(),
            "原生插件响应标识无效"
        );
        Ok(response)
    }
}

#[derive(Debug)]
struct Refused;
impl std::fmt::Display for Refused {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("原生插件拒绝请求")
    }
}
impl std::error::Error for Refused {}

pub(crate) async fn check(package: &Package) -> Result<()> {
    let result = timeout(Duration::from_secs(10), async {
        let mut process = Process::start(package.clone()).await?;
        let result = process.request("adapter/check", json!({"sdk":1})).await;
        let _ = process.child.kill().await;
        result
    })
    .await??;
    ensure!(result["sdk"] == 1, "原生插件 SDK 版本不兼容");
    Ok(())
}

pub(crate) struct Host {
    id: String,
    name: String,
    config: Value,
    directory: PathBuf,
    read_only: bool,
    runtime: Mutex<Runtime>,
    writes: Arc<RwLock<()>>,
    switching: AtomicBool,
    quiesced: AtomicBool,
    epochs: watch::Sender<u64>,
    upload: AtomicBool,
    watch_lifecycle: AtomicBool,
    maintenance: AtomicBool,
    subscriptions: SyncMutex<HashMap<String, Weak<Subscription>>>,
}

/// Keeps a plugin fenced from new work until every update participant is ready.
pub(crate) struct UpdateHold {
    host: Arc<Host>,
    writes: Option<OwnedRwLockWriteGuard<()>>,
    token: Option<Uuid>,
    committed: bool,
}

impl UpdateHold {
    pub(crate) fn commit(mut self) {
        // Keep only the write fence until gateway exit. Do not retain Host/Process:
        // their normal Drop must still reap the idle plugin children at shutdown.
        if let Some(writes) = self.writes.take() {
            std::mem::forget(writes);
        }
        self.committed = true;
    }

    pub(crate) async fn resume(mut self) {
        self.release().await;
    }

    async fn release(&mut self) {
        while let Some(token) = self.token {
            let mut slot = self.host.runtime.lock().await;
            let Some(process) = slot.process.as_mut() else {
                self.token = None;
                break;
            };
            // Await the full frame; cancellation must never desynchronize or kill live work.
            let result = process
                .request(
                    "adapter/maintenance",
                    json!({"action":"release","token":token}),
                )
                .await;
            if result
                .as_ref()
                .is_ok_and(|reply| reply["sdk"] == 1 && reply["held"] == false)
            {
                self.token = None;
                break;
            }
            if process.child.try_wait().ok().flatten().is_some() {
                // The already-frozen idle provider exited itself; the normal next read may reopen it.
                slot.process = None;
                self.token = None;
                break;
            }
            eprintln!("Native update: plugin release did not acknowledge; keeping its write fence");
            drop(slot);
            sleep(Duration::from_secs(1)).await;
        }
        self.host.quiesced.store(false, Ordering::Release);
        self.host.epochs.send_modify(|epoch| *epoch += 1);
        self.writes.take();
        self.committed = true;
    }
}

impl Drop for UpdateHold {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let mut release = UpdateHold {
            host: self.host.clone(),
            writes: self.writes.take(),
            token: self.token.take(),
            committed: false,
        };
        self.committed = true;
        tokio::spawn(async move {
            release.release().await;
        });
    }
}

struct Runtime {
    package: Option<Package>,
    process: Option<Process>,
}

impl Runtime {
    async fn stop(&mut self) -> Result<()> {
        if let Some(process) = &mut self.process {
            process.stop().await?;
            self.process = None;
        }
        Ok(())
    }
}

struct Switching<'a> {
    host: &'a Host,
    owns_quiescence: bool,
}

impl Drop for Switching<'_> {
    fn drop(&mut self) {
        if self.owns_quiescence && self.host.quiesced.swap(false, Ordering::AcqRel) {
            self.host.epochs.send_modify(|epoch| *epoch += 1);
        }
        self.host.switching.store(false, Ordering::Release);
    }
}

impl Host {
    pub(crate) fn new(
        id: String,
        name: String,
        package: Option<Package>,
        config: Value,
        directory: PathBuf,
        read_only: bool,
    ) -> Self {
        Self {
            id,
            name,
            config,
            directory,
            read_only,
            runtime: Mutex::new(Runtime {
                package,
                process: None,
            }),
            writes: Arc::new(RwLock::new(())),
            switching: AtomicBool::new(false),
            quiesced: AtomicBool::new(false),
            epochs: watch::channel(0).0,
            upload: AtomicBool::new(false),
            watch_lifecycle: AtomicBool::new(false),
            maintenance: AtomicBool::new(false),
            subscriptions: SyncMutex::new(HashMap::new()),
        }
    }

    pub(crate) async fn supervise(self: Arc<Self>, directory: PathBuf) {
        loop {
            let root = directory.clone();
            let id = self.id.clone();
            let request =
                tokio::task::spawn_blocking(move || Catalog::open(&root)?.next(&id)).await;
            if let Ok(Ok(Some(request))) = request {
                let _ = self.replace(&directory, request).await;
            }
            sleep(Duration::from_millis(500)).await;
        }
    }

    async fn replace(&self, directory: &std::path::Path, request: Switch) -> Result<()> {
        self.switching.store(true, Ordering::Release);
        self.upload.store(false, Ordering::Relaxed);
        let mut switching = Switching {
            host: self,
            owns_quiescence: false,
        };
        let Ok(_drained) = timeout(Duration::from_secs(12), self.writes.write()).await else {
            return self.finish_switch(directory, request, "busy").await;
        };
        self.quiesced.store(true, Ordering::Release);
        switching.owns_quiescence = true;
        self.epochs.send_modify(|epoch| *epoch += 1);
        let Ok(mut slot) = timeout(Duration::from_secs(10), self.runtime.lock()).await else {
            return self.finish_switch(directory, request, "busy").await;
        };
        if slot
            .package
            .as_ref()
            .is_none_or(|package| package.manifest.key() != request.expected)
        {
            return self
                .finish_switch(directory, request, "binding_changed")
                .await;
        }
        if slot.stop().await.is_err() {
            return self
                .finish_switch(directory, request, "shutdown_failed")
                .await;
        }
        if self.initialize(&mut slot, &request.target).await.is_err() {
            if slot.stop().await.is_ok()
                && let Some(previous) = slot.package.clone()
            {
                let _ = self.initialize(&mut slot, &previous).await;
            }
            return self
                .finish_switch(directory, request, "startup_failed")
                .await;
        }
        if let Err(error) = self
            .finish_switch(directory, request.clone(), "applied")
            .await
        {
            slot.stop().await?;
            return Err(error);
        }
        slot.package = Some(request.target);
        Ok(())
    }

    async fn finish_switch(
        &self,
        directory: &std::path::Path,
        request: Switch,
        outcome: &'static str,
    ) -> Result<()> {
        let directory = directory.to_owned();
        let id = self.id.clone();
        tokio::task::spawn_blocking(move || {
            Catalog::open(&directory)?.finish(&request, &id, outcome)
        })
        .await?
    }

    async fn initialize(&self, slot: &mut Runtime, package: &Package) -> Result<()> {
        let directory = self.directory.clone();
        tokio::task::spawn_blocking(move || private_directory(&directory)).await??;
        let process = timeout(Duration::from_secs(4), Process::start(package.clone())).await??;
        let process = slot.process.insert(process);
        let lifecycle = timeout(Duration::from_secs(5), async {
            let mut params = json!({
                "sdk":1,"id":self.id,"name":self.name,"config":self.config,
                "stateDirectory":self.directory,"readOnly":self.read_only,
                "packageVersion":package.manifest.version
            });
            if package.manifest.name == "@agent-remote/adapter-antigravity" {
                // The plugin can be upgraded independently of its host.
                params["hostCapabilities"] = json!({
                    "nextMessageModel":true,
                    "writeInQuestionIds":true,
                    "boundedQuestionResponses":true,
                });
            } else if package.manifest.name == "@agent-remote/adapter-dsh" {
                params["hostCapabilities"] = json!({"writeInQuestionIds":true});
            }
            let result = process.request("adapter/initialize", params).await?;
            ensure!(result["sdk"] == 1, "原生插件 SDK 版本不兼容");
            ensure!(
                self.id == crate::codex_backend::ID
                    || package.manifest.name != crate::codex_backend::PACKAGE
                    || result["scopedCodex"] == true,
                "此 Codex 插件版本不支持具名实例"
            );
            let state = process.request("adapter/status", json!({})).await?;
            ensure!(
                state["info"].is_object() && state["status"].is_object(),
                "原生插件状态无效"
            );
            Ok::<_, anyhow::Error>((
                result["watchLifecycle"] == true,
                result["maintenance"] == true,
            ))
        })
        .await??;
        self.watch_lifecycle.store(lifecycle.0, Ordering::Release);
        self.maintenance.store(lifecycle.1, Ordering::Release);
        process.ready = true;
        Ok(())
    }

    pub(crate) async fn hold_for_update(self: Arc<Self>) -> Result<UpdateHold> {
        ensure!(!self.switching.load(Ordering::Acquire), "插件正在切换版本");
        let writes = self
            .writes
            .clone()
            .try_write_owned()
            .context("等待本机任务完成后更新")?;
        ensure!(!self.switching.load(Ordering::Acquire), "插件正在切换版本");
        self.quiesced.store(true, Ordering::Release);
        let host = self.clone();
        let (send, receive) = oneshot::channel();
        tokio::spawn(async move {
            let mut held = UpdateHold {
                host: host.clone(),
                writes: Some(writes),
                token: None,
                committed: false,
            };
            let result = async {
                let mut slot = host.runtime.try_lock().context("插件正在处理请求")?;
                let Some(process) = slot.process.as_mut() else {
                    return Ok(());
                };
                ensure!(
                    process.ready && host.maintenance.load(Ordering::Acquire),
                    "此插件尚不支持安全更新，请先更新插件"
                );
                let token = Uuid::new_v4();
                held.token = Some(token);
                let reply = process
                    .request(
                        "adapter/maintenance",
                        json!({"action":"hold","token":token}),
                    )
                    .await?;
                ensure!(
                    reply["sdk"] == 1 && reply["held"].is_boolean(),
                    "插件安全更新响应无效"
                );
                if reply["held"] == false {
                    held.token = None;
                    anyhow::bail!("等待插件中的本机任务或通话完成后更新");
                }
                Ok::<(), anyhow::Error>(())
            }
            .await;
            let answer = match result {
                Ok(()) => Ok(held),
                Err(error) => {
                    held.resume().await;
                    Err(error)
                }
            };
            // If the observer timed out, dropping a successful hold resumes the provider.
            // The worker owns the stream and lease until the response settles.
            let _ = send.send(answer);
        });
        timeout(Duration::from_secs(5), receive)
            .await
            .context("等待插件确认安全更新")?
            .context("插件安全更新检查未完成")?
    }

    pub(crate) fn epochs(&self) -> watch::Receiver<u64> {
        self.epochs.subscribe()
    }

    pub(crate) fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub(crate) async fn call(
        &self,
        method: &'static str,
        args: Value,
        limit: Duration,
    ) -> Result<Value> {
        self.call_with_progress(method, args, limit, None).await
    }

    async fn call_with_progress(
        &self,
        method: &'static str,
        args: Value,
        limit: Duration,
        created: Option<&RecordCreated<'_>>,
    ) -> Result<Value> {
        let reply = timeout(limit, async {
            let allowed = || !self.quiesced.load(Ordering::Acquire);
            ensure!(allowed(), "原生插件正在切换版本");
            let mut slot = self.runtime.lock().await;
            ensure!(allowed(), "原生插件正在切换版本");
            if !slot.process.as_ref().is_some_and(|process| process.ready) {
                self.upload.store(false, Ordering::Relaxed);
                slot.stop().await?;
                let package = slot.package.clone().context("未安装已绑定的原生插件")?;
                self.initialize(&mut slot, &package).await?;
            }
            let process = slot.process.as_mut().expect("initialized native plugin");
            // Cancelling a frame leaves its stream unusable. Keep the child until it is reaped.
            process.ready = false;
            let mut reply = process.request_with_progress(method, args, created).await;
            process.ready = reply.as_ref().err().is_none_or(|error| {
                error.is::<Refused>()
                    || error.is::<MissingAttachment>()
                    || error.is::<HistoryUnavailable>()
            });
            if !process.ready {
                self.upload.store(false, Ordering::Relaxed);
                let _ = slot.stop().await;
            }
            if let (Ok(value), Some(package)) = (&mut reply, &slot.package) {
                if method == "adapter/status" && value["info"].is_object() {
                    value["info"]["product"] = json!(package.manifest.product);
                    value["info"]["adapterVersion"] = json!(package.manifest.version);
                    if !value["info"]["version"].is_string() {
                        value["info"]["version"] = json!(package.manifest.version);
                    }
                } else if method == "codex/refresh" && value.is_object() {
                    value["adapterVersion"] = json!(package.manifest.version);
                }
            }
            reply
        })
        .await;
        if reply.is_err() {
            self.upload.store(false, Ordering::Relaxed);
        }
        reply?
    }

    async fn describe(&self) -> Result<Value> {
        let mut reply = self
            .call("adapter/status", json!({}), Duration::from_secs(4))
            .await?;
        ensure!(
            reply["info"].is_object() && reply["status"].is_object(),
            "原生插件状态无效"
        );
        reply["info"]["id"] = json!(self.id);
        reply["info"]["name"] = json!(self.name);
        reply["info"]["profile"] = json!("rust-native-plugin");
        reply["info"]["connected"] = json!(reply["status"]["connected"] == true);
        if self.read_only {
            reply["status"]["writesEnabled"] = json!(false);
            if let Some(capabilities) = reply["status"]["capabilities"].as_object_mut() {
                capabilities
                    .values_mut()
                    .for_each(|enabled| *enabled = json!(false));
            }
            if let Some(capabilities) = reply["info"]["capabilities"].as_object_mut() {
                for (name, capability) in capabilities {
                    if name != "history" {
                        *capability = json!({"state":"unavailable"});
                    }
                }
            }
        }
        self.upload.store(
            reply["status"]["writesEnabled"] == true
                && matches!(
                    reply["info"]["capabilities"]["attachments"]["state"].as_str(),
                    Some("supported" | "experimental")
                ),
            Ordering::Relaxed,
        );
        Ok(reply)
    }

    pub(crate) async fn source(&self, reply: Value) -> Result<Source> {
        let raw = reply["path"].as_str().context("原生插件没有返回附件")?;
        let name = attachment_name(&reply)?;
        let temporary = reply["temporary"] == true;
        let expected = reply
            .get("integrity")
            .filter(|value| !value.is_null())
            .map(|value| -> Result<_> {
                let size = value["size"].as_u64().context("原生插件附件大小无效")?;
                let digest = value["sha256"]
                    .as_str()
                    .filter(|value| {
                        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
                    .context("原生插件附件摘要无效")?;
                Ok((size, digest.to_owned()))
            })
            .transpose()?;
        let root = self.directory.clone();
        let file = root.join(raw);
        tokio::task::spawn_blocking(move || {
            let root = root.canonicalize()?;
            let file = file.canonicalize()?;
            ensure!(file.starts_with(&root), "原生插件附件不在实例状态目录");
            let input = private_file(&file, false)?;
            if temporary {
                ensure!(
                    file.parent() == Some(root.join("transfers").as_path())
                        && file
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| Uuid::parse_str(name).is_ok()),
                    "原生插件临时附件路径无效"
                );
                let _ = fs::remove_file(&file);
            }
            Ok(Source {
                file: input,
                name,
                expected,
            })
        })
        .await?
    }

    async fn follow(&self, id: String, publish: watch::Sender<Option<Arc<View>>>) {
        let mut revision = 0;
        let mut last = None;
        let mut epochs = self.epochs.subscribe();
        let watch_id = Uuid::new_v4();
        loop {
            if publish.is_closed() {
                break;
            }
            let epoch = *epochs.borrow_and_update();
            let value = self
                .call(
                    "adapter/view",
                    json!({"thread":id,"watchId":watch_id}),
                    Duration::from_secs(5),
                )
                .await;
            match value {
                Ok(_) if *epochs.borrow() != epoch => {
                    mark_offline(&publish, &mut revision);
                    last = None;
                    continue;
                }
                Ok(value) if last.as_ref() == Some(&value) => {}
                Ok(value) => {
                    if let Ok(view) = view(&value, &id, revision + 1, self.read_only, epoch) {
                        revision += 1;
                        last = Some(value);
                        publish.send_replace(Some(Arc::new(view)));
                    } else {
                        mark_offline(&publish, &mut revision);
                        last = None;
                    }
                }
                Err(_) => {
                    mark_offline(&publish, &mut revision);
                    last = None;
                }
            }
            tokio::select! {
                _ = publish.closed() => break,
                _ = epochs.changed() => {
                    mark_offline(&publish, &mut revision);
                    last = None;
                }
                _ = sleep(Duration::from_millis(if last.is_some() { 350 } else { 900 })) => {}
            }
        }
        if self.watch_lifecycle.load(Ordering::Acquire) {
            let _ = self
                .call(
                    "adapter/unwatch",
                    json!({"thread":id,"watchId":watch_id}),
                    Duration::from_secs(4),
                )
                .await;
        }
    }
}

#[async_trait]
impl Adapter for Host {
    fn update_host(self: Arc<Self>) -> Option<Arc<Host>> {
        Some(self)
    }
    fn id(&self) -> &str {
        &self.id
    }
    fn admit_write(&self) -> Result<Option<OwnedRwLockReadGuard<()>>> {
        ensure!(
            !self.switching.load(Ordering::Acquire),
            "原生插件正在切换版本"
        );
        let guard = self
            .writes
            .clone()
            .try_read_owned()
            .context("原生插件正在切换版本")?;
        ensure!(
            !self.switching.load(Ordering::Acquire),
            "原生插件正在切换版本"
        );
        Ok(Some(guard))
    }
    fn uploads_enabled(&self) -> bool {
        !self.read_only
            && !self.switching.load(Ordering::Acquire)
            && self.upload.load(Ordering::Relaxed)
    }
    async fn info(&self) -> Value {
        self.describe()
            .await
            .map(|mut state| state["info"].take())
            .unwrap_or_else(|_| {
                json!({
                    "id":self.id,"name":self.name,"product":"native",
                    "connected":false,"profile":"rust-native-plugin","capabilities":{},
                })
            })
    }
    async fn status(&self) -> Value {
        self.describe().await.map(|mut state| state["status"].take()).unwrap_or_else(|_| json!({
            "connected":false,"writesEnabled":false,"reason":"原生插件未连接","capabilities":{},
        }))
    }
    async fn read(&self, method: &str, params: &Value, query: &Value) -> Result<Option<Value>> {
        if !READS.contains(&method) {
            return Ok(None);
        }
        self.call(
            "adapter/read",
            json!({"method":method,"params":params,"query":query}),
            Duration::from_secs(12),
        )
        .await
        .map(|value| (!value.is_null()).then_some(value))
    }
    async fn media(
        &self,
        thread: &str,
        reference: &str,
        from_document: Option<&str>,
    ) -> Result<Media> {
        let mut params = json!({"thread":thread,"reference":reference});
        if let Some(doc) = from_document {
            params["fromDocument"] = json!(doc);
        }
        let reply = self
            .call("adapter/media", params, Duration::from_secs(25))
            .await?;
        if reply["kind"] != "verified-file" {
            return self.source(reply).await.map(Media::Download);
        }
        let id = reply["attachmentId"]
            .as_str()
            .context("原生插件附件标识无效")?;
        let sha256 = crate::history_media::dsh_attachment_digest(id)
            .filter(|digest| reply["sha256"] == *digest)
            .context("原生插件附件摘要无效")?;
        ensure!(
            reference.strip_prefix("dsh-file:") == Some(id),
            "原生插件附件引用不符"
        );
        let size = reply["size"]
            .as_u64()
            .filter(|size| (1..=256 * crate::files::BLOCK as u64).contains(size))
            .context("原生插件附件大小无效")?;
        Ok(Media::VerifiedFile {
            name: attachment_name(&reply)?,
            size,
            attachment_id: id.to_owned(),
            sha256: sha256.to_owned(),
        })
    }
    async fn export_log(&self, thread: &str) -> Result<Source> {
        let reply = self
            .call(
                "adapter/export",
                json!({"thread":thread}),
                Duration::from_secs(25),
            )
            .await?;
        self.source(reply).await
    }
    fn subscribe(self: Arc<Self>, thread: &str) -> Result<Arc<Subscription>> {
        let mut subscriptions = self
            .subscriptions
            .lock()
            .expect("plugin subscriptions poisoned");
        subscriptions.retain(|_, value| value.strong_count() > 0);
        if let Some(watch) = subscriptions.get(thread).and_then(Weak::upgrade) {
            return Ok(watch);
        }
        ensure!(subscriptions.len() < 32, "原生插件订阅过多");
        let (sender, receiver) = watch::channel(None);
        let subscription = Arc::new(Subscription(receiver));
        subscriptions.insert(thread.to_owned(), Arc::downgrade(&subscription));
        drop(subscriptions);
        let thread = thread.to_owned();
        tokio::spawn(async move { self.follow(thread, sender).await });
        Ok(subscription)
    }
    async fn write(
        &self,
        thread: &str,
        request: Uuid,
        action: Write,
        live: Option<Arc<Subscription>>,
        created: &RecordCreated<'_>,
    ) -> Delivery {
        if self.read_only {
            return Delivery::Rejected("原生插件实例只读");
        }
        let creates = matches!(action, Write::Create { .. });
        if !matches!(
            action,
            Write::Create { .. } | Write::Open | Write::Rename { .. }
        ) && !live.is_some_and(|live| {
            live.0
                .borrow()
                .as_ref()
                .is_some_and(|view| live_write_scope(view, &action, *self.epochs.borrow()))
        }) {
            return Delivery::Rejected("原生插件会话尚未同步");
        }
        if matches!(&action, Write::Send { model: Some(_), .. })
            && self.status().await["capabilities"]["nextMessageModel"] != true
        {
            return Delivery::Rejected("当前插件无法为此消息选择模型");
        }
        let acknowledged = AtomicBool::new(false);
        let record = |id: &str| {
            created(id)?;
            acknowledged.store(true, Ordering::Relaxed);
            Ok(())
        };
        let reply = self
            .call_with_progress(
                "adapter/write",
                json!({"thread":thread,"requestId":request,"action":action}),
                action
                    .dispatch_timeout()
                    .saturating_sub(Duration::from_secs(1)),
                creates.then_some(&record),
            )
            .await;
        match reply {
            Ok(value) => {
                let result = value["resultThreadId"].as_str().filter(|id| valid_id(id));
                if creates
                    && let Some(id) = result
                    && created(id).is_err()
                {
                    return Delivery::Uncertain;
                }
                match value["state"].as_str() {
                    Some("completed") if !creates || result.is_some() => {
                        Delivery::Completed(result.filter(|_| creates).map(str::to_owned))
                    }
                    Some("accepted") if !creates => Delivery::Accepted(
                        value["turnId"]
                            .as_str()
                            .filter(|id| valid_id(id))
                            .map(str::to_owned),
                    ),
                    Some("command") if !creates => match (
                        value["commandId"].as_str().filter(|id| valid_id(id)),
                        value["succeeded"].as_bool(),
                    ) {
                        (Some(id), Some(succeeded)) => Delivery::Command {
                            id: id.to_owned(),
                            succeeded,
                        },
                        _ => Delivery::Uncertain,
                    },
                    Some("rejected")
                        if result.is_none() && !acknowledged.load(Ordering::Relaxed) =>
                    {
                        Delivery::Rejected("原生插件拒绝请求")
                    }
                    _ => Delivery::Uncertain,
                }
            }
            Err(_) => Delivery::Uncertain,
        }
    }
}

fn valid_id(id: &str) -> bool {
    (1..=200).contains(&id.encode_utf16().count())
        && !id
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
}

fn attachment_name(value: &Value) -> Result<String> {
    Ok(value["name"]
        .as_str()
        .filter(|name| valid_id(name) && !matches!(*name, "." | ".."))
        .context("原生插件附件名无效")?
        .to_owned())
}

fn view(value: &Value, id: &str, revision: u64, read_only: bool, epoch: u64) -> Result<View> {
    let mut thread = value["thread"].clone();
    ensure!(
        thread["id"] == id && thread["synchronized"].is_boolean(),
        "原生插件会话快照无效"
    );
    thread["revision"] = json!(revision);
    if read_only {
        for key in [
            "owner",
            "canSend",
            "canSteer",
            "canInterrupt",
            "boundedQuestionAvailable",
        ] {
            thread[key] = json!(false);
        }
        thread["requests"] = json!([]);
        thread["pendingRequests"] = json!(0);
    }
    let messages = value["messages"]
        .as_array()
        .filter(|rows| rows.len() <= 500)
        .context("原生插件历史快照无效")?;
    ensure!(
        messages
            .iter()
            .all(|row| row["id"].as_str().is_some_and(valid_id)),
        "原生插件消息标识无效"
    );
    let observations: Vec<_> = value["observations"]
        .as_array()
        .into_iter()
        .flatten()
        .take(1000)
        .filter_map(|item| {
            let request = item["requestId"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok());
            let turn = item["turnId"]
                .as_str()
                .filter(|id| valid_id(id))?
                .to_owned();
            let state = match item["state"].as_str()? {
                "accepted" => "accepted",
                "completed" => "completed",
                "interrupted" => "interrupted",
                "failed" => "failed",
                _ => return None,
            };
            Some(Observation {
                request,
                turn,
                state,
            })
        })
        .collect();
    Ok(View {
        thread,
        messages: messages.clone().into(),
        streamed: value["streamed"]
            .is_object()
            .then(|| value["streamed"].clone()),
        observations: observations.into(),
        #[cfg(feature = "official-plugins")]
        image_limits: value["imageLimits"].clone(),
        #[cfg(feature = "official-plugins")]
        continued_questions: value["continuedQuestions"].clone(),
        plugin_epoch: Some(epoch),
    })
}

fn live_write_scope(view: &View, action: &Write, epoch: u64) -> bool {
    if view.plugin_epoch != Some(epoch) {
        return false;
    }
    if view.thread["synchronized"] == true {
        return true;
    }
    if let Write::Respond(response) = action
        && view.thread["boundedQuestionAvailable"] == true
        && let Some([question]) = view.thread["requests"].as_array().map(Vec::as_slice)
    {
        return response.matches_question(question);
    }
    false
}

fn mark_offline(publish: &watch::Sender<Option<Arc<View>>>, revision: &mut u64) {
    let latest = publish.borrow().clone();
    if let Some(previous) = latest.filter(|view| {
        view.thread["synchronized"] == true || view.thread["boundedQuestionAvailable"] == true
    }) {
        *revision += 1;
        let mut view = (*previous).clone();
        view.thread["revision"] = json!(*revision);
        for key in [
            "synchronized",
            "canSend",
            "canSteer",
            "canInterrupt",
            "boundedQuestionAvailable",
        ] {
            view.thread[key] = json!(false);
        }
        view.thread["requests"] = json!([]);
        view.thread["pendingRequests"] = json!(0);
        view.thread["reason"] = json!("原生插件正在重新连接");
        view.observations = Arc::from([]);
        publish.send_replace(Some(Arc::new(view)));
    }
}

#[cfg(test)]
mod observation_tests {
    use super::*;

    #[test]
    fn retains_failed_native_execution_with_request_correlation() {
        let request = Uuid::new_v4();
        let snapshot = json!({"thread":{"id":"fixture","synchronized":true},"messages":[],
        "observations":[
            {"requestId":request,"turnId":"native-turn","state":"failed"},
            {"requestId":request,"turnId":"native-turn","state":"invented-state"}
        ]});
        let parsed = view(&snapshot, "fixture", 1, false, 1).unwrap();
        assert_eq!(parsed.observations.len(), 1);
        assert_eq!(parsed.observations[0].request, Some(request));
        assert_eq!(parsed.observations[0].state, "failed");
    }

    #[test]
    fn partial_native_view_only_admits_its_live_question_answer() {
        let fingerprint = "a".repeat(64);
        let snapshot = json!({
            "thread":{
                "id":"fixture",
                "synchronized":false,
                "boundedQuestionAvailable":true,
                "requests":[{
                    "kind":"question","actionable":true,"id":"question","turnId":"turn","fingerprint":fingerprint,
                }],
            },
            "messages":[],
        });
        let answer = |fingerprint: &str, form: Value| {
            let mut response = json!({
                "requestId":Uuid::new_v4(),"targetRequestId":"question",
                "expectedTurnId":"turn","expectedFingerprint":fingerprint,
            });
            response
                .as_object_mut()
                .unwrap()
                .extend(form.as_object().unwrap().clone());
            Write::Respond(serde_json::from_value(response).unwrap())
        };
        let reply = answer(&fingerprint, json!({"answers":{"question-0":["yes"]}}));
        let parsed = view(&snapshot, "fixture", 1, false, 2).unwrap();
        assert!(live_write_scope(&parsed, &reply, 2));
        assert!(!live_write_scope(&parsed, &reply, 3));
        assert!(!live_write_scope(
            &parsed,
            &answer(&fingerprint, json!({"decision":"accept"})),
            2,
        ));
        assert!(!live_write_scope(
            &parsed,
            &answer(&"b".repeat(64), json!({"answers":{"question-0":["yes"]}})),
            2,
        ));
        assert!(!live_write_scope(
            &view(&snapshot, "fixture", 1, true, 2).unwrap(),
            &reply,
            2,
        ));
        let (publish, watcher) = watch::channel(Some(Arc::new(parsed)));
        mark_offline(&publish, &mut 1);
        assert!(!live_write_scope(
            watcher.borrow().as_ref().unwrap(),
            &reply,
            2
        ));
    }
}

#[cfg(test)]
mod maintenance_tests {
    use super::*;
    use std::io::{BufRead, Read, Write};

    #[test]
    fn fixture_process() {
        let Ok(mode) = env::var("POCKET_UPDATE_MAINTENANCE_FIXTURE") else {
            return;
        };
        println!("FIXTURE_READY");
        let mut input = std::io::stdin().lock();
        let mut held = None;
        let mut release_attempts = 0;
        loop {
            let mut line = String::new();
            if input.read_line(&mut line).unwrap() == 0 {
                break;
            }
            let length: usize = line
                .trim()
                .strip_prefix("Content-Length: ")
                .unwrap()
                .parse()
                .unwrap();
            line.clear();
            input.read_line(&mut line).unwrap();
            let mut bytes = vec![0; length];
            input.read_exact(&mut bytes).unwrap();
            let request: Value = serde_json::from_slice(&bytes).unwrap();
            let params = &request["params"];
            let response = if params["action"] == "hold" {
                held = params["token"].as_str().map(str::to_owned);
                if mode == "malformed-hold" {
                    json!({"sdk":0,"held":true})
                } else {
                    json!({"sdk":1,"held":true})
                }
            } else {
                assert_eq!(params["token"].as_str(), held.as_deref());
                release_attempts += 1;
                if mode == "release-retry" && release_attempts == 1 {
                    json!({"sdk":1,"held":true})
                } else {
                    fs::write(
                        env::var_os("POCKET_UPDATE_MAINTENANCE_MARKER").unwrap(),
                        "released",
                    )
                    .unwrap();
                    held = None;
                    json!({"sdk":1,"held":false})
                }
            };
            let generation = if mode == "bad-generation" && params["action"] == "hold" {
                json!("invalid")
            } else {
                params["generation"].clone()
            };
            let reply = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":request["id"],"generation":generation,"result":response})).unwrap();
            print!("Content-Length: {}\r\n\r\n", reply.len());
            std::io::stdout().write_all(&reply).unwrap();
            std::io::stdout().flush().unwrap();
        }
    }

    async fn provider(mode: &str, marker: &std::path::Path) -> Arc<Host> {
        let mut command = Command::new(env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "plugin_host::maintenance_tests::fixture_process",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("POCKET_UPDATE_MAINTENANCE_FIXTURE", mode)
            .env("POCKET_UPDATE_MAINTENANCE_MARKER", marker);
        let mut process = Process::spawn(command).unwrap();
        loop {
            let mut line = String::new();
            process.output.read_line(&mut line).await.unwrap();
            if line.contains("FIXTURE_READY") {
                break;
            }
        }
        process.ready = true;
        let host = Arc::new(Host::new(
            "fixture".into(),
            "fixture".into(),
            None,
            json!({}),
            marker.parent().unwrap().into(),
            false,
        ));
        host.runtime.lock().await.process = Some(process);
        host.maintenance.store(true, Ordering::Release);
        host
    }

    #[tokio::test]
    async fn release_ack_is_required_before_reopening_writes() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("released");
        let host = provider("release-retry", &marker).await;
        let held = host.clone().hold_for_update().await.unwrap();
        let resume = tokio::spawn(held.resume());
        sleep(Duration::from_millis(150)).await;
        assert!(host.quiesced.load(Ordering::Acquire));
        assert!(host.writes.clone().try_read_owned().is_err());
        assert!(!marker.exists());
        timeout(Duration::from_secs(4), resume)
            .await
            .unwrap()
            .unwrap();
        assert!(marker.exists());
        assert!(!host.quiesced.load(Ordering::Acquire));
        assert!(host.writes.clone().try_read_owned().is_ok());
    }

    #[tokio::test]
    async fn uncertain_hold_keeps_token_until_provider_acknowledges_release() {
        for mode in ["malformed-hold", "bad-generation"] {
            let directory = tempfile::tempdir().unwrap();
            let marker = directory.path().join("released");
            let host = provider(mode, &marker).await;
            assert!(host.clone().hold_for_update().await.is_err());
            assert!(
                marker.exists(),
                "a provider which may have frozen must receive its original release token"
            );
            assert!(!host.quiesced.load(Ordering::Acquire));
            assert!(host.writes.clone().try_read_owned().is_ok());
        }
    }

    #[tokio::test]
    async fn old_plugin_without_maintenance_fails_closed_without_stopping_it() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("released");
        let host = provider("unused", &marker).await;
        host.maintenance.store(false, Ordering::Release);
        let pid = host
            .runtime
            .lock()
            .await
            .process
            .as_ref()
            .unwrap()
            .child
            .id();
        assert!(
            host.clone()
                .hold_for_update()
                .await
                .err()
                .unwrap()
                .to_string()
                .contains("尚不支持安全更新")
        );
        let mut slot = host.runtime.lock().await;
        assert_eq!(slot.process.as_ref().unwrap().child.id(), pid);
        assert!(
            slot.process
                .as_mut()
                .unwrap()
                .child
                .try_wait()
                .unwrap()
                .is_none()
        );
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn unrelated_switch_drop_cannot_clear_update_fence_and_commit_does_not_retain_host() {
        let directory = tempfile::tempdir().unwrap();
        let host = Arc::new(Host::new(
            "fixture".into(),
            "fixture".into(),
            None,
            json!({}),
            directory.path().into(),
            false,
        ));
        let held = host.clone().hold_for_update().await.unwrap();
        drop(Switching {
            host: &host,
            owns_quiescence: false,
        });
        assert!(host.quiesced.load(Ordering::Acquire));
        let writes = host.writes.clone();
        let weak = Arc::downgrade(&host);
        drop(host);
        held.commit();
        assert!(
            weak.upgrade().is_none(),
            "committing must not orphan a retained plugin Process"
        );
        assert!(
            writes.try_read_owned().is_err(),
            "the write fence must survive until gateway process exit"
        );
    }
}
