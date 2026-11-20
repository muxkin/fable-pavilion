use crate::{
    antigravity::Backend as Antigravity,
    codex_backend,
    codex_live::{Outcome, Thread},
    codex_service::{Local, Options, thread_id},
    codex_voice::{Failure as VoiceFailure, Session as VoiceSession},
    dsh::Dsh,
    files::BLOCK,
    history_media::Source,
    plugins::{Adapter, Delivery, Media, Subscription, Write},
    state::{private_directory, private_file},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    future::Future,
    io::{self, BufRead, Read, Seek, Write as IoWrite},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{task::JoinHandle, time::timeout};
use uuid::Uuid;

const MAX_FRAME: usize = 8 * 1024 * 1024;

trait Instance: Sized {
    const SCOPED_CODEX: bool = false;

    fn initialize(params: &Value) -> Result<Self>;
    async fn request(&mut self, method: &str, params: &Value, id: &Value) -> Result<Value>;
}

pub(crate) async fn run_dsh() -> Result<()> {
    run::<Server<Dsh>>().await
}

pub(crate) async fn run_antigravity() -> Result<()> {
    run::<Server<Antigravity>>().await
}

pub(crate) async fn run_codex() -> Result<()> {
    run::<CodexServer>().await
}

async fn run<T: Instance>() -> Result<()> {
    let mut input = io::stdin().lock();
    let mut server: Option<T> = None;
    while let Some(request) = read(&mut input)? {
        let method = field(&request, "method")?;
        let params = &request["params"];
        ensure!(
            request["jsonrpc"] == "2.0"
                && request["id"].is_string()
                && params["generation"].is_string(),
            "原生插件宿主请求无效"
        );
        let result = match method {
            "adapter/check" if params["sdk"] == 1 => Ok(json!({"sdk":1})),
            "adapter/initialize" if server.is_none() => T::initialize(params).map(|ready| {
                server = Some(ready);
                json!({"sdk":1,"watchLifecycle":true,"scopedCodex":T::SCOPED_CODEX,"maintenance":true})
            }),
            _ => match &mut server {
                Some(server) => server.request(method, params, &request["id"]).await,
                None => anyhow::bail!("原生插件尚未初始化"),
            },
        };
        let mut response =
            json!({"jsonrpc":"2.0","id":request["id"],"generation":params["generation"]});
        match result {
            Ok(result) => response["result"] = result,
            Err(error) => {
                let (code, message) = if error.is::<crate::history_media::MissingAttachment>() {
                    (-32004, "附件不存在")
                } else if error.is::<crate::history_media::HistoryUnavailable>() {
                    (-32005, "无法读取本机历史记录")
                } else {
                    (-32000, "原生插件请求失败")
                };
                response["error"] = json!({"code": code, "message": message});
            }
        }
        send(&response)?;
    }
    Ok(())
}

/// Product construction and maintenance hooks remain private to the plugin
/// process. Every ordinary Adapter shares the same framed SDK dispatch.
trait PluginAdapter: Adapter + Sized {
    fn initialize(params: &Value) -> Result<Self>;

    fn hold_maintenance(&self, _token: Uuid) -> Result<bool> {
        Ok(true)
    }

    fn release_maintenance(&self, _token: Uuid) -> Result<()> {
        Ok(())
    }
}

impl PluginAdapter for Dsh {
    fn initialize(params: &Value) -> Result<Self> {
        let config = &params["config"];
        Self::new(
            field(params, "id")?.to_owned(),
            field(params, "name")?.to_owned(),
            field(config, "url")?,
            config["version"].as_str().unwrap_or("unknown").to_owned(),
            config["token"].as_str().unwrap_or_default().to_owned(),
            params["readOnly"] == true,
            params["hostCapabilities"]["writeInQuestionIds"] == true,
        )
    }

    fn hold_maintenance(&self, token: Uuid) -> Result<bool> {
        Dsh::hold_maintenance(self, token)
    }

    fn release_maintenance(&self, token: Uuid) -> Result<()> {
        Dsh::release_maintenance(self, token)
    }
}

impl PluginAdapter for Antigravity {
    fn initialize(params: &Value) -> Result<Self> {
        Self::from_config(
            field(params, "id")?.to_owned(),
            field(params, "name")?.to_owned(),
            &params["config"],
            params["readOnly"] == true,
            &params["hostCapabilities"],
        )
    }
}

struct Server<A: PluginAdapter> {
    adapter: Arc<A>,
    directory: PathBuf,
    watches: HashMap<String, (Uuid, Arc<Subscription>)>,
    maintenance: Option<Uuid>,
    next_message_model: bool,
}

impl<A: PluginAdapter> Instance for Server<A> {
    fn initialize(params: &Value) -> Result<Self> {
        Self::new(params)
    }
    async fn request(&mut self, method: &str, params: &Value, id: &Value) -> Result<Value> {
        self.dispatch(method, params, id).await
    }
}

impl<A: PluginAdapter> Server<A> {
    fn new(params: &Value) -> Result<Self> {
        ensure!(params["sdk"] == 1, "原生插件 SDK 版本不兼容");
        let directory = PathBuf::from(field(params, "stateDirectory")?);
        ensure!(directory.is_absolute(), "原生插件状态目录无效");
        private_directory(&directory)?;
        ensure!(
            crate::plugins::valid_instance_id(field(params, "id")?),
            "插件实例标识无效"
        );
        let adapter = A::initialize(params)?;
        Ok(Self {
            adapter: Arc::new(adapter),
            directory,
            watches: HashMap::new(),
            maintenance: None,
            next_message_model: params["hostCapabilities"]["nextMessageModel"] == true,
        })
    }

    async fn dispatch(&mut self, method: &str, params: &Value, frame: &Value) -> Result<Value> {
        if method == "adapter/maintenance" {
            return self.maintain(params);
        }
        ensure!(
            self.maintenance.is_none() || method != "adapter/write",
            "插件正在维护，暂不接受新操作"
        );
        match method {
            "adapter/status" => {
                let (info, mut status) = tokio::join!(self.adapter.info(), self.adapter.status());
                if !self.next_message_model
                    && let Some(capabilities) = status["capabilities"].as_object_mut()
                {
                    capabilities.remove("nextMessageModel");
                }
                Ok(json!({"info":info,"status":status}))
            }
            "adapter/read" => Ok(self
                .adapter
                .read(
                    field(params, "method")?,
                    &params["params"],
                    &params["query"],
                )
                .await?
                .unwrap_or_default()),
            "adapter/view" => self.view(params),
            "adapter/unwatch" => {
                let thread = field(params, "thread")?;
                let watch = Uuid::parse_str(field(params, "watchId")?)?;
                if self
                    .watches
                    .get(thread)
                    .is_some_and(|(current, _)| *current == watch)
                {
                    self.watches.remove(thread);
                }
                Ok(json!({}))
            }
            "adapter/write" => self.write(params, frame).await,
            "adapter/media" => {
                let media = self
                    .adapter
                    .media(field(params, "thread")?, field(params, "reference")?)
                    .await?;
                match media {
                    Media::Download(source) => stage(&self.directory, source).await,
                    Media::VerifiedFile {
                        name,
                        size,
                        attachment_id,
                        sha256,
                    } => Ok(
                        json!({"kind":"verified-file","name":name,"size":size,"attachmentId":attachment_id,"sha256":sha256}),
                    ),
                }
            }
            "adapter/export" => {
                stage(
                    &self.directory,
                    self.adapter.export_log(field(params, "thread")?).await?,
                )
                .await
            }
            _ => anyhow::bail!("原生插件方法无效"),
        }
    }

    fn maintain(&mut self, params: &Value) -> Result<Value> {
        let token = Uuid::parse_str(field(params, "token")?)?;
        match field(params, "action")? {
            "hold" => {
                if let Some(current) = self.maintenance {
                    ensure!(current == token, "维护令牌不符");
                    return Ok(json!({"sdk":1,"held":true}));
                }
                if !self.adapter.hold_maintenance(token)? {
                    return Ok(json!({"sdk":1,"held":false,"reason":"pending"}));
                }
                self.maintenance = Some(token);
                Ok(json!({"sdk":1,"held":true}))
            }
            "release" => {
                ensure!(self.maintenance == Some(token), "维护令牌不符");
                self.adapter.release_maintenance(token)?;
                self.maintenance = None;
                Ok(json!({"sdk":1,"held":false}))
            }
            _ => anyhow::bail!("维护操作无效"),
        }
    }

    fn view(&mut self, params: &Value) -> Result<Value> {
        let thread = field(params, "thread")?;
        let watch = Uuid::parse_str(field(params, "watchId")?)?;
        if self
            .watches
            .get(thread)
            .is_none_or(|(current, _)| *current != watch)
        {
            let subscription = self.adapter.clone().subscribe(thread)?;
            self.watches
                .insert(thread.to_owned(), (watch, subscription));
        }
        let (_, subscription) = self.watches.get(thread).expect("created subscription");
        let view = subscription.0.borrow();
        let Some(view) = &*view else {
            return Ok(Value::Null);
        };
        let messages = &view.messages[view.messages.len().saturating_sub(500)..];
        let observations: Vec<_> = view
            .observations
            .iter()
            .map(|row| {
                json!({
                    "requestId":row.request,"turnId":row.turn,"state":row.state,
                })
            })
            .collect();
        Ok(json!({
            "thread":view.thread,"messages":messages,"streamed":view.streamed,
            "observations":observations,"imageLimits":view.image_limits,
            "continuedQuestions":view.continued_questions,
        }))
    }

    async fn write(&self, params: &Value, frame: &Value) -> Result<Value> {
        let thread = field(params, "thread")?;
        let request = Uuid::parse_str(field(params, "requestId")?)?;
        let action: Write = serde_json::from_value(params["action"].clone())?;
        if matches!(&action, Write::Send { model: Some(_), .. }) && !self.next_message_model {
            return Ok(json!({"state":"rejected","reason":"当前宿主不支持消息模型"}));
        }
        match &action {
            Write::Send {
                skills, plugin_ids, ..
            }
            | Write::Create {
                skills, plugin_ids, ..
            } => {
                self.adapter.validate_selection(skills, plugin_ids)?;
            }
            _ => {}
        }
        let live = self.watches.get(thread).map(|(_, live)| live.clone());
        let created = |id: &str| {
            send(&json!({
                "jsonrpc":"2.0","method":"adapter/threadCreated","generation":params["generation"],
                "params":{"requestId":frame,"threadId":id},
            }))
        };
        Ok(
            match self
                .adapter
                .write(thread, request, action, live, &created)
                .await
            {
                Delivery::Accepted(turn) => json!({"state":"accepted","turnId":turn}),
                Delivery::Completed(thread) => json!({"state":"completed","resultThreadId":thread}),
                Delivery::Command { id, succeeded } => {
                    json!({"state":"command","commandId":id,"succeeded":succeeded})
                }
                Delivery::Rejected(_) => json!({"state":"rejected"}),
                Delivery::Uncertain => json!({"state":"uncertain"}),
            },
        )
    }
}

struct CodexServer {
    id: String,
    local: Option<Arc<Local>>,
    options: Options,
    read_only: bool,
    directory: PathBuf,
    watches: HashMap<Uuid, (Uuid, Arc<Thread>)>,
    jobs: HashMap<Uuid, (Instant, JoinHandle<Outcome>)>,
    voice: Option<VoiceSession>,
    maintenance: Option<Uuid>,
}

impl Instance for CodexServer {
    const SCOPED_CODEX: bool = true;

    fn initialize(params: &Value) -> Result<Self> {
        Self::new(params)
    }
    async fn request(&mut self, method: &str, params: &Value, _id: &Value) -> Result<Value> {
        self.dispatch(method, params).await
    }
}

impl CodexServer {
    fn new(params: &Value) -> Result<Self> {
        ensure!(params["sdk"] == 1, "原生插件 SDK 版本不兼容");
        let directory = PathBuf::from(field(params, "stateDirectory")?);
        ensure!(directory.is_absolute(), "原生插件状态目录无效");
        private_directory(&directory)?;
        let id = field(params, "id")?;
        ensure!(crate::plugins::valid_instance_id(id), "插件实例标识无效");
        let options: Options = serde_json::from_value(params["config"].clone())?;
        let read_only = params["readOnly"] == true;
        let local = match Local::open(&options, read_only, id != codex_backend::ID) {
            Ok(local) => Some(Arc::new(local)),
            Err(error) if options.explicit => return Err(error),
            _ => None,
        };
        Ok(Self {
            id: id.to_owned(),
            local,
            options,
            read_only,
            directory,
            watches: HashMap::new(),
            jobs: HashMap::new(),
            voice: None,
            maintenance: None,
        })
    }

    fn live(&self, params: &Value, thread: Uuid) -> Option<&Arc<Thread>> {
        let watch = params["watchId"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())?;
        let (target, live) = self.watches.get(&watch)?;
        (*target == thread).then_some(live)
    }

    fn subscribe(&mut self, params: &Value, thread: Uuid) -> Result<Option<Arc<Thread>>> {
        let watch = thread_id(&params["watchId"])?;
        if let Some((target, live)) = self.watches.get(&watch) {
            ensure!(*target == thread, "Codex 订阅会话不符");
            return Ok(Some(live.clone()));
        }
        ensure!(self.watches.len() < 192, "Codex 订阅过多");
        let live = self
            .local
            .as_ref()
            .and_then(|local| local.subscribe(thread));
        if let Some(live) = &live {
            self.watches.insert(watch, (thread, live.clone()));
        }
        Ok(live)
    }

    async fn dispatch(&mut self, method: &str, params: &Value) -> Result<Value> {
        if method == "adapter/maintenance" {
            return self.maintain(params);
        }
        ensure!(
            self.maintenance.is_none()
                || !matches!(
                    method,
                    "codex/manage" | "codex/execute" | "codex/usage/reset" | "codex/voice/start"
                ),
            "插件正在维护，暂不接受新操作"
        );
        match method {
            "adapter/status" => {
                let available = self
                    .local
                    .as_ref()
                    .map(|local| local.availability())
                    .unwrap_or_default();
                return Ok(json!({
                    "info":codex_backend::info(available, false).unwrap_or_else(|| json!({})),
                    "status":codex_backend::status(available, false),
                }));
            }
            "codex/refresh" => {
                if self.local.is_none() {
                    // The adapter can start at login before Codex has initialized its data.
                    self.local =
                        Local::open(&self.options, self.read_only, self.id != codex_backend::ID)
                            .ok()
                            .map(Arc::new);
                }
                let available = match &self.local {
                    Some(local) => local.refresh().await,
                    None => Default::default(),
                };
                return Ok(json!({"availability":available}));
            }
            "codex/view" => {
                let thread = thread_id(&params["thread"])?;
                let live = self.subscribe(params, thread)?;
                let view = live.and_then(|live| live.view.borrow().clone());
                if let Some(view) = &view
                    && params["known"] == json!(view.mark())
                {
                    return Ok(json!({"unchanged":true}));
                }
                return Ok(serde_json::to_value(view.as_deref())?);
            }
            "codex/unwatch" => {
                let watch = thread_id(&params["watchId"])?;
                let thread = thread_id(&params["thread"])?;
                if self
                    .watches
                    .get(&watch)
                    .is_some_and(|(id, _)| *id == thread)
                {
                    self.watches.remove(&watch);
                }
                return Ok(json!({}));
            }
            "codex/manage" => {
                let thread = field(params, "thread")?.to_owned();
                let live = if params["watchId"].is_null() {
                    None
                } else {
                    self.subscribe(params, Uuid::parse_str(&thread)?)?
                };
                let local = self.local.clone().context("尚未配置 Codex")?;
                let id = thread_id(&params["request"])?;
                let change = serde_json::from_value(params["change"].clone())?;
                return self.start_job(id, Duration::from_secs(70), async move {
                    local.manage(id, change, thread, live).await
                });
            }
            "codex/execute" => {
                let thread = thread_id(&params["thread"])?;
                let id = thread_id(&params["request"])?;
                let action = serde_json::from_value(params["action"].clone())?;
                let live = self.live(params, thread).cloned();
                return self.start_job(id, Duration::from_secs(35), async move {
                    Local::execute(live.as_deref(), id, action).await
                });
            }
            "codex/result" => {
                let id = thread_id(&params["request"])?;
                let (_, task) = self.jobs.get(&id).context("Codex 操作结果不存在")?;
                if !task.is_finished() {
                    return Ok(Value::Null);
                }
                let (_, task) = self.jobs.remove(&id).expect("finished Codex job");
                return Ok(serde_json::to_value(
                    task.await.unwrap_or(Outcome::Uncertain),
                )?);
            }
            _ => {}
        }
        let Some(local) = &self.local else {
            return Ok(Value::Null);
        };
        match method {
            "codex/usage/reset" => {
                let request = thread_id(&params["request"])?;
                Ok(match local.reset_usage(&params["thread"], request).await {
                    Ok(result) => json!({"reset":result}),
                    Err(error) => json!({"error":error}),
                })
            }
            "codex/voice/start" => {
                let thread = thread_id(&params["thread"])?;
                let session = thread_id(&params["session"])?;
                let sdp = field(params, "sdp")?;
                if let Some(active) = &self.voice
                    && !active.finished()
                {
                    if active.thread == thread && active.id == session {
                        return Ok(json!({"ok":true}));
                    }
                    return Ok(json!({"error":"另一台配对设备正在使用 Codex 语音，请稍后重试"}));
                }
                match local.start_voice(thread, session, sdp) {
                    Ok(voice) => {
                        self.voice = Some(voice);
                        Ok(json!({"ok":true}))
                    }
                    Err(error) => {
                        let message = error
                            .downcast_ref::<VoiceFailure>()
                            .map_or("Codex 语音无法启动", |failure| failure.0);
                        Ok(json!({"error":message}))
                    }
                }
            }
            "codex/voice/poll" | "codex/voice/stop" => {
                let thread = thread_id(&params["thread"])?;
                let session = thread_id(&params["session"])?;
                let active = self
                    .voice
                    .as_mut()
                    .filter(|active| active.thread == thread && active.id == session);
                if method == "codex/voice/stop" {
                    if active.is_some() {
                        self.voice = None;
                    }
                    return Ok(json!({"ok":true}));
                }
                let Some(active) = active else {
                    return Ok(json!({"events":[],"done":true}));
                };
                let result = active.poll();
                if result["done"] == true {
                    self.voice = None;
                }
                Ok(result)
            }
            "codex/read" => {
                let args = &params["params"];
                let live = thread_id(&args["id"])
                    .ok()
                    .and_then(|id| self.live(params, id));
                Ok(local
                    .read(
                        field(params, "method")?,
                        args,
                        &params["query"],
                        live.map(Arc::as_ref),
                    )
                    .await?
                    .unwrap_or_default())
            }
            "codex/selectTools" => {
                let thread = thread_id(&params["thread"])?;
                let live = self.live(params, thread).map(Arc::as_ref);
                let skills: Vec<String> = serde_json::from_value(params["skills"].clone())?;
                let plugins: Vec<String> = serde_json::from_value(params["plugins"].clone())?;
                Ok(json!(
                    local.select_tools(thread, live, &skills, &plugins).await?
                ))
            }
            "codex/media" => {
                let thread = thread_id(&params["thread"])?;
                let source = local
                    .media(
                        self.id.clone(),
                        thread,
                        field(params, "device")?.to_owned(),
                        field(params, "reference")?.to_owned(),
                        self.live(params, thread).map(Arc::as_ref),
                    )
                    .await?;
                stage(&self.directory, source).await
            }
            _ => anyhow::bail!("原生 Codex 插件方法无效"),
        }
    }

    fn maintain(&mut self, params: &Value) -> Result<Value> {
        let token = Uuid::parse_str(field(params, "token")?)?;
        match field(params, "action")? {
            "hold" => {
                if let Some(current) = self.maintenance {
                    ensure!(current == token, "维护令牌不符");
                    return Ok(json!({"sdk":1,"held":true}));
                }
                // The stdio request loop holds &mut self across dispatch. No owned operation
                // can start between this check and publishing the fence below.
                if self.jobs.values().any(|(_, task)| !task.is_finished()) {
                    return Ok(json!({"sdk":1,"held":false,"reason":"native-execution"}));
                }
                if self.voice.as_ref().is_some_and(|voice| !voice.finished()) {
                    return Ok(json!({"sdk":1,"held":false,"reason":"voice"}));
                }
                self.maintenance = Some(token);
                Ok(json!({"sdk":1,"held":true}))
            }
            "release" => {
                ensure!(self.maintenance == Some(token), "维护令牌不符");
                self.maintenance = None;
                Ok(json!({"sdk":1,"held":false}))
            }
            _ => anyhow::bail!("维护操作无效"),
        }
    }

    fn start_job(
        &mut self,
        id: Uuid,
        limit: Duration,
        work: impl Future<Output = Outcome> + Send + 'static,
    ) -> Result<Value> {
        ensure!(self.maintenance.is_none(), "插件正在维护，暂不接受新操作");
        self.jobs
            .retain(|_, (started, _)| started.elapsed() < Duration::from_secs(120));
        ensure!(
            self.jobs.len() < 64 && !self.jobs.contains_key(&id),
            "Codex 操作已存在或过多"
        );
        let task =
            tokio::spawn(async move { timeout(limit, work).await.unwrap_or(Outcome::Uncertain) });
        self.jobs.insert(id, (Instant::now(), task));
        Ok(json!({"started":true}))
    }
}

async fn stage(directory: &Path, mut source: Source) -> Result<Value> {
    let directory = directory.join("transfers");
    tokio::task::spawn_blocking(move || {
        let length = source.file.metadata()?.len();
        ensure!(
            (1..=256 * BLOCK as u64).contains(&length),
            "原生插件附件大小无效"
        );
        private_directory(&directory)?;
        for entry in fs::read_dir(&directory)?.filter_map(Result::ok) {
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| Uuid::parse_str(name).is_ok())
                && entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry
                    .metadata()
                    .and_then(|info| info.modified())
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age > Duration::from_secs(600))
            {
                let _ = fs::remove_file(entry.path());
            }
        }
        let path = directory.join(Uuid::new_v4().to_string());
        let result = (|| -> Result<Value> {
            let mut output = private_file(&path, true)?;
            source.file.rewind()?;
            ensure!(
                io::copy(&mut source.file.take(length + 1), &mut output)? == length,
                "原生插件附件已变化"
            );
            let integrity = source
                .expected
                .map(|(size, digest)| json!({"size":size,"sha256":digest}));
            Ok(json!({"path":path,"name":source.name,"temporary":true,"integrity":integrity}))
        })();
        if result.is_err() {
            let _ = fs::remove_file(path);
        }
        result
    })
    .await?
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .context("原生插件请求字段无效")
}

