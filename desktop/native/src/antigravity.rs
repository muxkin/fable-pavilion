//! Antigravity App compatibility adapter. Only the enumerated, locally verified
//! LanguageServerService methods are reachable; credentials never leave loopback.
use crate::plugins::{
    Adapter, Delivery, Media, Observation, RecordCreated, Subscription, View, Write,
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    fmt, fs,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use uuid::Uuid;

mod adapter;
mod export;
mod history;
mod interactions;
mod media;
mod plugin_selection;
mod projection;
mod queue;
mod steps;
mod stream;
#[cfg(test)]
mod tests;
use projection::*;
use steps::{activity_state, messages};

const SERVICE: &str = "exa.language_server_pb.LanguageServerService";
const MAX_RESPONSE: usize = 32 * 1024 * 1024;
const PAGE: usize = 100;
const QUESTION_RECEIPT_TIMEOUT: Duration = Duration::from_secs(3);
const NEXT_INVOCATION: &str = "MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION";

#[derive(Debug)]
pub struct DownstreamUncertain;
impl fmt::Display for DownstreamUncertain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Antigravity 操作结果尚未确认，请检查会话后再重试")
    }
}
impl std::error::Error for DownstreamUncertain {}

#[derive(Debug)]
struct ResponseTooLarge;

impl fmt::Display for ResponseTooLarge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Antigravity 响应过大")
    }
}

impl std::error::Error for ResponseTooLarge {}

struct OversizedHistory {
    thread: String,
    daemon: (u32, u16),
    checked: Instant,
}

enum HistoryView {
    Full(View),
    Bounded(View, Option<String>),
}

impl HistoryView {
    fn view(self) -> View {
        match self {
            Self::Full(view) | Self::Bounded(view, _) => view,
        }
    }
}

#[derive(Clone)]
pub struct Backend {
    id: String,
    name: String,
    home: PathBuf,
    read_only: bool,
    write_in_question_ids: bool,
    bounded_question_responses: bool,
    client: reqwest::Client,
    subscriptions: Arc<Mutex<HashMap<String, Weak<Subscription>>>>,
    oversized_history: Arc<Mutex<VecDeque<OversizedHistory>>>,
    project_catalog: Arc<tokio::sync::Mutex<Option<(std::time::Instant, Value)>>>,
    project_uris: Arc<tokio::sync::Mutex<HashMap<String, Vec<Value>>>>,
    model_catalog: Arc<tokio::sync::Mutex<Option<(std::time::Instant, Vec<NativeModel>)>>>,
}

#[derive(Clone)]
struct NativeModel {
    id: String,
    name: String,
    native: String,
}