fn read(input: &mut impl BufRead) -> Result<Option<Value>> {
    let mut header = Vec::new();
    if (&mut *input).take(128).read_until(b'\n', &mut header)? == 0 {
        return Ok(None);
    }
    let size: usize = std::str::from_utf8(&header)?
        .strip_prefix("Content-Length: ")
        .and_then(|value| value.strip_suffix("\r\n"))
        .context("原生插件请求帧无效")?
        .parse()?;
    ensure!((1..=MAX_FRAME).contains(&size), "原生插件请求过大");
    let mut separator = [0; 2];
    input.read_exact(&mut separator)?;
    ensure!(&separator == b"\r\n", "原生插件请求帧无效");
    let mut body = vec![0; size];
    input.read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body)?))
}

fn send(value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!((1..=MAX_FRAME).contains(&bytes.len()), "原生插件响应过大");
    let mut output = io::stdout().lock();
    write!(output, "Content-Length: {}\r\n\r\n", bytes.len())?;
    output.write_all(&bytes)?;
    output.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_codex(root: &Path) -> Result<CodexServer> {
        CodexServer::new(&json!({
            "sdk":1, "stateDirectory":root.join("adapter"), "id":codex_backend::ID,
            "readOnly":true, "config":{"home":root.join("absent-codex"), "explicit":false}
        }))
    }

    #[tokio::test]
    async fn maintenance_fences_jobs_and_rejects_unmatched_tokens() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut server = synthetic_codex(root.path())?;
        let token = Uuid::new_v4();
        let hold = json!({"action":"hold","token":token});
        let request = Uuid::new_v4();
        let (finish, finished) = tokio::sync::oneshot::channel();
        server.start_job(request, Duration::from_secs(10), async move {
            let _ = finished.await;
            Outcome::Accepted("already-owned-by-desktop".into())
        })?;
        assert_eq!(
            server.maintain(&hold)?,
            json!({"sdk":1,"held":false,"reason":"native-execution"})
        );
        assert!(server.maintenance.is_none());
        finish.send(()).unwrap();
        while !server.jobs[&request].1.is_finished() {
            tokio::task::yield_now().await;
        }
        assert_eq!(server.maintain(&hold)?, json!({"sdk":1,"held":true}));
        assert_eq!(server.maintain(&hold)?["held"], true);
        // A completed accepted job does not keep an external desktop task in the gate.
        assert_eq!(server.jobs.len(), 1);
        for method in [
            "codex/manage",
            "codex/execute",
            "codex/voice/start",
            "codex/usage/reset",
        ] {
            assert!(server.dispatch(method, &Value::Null).await.is_err());
        }
        assert!(
            server
                .start_job(Uuid::new_v4(), Duration::from_secs(1), async {
                    Outcome::Completed(None)
                })
                .is_err()
        );
        assert!(
            server
                .maintain(&json!({"action":"release","token":Uuid::new_v4()}))
                .is_err()
        );
        assert!(
            server
                .maintain(&json!({"action":"hold","token":Uuid::new_v4()}))
                .is_err()
        );
        assert_eq!(server.maintenance, Some(token));
        assert_eq!(
            server.maintain(&json!({"action":"release","token":token}))?,
            json!({"sdk":1,"held":false})
        );
        assert!(
            server
                .start_job(Uuid::new_v4(), Duration::from_secs(1), async {
                    Outcome::Completed(None)
                })
                .is_ok()
        );
        Ok(())
    }

    #[tokio::test]
    async fn maintenance_waits_for_the_actual_voice_event_producer() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut server = synthetic_codex(root.path())?;
        let (voice, producer) = VoiceSession::synthetic();
        server.voice = Some(voice);
        let hold = json!({"action":"hold","token":Uuid::new_v4()});
        assert_eq!(
            server.maintain(&hold)?,
            json!({"sdk":1,"held":false,"reason":"voice"})
        );
        assert!(server.maintenance.is_none());
        drop(producer);
        assert_eq!(server.maintain(&hold)?["held"], true);
        Ok(())
    }

    #[tokio::test]
    async fn dsh_maintenance_does_not_start_a_connection_and_fences_writes() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut server = Server::<Dsh>::new(&json!({
            "sdk":1, "stateDirectory":root.path().join("adapter"), "id":"fixture", "name":"Fixture",
            "readOnly":true, "config":{"url":"http://127.0.0.1:9", "token":""}
        }))?;
        let token = Uuid::new_v4();
        assert_eq!(
            server.maintain(&json!({"action":"hold","token":token}))?["held"],
            true
        );
        assert!(
            server
                .dispatch("adapter/write", &Value::Null, &Value::Null)
                .await
                .is_err()
        );
        assert!(
            server
                .maintain(&json!({"action":"release","token":Uuid::new_v4()}))
                .is_err()
        );
        assert_eq!(
            server.maintain(&json!({"action":"release","token":token}))?["held"],
            false
        );
        Ok(())
    }

    #[tokio::test]
    async fn antigravity_uses_shared_status_and_maintenance_without_starting_the_agent()
    -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut server = Server::<Antigravity>::new(&json!({
            "sdk":1,"stateDirectory":root.path().join("adapter"),
            "id":"antigravity-fixture","name":"Fixture Antigravity",
            "readOnly":true,"config":{"home":root.path().join("absent-antigravity")}
        }))?;
        let status = server
            .dispatch("adapter/status", &json!({}), &Value::Null)
            .await?;
        assert_eq!(status["info"]["id"], "antigravity-fixture");
        assert_eq!(status["info"]["name"], "Fixture Antigravity");
        assert_eq!(status["info"]["product"], "antigravity");
        assert_eq!(status["status"]["writesEnabled"], false);
        assert!(!root.path().join("absent-antigravity").exists());

        let token = Uuid::new_v4();
        assert_eq!(
            server.maintain(&json!({"action":"hold","token":token}))?["held"],
            true
        );
        assert_eq!(
            server.maintain(&json!({"action":"hold","token":token}))?["held"],
            true
        );
        assert!(
            server
                .dispatch("adapter/write", &Value::Null, &Value::Null)
                .await
                .is_err()
        );
        assert!(
            server
                .maintain(&json!({"action":"release","token":Uuid::new_v4()}))
                .is_err()
        );
        assert_eq!(
            server.maintain(&json!({"action":"release","token":token}))?["held"],
            false
        );
        assert!(
            server
                .dispatch("GetAllCascadeTrajectories", &Value::Null, &Value::Null)
                .await
                .is_err()
        );
        Ok(())
    }

    #[tokio::test]
    async fn recovers_when_codex_creates_its_database_after_adapter_startup() -> Result<()> {
        let root = tempfile::tempdir()?;
        let home = root.path().join("codex");
        let mut server = CodexServer::new(&json!({
            "sdk":1, "stateDirectory":root.path().join("adapter"), "id":codex_backend::ID,
            "readOnly":true, "config":{"home":home, "explicit":false}
        }))?;
        assert_eq!(
            server.dispatch("codex/refresh", &Value::Null).await?["availability"]["history"],
            false
        );
        std::fs::create_dir(&home)?;
        rusqlite::Connection::open(home.join("state_5.sqlite"))?.execute_batch(
            "CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, archived INTEGER,
                                   rollout_path TEXT, updated_at_ms INTEGER);",
        )?;
        let status = server.dispatch("codex/refresh", &Value::Null).await?;
        assert_eq!(status["availability"]["history"], true);
        assert_eq!(status["availability"]["desktop"], false);
        Ok(())
    }
}