struct NativeSkill {
    id: String,
    choice: Value,
    info: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Daemon {
    pid: u32,
    http_port: u16,
    csrf_token: String,
    #[serde(default)]
    ls_version: String,
}

impl Backend {
    pub(crate) fn from_config(
        id: String,
        name: String,
        config: &Value,
        read_only: bool,
        host_capabilities: &Value,
    ) -> Result<Self> {
        ensure!(
            config.as_object().is_none_or(|c| c
                .keys()
                .all(|key| matches!(key.as_str(), "home" | "readOnly"))),
            "Antigravity 配置字段无效"
        );
        ensure!(
            config["home"].is_null() || config["home"].as_str().is_some_and(|s| !s.is_empty()),
            "Antigravity 数据目录无效"
        );
        let home = config["home"]
            .as_str()
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|p| p.join(".gemini/antigravity")))
            .context("无法定位 Antigravity 数据目录")?;
        ensure!(home.is_absolute(), "Antigravity 数据目录必须使用绝对路径");
        ensure!(
            config["readOnly"].is_null() || config["readOnly"].is_boolean(),
            "Antigravity 只读配置无效"
        );
        Ok(Self {
            id,
            name,
            home,
            read_only: read_only || config["readOnly"] == true,
            write_in_question_ids: host_capabilities["writeInQuestionIds"] == true,
            bounded_question_responses: host_capabilities["boundedQuestionResponses"] == true,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(15))
                .build()?,
            subscriptions: Default::default(),
            oversized_history: Default::default(),
            project_catalog: Default::default(),
            project_uris: Default::default(),
            model_catalog: Default::default(),
        })
    }

    fn daemons(&self) -> Vec<Daemon> {
        let mut files: Vec<_> = fs::read_dir(self.home.join("daemon"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|s| s.starts_with("hub_") && s.ends_with(".json"))
            })
            .collect();
        files.sort_by_key(|f| std::cmp::Reverse(f.metadata().ok().and_then(|m| m.modified().ok())));
        files
            .into_iter()
            .filter_map(|f| {
                let meta = fs::symlink_metadata(f.path()).ok()?;
                if !meta.is_file() || meta.len() > 16 * 1024 {
                    return None;
                }
                let daemon: Daemon = serde_json::from_slice(&fs::read(f.path()).ok()?).ok()?;
                if daemon.pid == 0
                    || daemon.http_port == 0
                    || daemon.csrf_token.is_empty()
                    || daemon.csrf_token.len() > 1024
                    || f.file_name().to_str()
                        != Some(format!("hub_{}.json", daemon.http_port).as_str())
                {
                    return None;
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if meta.uid() != rustix::process::getuid().as_raw() {
                        return None;
                    }
                }
                #[cfg(target_os = "linux")]
                {
                    use std::os::unix::fs::MetadataExt;
                    let process = fs::metadata(format!("/proc/{}", daemon.pid)).ok()?;
                    if process.uid() != meta.uid() {
                        return None;
                    }
                }
                Some(daemon)
            })
            .collect()
    }

    async fn call_at(
        &self,
        daemon: &Daemon,
        method: &str,
        body: &Value,
        write: bool,
    ) -> Result<Value> {
        let url = format!("http://127.0.0.1:{}/{SERVICE}/{method}", daemon.http_port);
        let result: Result<Value> = async {
            let response = self
                .client
                .post(url)
                .header("Content-Type", "application/json")
                .header("Connect-Protocol-Version", "1")
                .header("x-codeium-csrf-token", &daemon.csrf_token)
                .timeout(if method == "GetCapabilities" {
                    Duration::from_secs(2)
                } else {
                    Duration::from_secs(15)
                })
                .body(serde_json::to_vec(body)?)
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("Antigravity 本地服务连接失败"))?;
            ensure!(
                response.status().is_success(),
                "Antigravity 本地服务未接受请求"
            );
            ensure!(
                response
                    .content_length()
                    .is_none_or(|n| n <= MAX_RESPONSE as u64),
                ResponseTooLarge
            );
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| anyhow::anyhow!("Antigravity 响应读取失败"))?;
                ensure!(bytes.len() + chunk.len() <= MAX_RESPONSE, ResponseTooLarge);
                bytes.extend_from_slice(&chunk);
            }
            serde_json::from_slice(&bytes)
                .map_err(|_| anyhow::anyhow!("Antigravity 响应格式不兼容"))
        }
        .await;
        if write {
            result.map_err(|_| DownstreamUncertain.into())
        } else {
            result
        }
    }

    // Discovery repeats after every call, so restarting Antigravity needs no host restart.
    async fn daemon(&self) -> Result<Daemon> {
        for daemon in self.daemons() {
            if self
                .call_at(&daemon, "GetCapabilities", &json!({}), false)
                .await
                .is_ok()
            {
                return Ok(daemon);
            }
        }
        anyhow::bail!("请先在本机启动 Antigravity App")
    }

    async fn call(&self, method: &str, body: Value) -> Result<Value> {
        let daemon = self.daemon().await?;
        self.call_at(&daemon, method, &body, false).await
    }

    async fn dispatch(&self, method: &str, body: Value) -> Result<Value> {
        ensure!(!self.read_only, "Antigravity 当前为只读模式");
        let daemon = self.daemon().await?;
        self.call_at(&daemon, method, &body, true).await
    }

    pub async fn info(&self) -> Value {
        let daemon = self.daemon().await.ok();
        let connected = daemon.is_some();
        let mut capabilities = serde_json::Map::new();
        for name in [
            "history",
            "send",
            "steer",
            "interrupt",
            "respond",
            "settings",
            "queue",
            "create",
            "open",
            "attachments",
            "skills",
            "plugins",
        ] {
            let implemented = matches!(
                name,
                "history"
                    | "send"
                    | "steer"
                    | "interrupt"
                    | "respond"
                    | "create"
                    | "skills"
                    | "plugins"
                    | "attachments"
                    | "queue"
            );
            let state = if !implemented {
                "unsupported"
            } else if !connected || (name != "history" && self.read_only) {
                "unavailable"
            } else {
                "experimental"
            };
            capabilities.insert(name.into(), json!({"state":state}));
        }
        json!({"id":self.id,"product":"antigravity","name":self.name,
            "connected":connected,"version":daemon.map(|d| d.ls_version),"profile":"rust-native",
            "presentation":{"description":"Antigravity App 本地适配器",
                "creation":{"empty":true,"attachments":!self.read_only,"tools":!self.read_only,"permission":"native","preset":false,"plan":false,"notice":"沿用 Antigravity 项目权限"},
                "plan":"none","fileReferences":true,"exportLog":true,"nativeCommands":false,"attachmentMode":"image"},
            "capabilities":capabilities})
    }

    pub(crate) async fn status(&self) -> Value {
        let info = self.info().await;
        let connected = info["connected"] == true;
        let writes = connected && !self.read_only;
        json!({"connected":connected,"desktopVersion":info["version"],"supportedVersion":connected,
            "writesEnabled":writes,"reason":if !connected { Some("请先在本机启动 Antigravity App") } else if self.read_only { Some("Antigravity 当前为只读模式") } else { None },
            "capabilities":{"send":writes,"steer":writes,"interrupt":writes,"modelSettings":false,
                "nextMessageModel":writes,"questions":writes,"approvals":writes,"permissionRequests":false,"openThread":false,
                "elicitationForms":false,"newThread":writes,"renameThread":writes,"forkThread":false,"queue":writes}})
    }

    async fn summaries(&self) -> Result<BTreeMap<String, Value>> {
        self.summaries_at(&self.daemon().await?).await
    }

    async fn summaries_at(&self, daemon: &Daemon) -> Result<BTreeMap<String, Value>> {
        let data = self
            .call_at(
                daemon,
                "GetAllCascadeTrajectories",
                &json!({"excludeSubtrajectories":true}),
                false,
            )
            .await?;
        if data["trajectorySummaries"].is_null() {
            return Ok(BTreeMap::new());
        }
        let map = data["trajectorySummaries"]
            .as_object()
            .context("Antigravity 会话列表格式不兼容")?;
        Ok(map
            .iter()
            .filter(|(_, s)| s["annotations"]["archived"] != true)
            .map(|(id, s)| (id.clone(), s.clone()))
            .collect())
    }

    async fn rename(&self, thread: &str, title: &str) -> Result<Value> {
        self.dispatch(
            "UpdateConversationAnnotations",
            json!({"cascadeIds":[thread],"annotations":{"title":title},"mergeAnnotations":true}),
        )
        .await
    }

    async fn conversation_workspaces(&self, thread: &str) -> Result<Vec<Value>> {
        valid_id(thread)?;
        let summaries = self.summaries().await?;
        let summary = summaries.get(thread).context("找不到 Antigravity 会话")?;
        Ok(summary["trajectoryMetadata"]["workspaceUris"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| {
                summary["workspaces"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|w| w["workspaceFolderAbsoluteUri"].as_str().map(|u| json!(u)))
                    .collect()
            }))
    }

    async fn creation_workspaces(&self, project: Option<&str>) -> Vec<Value> {
        let Some(project) = project.filter(|s| !s.is_empty()) else {
            return Vec::new();
        };
        let Ok(projects) = self.project_catalog(false).await else {
            return Vec::new();
        };
        if let Some(uris) = self.project_uris.lock().await.get(project)
            && !uris.is_empty()
        {
            return uris.clone();
        }
        let Some(path) = projects
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["id"] == project)
            .and_then(|p| p["path"].as_str())
            .filter(|s| !s.is_empty())
        else {
            return Vec::new();
        };
        url::Url::from_file_path(path)
            .ok()
            .map(|uri| vec![json!(uri.to_string())])
            .unwrap_or_default()
    }

    async fn creation_skills(&self, project: Option<&str>) -> Result<Vec<NativeSkill>> {
        let workspace_uris = self.creation_workspaces(project).await;
        let data = self
            .call(
                "GetSlashCommands",
                json!({"cascadeId":"","workspaceUris":workspace_uris}),
            )
            .await?;
        skill_catalog("new", &json!(workspace_uris), &data)
    }

    async fn creation_plugins(
        &self,
        project: Option<&str>,
    ) -> Result<Vec<plugin_selection::NativePlugin>> {
        let workspace_uris = self.creation_workspaces(project).await;
        let data = self
            .call("GetAllPlugins", json!({"workspaceUris":workspace_uris}))
            .await?;
        plugin_selection::catalog("new", &workspace_uris, &data)
    }

    async fn skills(&self, thread: &str) -> Result<Vec<NativeSkill>> {
        let workspace_uris = self.conversation_workspaces(thread).await?;
        let data = self
            .call(
                "GetSlashCommands",
                json!({"cascadeId":thread,"workspaceUris":workspace_uris}),
            )
            .await?;
        skill_catalog(thread, &json!(workspace_uris), &data)
    }

    async fn plugins(&self, thread: &str) -> Result<Vec<plugin_selection::NativePlugin>> {
        let workspace_uris = self.conversation_workspaces(thread).await?;
        let data = self
            .call("GetAllPlugins", json!({"workspaceUris":workspace_uris}))
            .await?;
        plugin_selection::catalog(thread, &workspace_uris, &data)
    }

    async fn projects(&self) -> Result<Value> {
        self.project_catalog(false).await
    }

    async fn project_catalog(&self, refresh: bool) -> Result<Value> {
        let mut cache = self.project_catalog.lock().await;
        if !refresh
            && let Some((at, projects)) = &*cache
            && at.elapsed() < Duration::from_secs(10)
        {
            return Ok(projects.clone());
        }
        let ids = self.call("ListProjects", json!({})).await?;
        let data = self
            .call(
                "ReadProjects",
                json!({"ids":ids["projectIds"].as_array().cloned().unwrap_or_default()}),
            )
            .await?;
        let projects = project_values(&data)?;
        let uris = project_workspace_uris(&data);
        *self.project_uris.lock().await = uris;
        *cache = Some((std::time::Instant::now(), projects.clone()));
        Ok(projects)
    }

    async fn model_catalog(&self) -> Vec<NativeModel> {
        let mut cache = self.model_catalog.lock().await;
        if let Some((updated, models)) = cache.as_ref()
            && updated.elapsed() < Duration::from_secs(30)
        {
            return models.clone();
        }
        let models = match tokio::time::timeout(
            Duration::from_secs(4),
            self.call("GetCascadeModelConfigData", json!({})),
        )
        .await
        {
            Ok(Ok(data)) => native_models(&data),
            _ => cache
                .as_ref()
                .map(|(_, rows)| rows.clone())
                .unwrap_or_default(),
        };
        // Also throttle misses, so an unknown enum or disconnected daemon does
        // not trigger an extra catalog request on every one-second watch poll.
        *cache = Some((std::time::Instant::now(), models.clone()));
        models
    }

    async fn models(&self) -> Result<Value> {
        let models: Vec<_> = self
            .model_catalog()
            .await
            .iter()
            .map(|m| json!({"id":m.id,"name":m.name,"efforts":[],"defaultEffort":null,"speeds":[]}))
            .collect();
        Ok(json!({"models":models,"fetchedAt":null,"source":"antigravity-app"}))
    }

    async fn usage(&self, refresh: bool) -> Value {
        let Ok(daemon) = self.daemon().await else {
            return crate::usage::unavailable("Antigravity 本地额度暂不可用");
        };
        // This is the same grouped quota source used by the App's View Usage.
        // Per-model quotaInfo is a different allowance and cannot supply these
        // shared weekly/five-hour windows. Never substitute it on failure.
        let summary = tokio::time::timeout(
            Duration::from_secs(8),
            self.call_at(
                &daemon,
                "RetrieveUserQuotaSummary",
                &json!({"forceRefresh":refresh}),
                false,
            ),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(Value::Null);
        quota_usage(&summary)
    }

    async fn native_model(&self, id: &str) -> Result<Value> {
        let data = self.call("GetCascadeModelConfigData", json!({})).await?;
        let model = data["clientModelConfigs"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| m["modelId"] == id || m["modelOrAlias"]["model"] == id)
            .context("模型不在 Antigravity 目录中")?;
        model["modelOrAlias"]["model"]
            .as_str()
            .map(|s| json!(s))
            .context("此 Antigravity 模型不支持直接选择")
    }

    async fn conversation(&self, id: &str) -> Result<(Daemon, Value)> {
        valid_id(id)?;
        let daemon = self.daemon().await?;
        let summary = self
            .summaries_at(&daemon)
            .await?
            .remove(id)
            .context("找不到 Antigravity 会话")?;
        Ok((daemon, summary))
    }

    async fn trajectory(&self, daemon: &Daemon, id: &str) -> Result<Value> {
        self.call_at(
            daemon,
            "GetCascadeTrajectory",
            &json!({"cascadeId":id}),
            false,
        )
        .await
    }

    async fn readable_trajectory(&self, daemon: &Daemon, id: &str) -> Result<Option<Value>> {
        let daemon_id = (daemon.pid, daemon.http_port);
        {
            let mut oversized = self.oversized_history.lock().unwrap();
            oversized.retain(|old| old.checked.elapsed() < Duration::from_secs(30));
            if oversized
                .iter()
                .any(|old| old.daemon == daemon_id && old.thread == id)
            {
                return Ok(None);
            }
        }
        match self.trajectory(daemon, id).await {
            Ok(data) => Ok(Some(data)),
            Err(error) if error.is::<ResponseTooLarge>() => {
                let mut oversized = self.oversized_history.lock().unwrap();
                oversized.retain(|old| old.daemon != daemon_id || old.thread != id);
                if oversized.len() >= 32 {
                    oversized.pop_front();
                }
                oversized.push_back(OversizedHistory {
                    thread: id.to_owned(),
                    daemon: daemon_id,
                    checked: Instant::now(),
                });
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    // Send and interrupt still require the complete native trajectory.
    async fn snapshot(&self, id: &str) -> Result<View> {
        let (daemon, summary) = self.conversation(id).await?;
        let data = self.trajectory(&daemon, id).await?;
        self.full_view(id, &summary, &daemon, data).await
    }

    async fn history_view(
        &self,
        id: &str,
        cursor: Option<history::Cursor<'_>>,
    ) -> Result<HistoryView> {
        let (daemon, summary) = self.conversation(id).await?;
        if cursor.is_none()
            && let Some(data) = self.readable_trajectory(&daemon, id).await?
        {
            return Ok(HistoryView::Full(
                self.full_view(id, &summary, &daemon, data).await?,
            ));
        }

        let trajectory = summary["trajectoryId"]
            .as_str()
            .context("Antigravity 会话版本不可用")?;
        let latest = cursor.is_none();
        let page = history::browse(self, &daemon, id, trajectory, cursor).await?;
        let mut requests = Vec::new();
        if latest
            && !self.read_only
            && self.bounded_question_responses
            && let Some((index, step)) = page.waiting_question()
            && let Some(request) = interactions::bounded_question(id, trajectory, index, step)
        {
            requests.push(request);
            self.apply_question_capabilities(&mut requests);
        }
        let projects = self.projects().await.unwrap_or_else(|_| json!([]));
        let mut thread = summary_with_projects(id, &summary, &projects);
        thread["historyTrajectoryId"] = json!(trajectory);
        thread["historyStepCount"] = json!(page.total_steps());
        // The projected window may omit blocking interactions or changes to an
        // earlier execution. A question at the live tail has its own gate.
        thread["revision"] = json!(0);
        thread["owner"] = json!(false);
        thread["synchronized"] = json!(false);
        thread["activeTurnId"] = Value::Null;
        thread["runtimeStatus"] = json!("unknown");
        thread["model"] = Value::Null;
        thread["mode"] = json!("default");
        let can_answer = !requests.is_empty();
        if can_answer {
            thread["boundedQuestionAvailable"] = json!(true);
        }
        thread["pendingRequests"] = json!(requests.len());
        thread["requests"] = json!(requests);
        for capability in ["canSend", "canSteer", "canInterrupt"] {
            thread[capability] = json!(false);
        }
        thread["reason"] = json!(if can_answer {
            "请先回答 Antigravity 的问题"
        } else {
            "Antigravity 会话较长，已按页读取历史。请在本机 App 处理当前任务。"
        });
        let older = page.older_cursor();
        let view = View {
            thread,
            messages: page.messages().into(),
            streamed: None,
            observations: Arc::from([]),
            image_limits: Value::Null,
            continued_questions: Value::Null,
            plugin_epoch: None,
        };
        Ok(HistoryView::Bounded(view, older))
    }

    async fn history_step(&self, id: &str, index: usize) -> Result<Option<Value>> {
        let daemon = self.daemon().await?;
        if let Some(mut data) = self.readable_trajectory(&daemon, id).await? {
            let trajectory = &mut data["trajectory"];
            ensure!(trajectory["cascadeId"] == id, "Antigravity 会话已变化");
            return Ok(trajectory["steps"].get_mut(index).map(Value::take));
        }

        let summaries = self.summaries_at(&daemon).await?;
        let trajectory = summaries
            .get(id)
            .and_then(|s| s["trajectoryId"].as_str())
            .context("Antigravity 会话版本不可用")?;
        history::step(self, &daemon, id, trajectory, index).await
    }

    async fn full_view(
        &self,
        id: &str,
        summary: &Value,
        daemon: &Daemon,
        data: Value,
    ) -> Result<View> {
        let projects = self.projects().await.unwrap_or_else(|_| json!([]));
        let mut view = summary_with_projects(id, summary, &projects);
        ensure!(data["trajectory"].is_object(), "Antigravity 会话格式不兼容");
        let empty = Vec::new();
        let steps = if data["trajectory"]["steps"].is_null() {
            &empty
        } else {
            data["trajectory"]["steps"]
                .as_array()
                .context("Antigravity 会话格式不兼容")?
        };
        if let Some(trajectory) = data["trajectory"]["trajectoryId"]
            .as_str()
            .filter(|trajectory| valid_id(trajectory).is_ok())
        {
            view["historyTrajectoryId"] = json!(trajectory);
            view["historyStepCount"] = json!(steps.len());
        }
        let active = matches!(
            data["status"].as_str(),
            Some(
                "CASCADE_RUN_STATUS_RUNNING"
                    | "CASCADE_RUN_STATUS_BUSY"
                    | "CASCADE_RUN_STATUS_CANCELING"
            )
        );
        let idle = data["status"] == "CASCADE_RUN_STATUS_IDLE";
        let messages = messages(steps, 0, false);
        let execution = active_execution(steps);
        let mut requests = interactions::views(&data["trajectory"], self.read_only);
        self.apply_question_capabilities(&mut requests);
        let model = current_model(&data["trajectory"], steps);
        view["revision"] = json!(0);
        view["owner"] = json!(!self.read_only);
        view["synchronized"] = json!(true);
        view["activeTurnId"] = if active {
            json!(execution)
        } else {
            Value::Null
        };
        view["runtimeStatus"] = json!(if active {
            "running"
        } else if idle {
            "idle"
        } else {
            "unknown"
        });
        if let Some(activity) = activity_state(steps, active) {
            view["codexActivity"] = json!(activity);
        }
        let catalog = if model.is_some() {
            self.model_catalog().await
        } else {
            Vec::new()
        };
        let selected = model.and_then(|id| catalog.iter().find(|m| m.id == id || m.native == id));
        view["model"] = json!(selected.map(|m| &m.id));
        view["modelName"] = json!(
            selected
                .map(|m| m.name.as_str())
                .unwrap_or("Antigravity 模型")
        );
        view["mode"] = json!("default");
        view["pendingRequests"] = json!(requests.len());
        view["requests"] = json!(requests);
        view["canSend"] = json!(!self.read_only && idle && requests.is_empty());
        view["canSteer"] = json!(
            !self.read_only
                && supports_append(&data["status"])
                && execution.is_some_and(|id| !execution_finished(&data["trajectory"], id))
                && requests.is_empty()
        );
        view["canInterrupt"] = json!(!self.read_only && active && execution.is_some());
        if let Ok(queue) = queue::read(self, daemon, id).await {
            queue.display(&mut view);
        }
        view["reason"] = json!(if self.read_only {
            Some("Antigravity 当前为只读模式")
        } else if requests
            .iter()
            .any(|request| request["actionable"] == true && request["kind"] == "question")
        {
            Some("请先回答 Antigravity 的问题")
        } else if requests
            .iter()
            .any(|request| request["actionable"] == true && request["kind"] == "file")
        {
            Some("请先处理 Antigravity 的文件修改审批")
        } else if requests.iter().any(|request| request["actionable"] == true) {
            Some("请先处理 Antigravity 的命令审批")
        } else if !requests.is_empty() {
            Some("请在 Antigravity 本机处理请求")
        } else if active {
            Some("Antigravity 正在运行")
        } else {
            None
        });
        let observations = observations(&data);
        Ok(View {
            thread: view,
            messages: messages.into(),
            streamed: None,
            observations: observations.into(),
            #[cfg(feature = "official-plugins")]
            image_limits: Value::Null,
            #[cfg(feature = "official-plugins")]
            continued_questions: Value::Null,
            plugin_epoch: None,
        })
    }

    fn apply_question_capabilities(&self, requests: &mut [Value]) {
        if self.write_in_question_ids {
            for request in requests.iter_mut().filter(|r| r["kind"] == "question") {
                request["acceptsWriteInQuestionIds"] = json!(true);
            }
        }
    }

    async fn bounded_question_response(
        &self,
        daemon: &Daemon,
        thread: &str,
        answer: &crate::requests::Response,
    ) -> Result<Value> {
        let index = interactions::request_index(answer)?;
        let summaries = self.summaries_at(daemon).await?;
        let trajectory = summaries
            .get(thread)
            .and_then(|s| s["trajectoryId"].as_str())
            .context("Antigravity 会话版本不可用")?;
        let page = history::step_page(self, daemon, thread, trajectory, index)
            .await?
            .context("Antigravity 问题已处理或过期")?;
        let (index, step) = page
            .waiting_question()
            .context("Antigravity 问题已处理或过期")?;
        interactions::bounded_question_response(thread, trajectory, index, step, answer)
    }

    async fn respond_to_interaction(
        &self,
        thread: &str,
        answer: &crate::requests::Response,
    ) -> Delivery {
        if valid_id(thread).is_err() {
            return Delivery::Rejected("Antigravity 会话 ID 无效");
        }
        let Ok(daemon) = self.daemon().await else {
            return Delivery::Rejected("Antigravity 本地服务不可用");
        };
        let result = match self.readable_trajectory(&daemon, thread).await {
            Ok(Some(data)) => {
                let trajectory = &data["trajectory"];
                if trajectory["cascadeId"] != thread {
                    return Delivery::Rejected("Antigravity 会话已变化");
                }
                interactions::response(trajectory, answer)
            }
            Ok(None) if self.bounded_question_responses => {
                self.bounded_question_response(&daemon, thread, answer)
                    .await
            }
            _ => return Delivery::Rejected("Antigravity 会话尚未同步"),
        };
        let Ok(interaction) = result else {
            return Delivery::Rejected("Antigravity 请求已变化或答复无效");
        };
        let result = delivery(
            self.call_at(
                &daemon,
                "HandleCascadeUserInteraction",
                &json!({"cascadeId":thread,"interaction":interaction}),
                true,
            )
            .await,
            Delivery::Completed(None),
        );
        if matches!(result, Delivery::Uncertain)
            && interaction["askQuestion"].is_object()
            && self
                .confirm_question(&daemon, thread, &interaction, answer)
                .await
        {
            return Delivery::Completed(None);
        }
        result
    }

    async fn confirm_question(
        &self,
        daemon: &Daemon,
        thread: &str,
        sent: &Value,
        answer: &crate::requests::Response,
    ) -> bool {
        let (Some(trajectory), Some(index)) = (
            sent["trajectoryId"].as_str(),
            sent["stepIndex"]
                .as_u64()
                .and_then(|index| usize::try_from(index).ok()),
        ) else {
            return false;
        };
        // The original write may have succeeded. Only inspect its target.
        // Keep the extra reads inside the gateway's write-response budget.
        tokio::time::timeout(QUESTION_RECEIPT_TIMEOUT, async {
            for attempt in 0..3 {
                if attempt > 0 {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                let step = match self.readable_trajectory(daemon, thread).await {
                    Ok(Some(mut data)) => {
                        let native = &mut data["trajectory"];
                        if native["cascadeId"] != thread || native["trajectoryId"] != trajectory {
                            return false;
                        }
                        native["steps"].get_mut(index).map(Value::take)
                    }
                    Ok(None) => history::step(self, daemon, thread, trajectory, index)
                        .await
                        .ok()
                        .flatten(),
                    Err(_) => None,
                };
                if step.is_some_and(|step| {
                    interactions::question_recorded(thread, trajectory, index, &step, sent, answer)
                }) {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false)
    }

    async fn rpc(&self, method: &str, params: &Value, query: &Value) -> Result<Option<Value>> {
        let result = match method {
            "status.read" => self.status().await,
            "models.list" => self.models().await?,
            "threads.list" | "history.list" => {
                let summaries = self.summaries().await?;
                let projects = self.projects().await.unwrap_or_else(|_| json!([]));
                let search = query["q"].as_str().unwrap_or("").trim().to_lowercase();
                ensure!(search.len() <= 1024, "搜索过长");
                let project = query["project"].as_str();
                let mut threads: Vec<_> = summaries
                    .iter()
                    .map(|(id, s)| summary_with_projects(id, s, &projects))
                    .filter(|s| {
                        (search.is_empty()
                            || format!("{} {}", s["title"], s["cwd"])
                                .to_lowercase()
                                .contains(&search))
                            && project.is_none_or(|p| {
                                if matches!(p, "none" | "ungrouped") {
                                    s["projectId"].is_null()
                                } else {
                                    s["projectId"] == p
                                }
                            })
                    })
                    .collect();
                threads.sort_by(|a, b| {
                    b["updatedAt"]
                        .as_i64()
                        .cmp(&a["updatedAt"].as_i64())
                        .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
                });
                let start = offset(query, threads.len())?;
                let end = (start + PAGE).min(threads.len());
                json!({"threads":threads[start..end],"nextCursor":if end < threads.len() { Some(end.to_string()) } else { None }})
            }
            "projects.list" => {
                let summaries = self.summaries().await?;
                let projects = self.projects().await?;
                let rows: Vec<_> = projects
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|p| {
                        let count = summaries
                            .values()
                            .filter(|s| s["trajectoryMetadata"]["projectId"] == p["id"])
                            .count();
                        json!({"id":p["id"],"name":p["name"],"count":count})
                    })
                    .collect();
                json!({"projects":rows,"total":summaries.len(),"ungrouped":summaries.values().filter(|s| s["trajectoryMetadata"]["projectId"].as_str().is_none_or(str::is_empty)).count()})
            }
            "thread.read" => {
                let view = self.history_view(thread_id(params)?, None).await?.view();
                let messages = &view.messages[view.messages.len().saturating_sub(500)..];
                json!({"thread":view.thread,"messages":messages})
            }
            "history.read" => {
                let cursor = history::Cursor::read(query)?;
                match self.history_view(thread_id(params)?, cursor).await? {
                    HistoryView::Full(view) => {
                        let messages = &view.messages;
                        let end = if query["cursor"].is_null() {
                            messages.len()
                        } else {
                            offset(query, messages.len())?
                        };
                        let start = end.saturating_sub(PAGE);
                        json!({"thread":view.thread,"messages":messages[start..end],"nextCursor":if start > 0 { Some(start.to_string()) } else { None }})
                    }
                    HistoryView::Bounded(view, older) => {
                        // A prior full-history cursor counts projected messages,
                        // not native steps. Restart at the bounded latest page.
                        if query["cursor"]
                            .as_str()
                            .is_some_and(|c| !c.starts_with("steps:"))
                        {
                            offset(query, usize::MAX)?;
                        }
                        json!({"thread":view.thread,"messages":view.messages.as_ref(),"nextCursor":older})
                    }
                }
            }
            "controls.read" => {
                json!({"product":"antigravity","permissions":[],"presets":[],"actions":[],"state":{}})
            }
            _ => return Ok(None),
        };
        Ok(Some(result))
    }
}

