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
mod permissions;
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
    client: reqwest::Client,
    subscriptions: Arc<Mutex<HashMap<String, Weak<Subscription>>>>,
    oversized_history: Arc<Mutex<VecDeque<OversizedHistory>>>,
    project_catalog: Arc<tokio::sync::Mutex<Option<(std::time::Instant, Value)>>>,
    project_uris: Arc<tokio::sync::Mutex<HashMap<String, Vec<Value>>>>,
    model_catalog: Arc<tokio::sync::Mutex<Option<(std::time::Instant, Vec<NativeModel>)>>>,
    permission_write: Arc<tokio::sync::Mutex<()>>,
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
            permission_write: Default::default(),
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
                "plan":"none","fileReferences":true,"exportLog":true,"nativeCommands":false},
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

    async fn daemon_summaries_at(
        &self,
        daemon: &Daemon,
    ) -> Result<serde_json::Map<String, Value>> {
        let data = self
            .call_at(
                daemon,
                "GetAllCascadeTrajectories",
                &json!({"excludeSubtrajectories":true}),
                false,
            )
            .await?;
        if data["trajectorySummaries"].is_null() {
            return Ok(serde_json::Map::new());
        }
        data["trajectorySummaries"]
            .as_object()
            .cloned()
            .context("Antigravity 会话列表格式不兼容")
    }

    async fn summaries(&self) -> Result<BTreeMap<String, Value>> {
        self.summaries_at(&self.daemon().await?).await
    }

    async fn summaries_at(&self, daemon: &Daemon) -> Result<BTreeMap<String, Value>> {
        let map = self.daemon_summaries_at(daemon).await?;
        let seen: HashSet<String> = map.keys().cloned().collect();
        let mut summaries: BTreeMap<String, Value> = map
            .into_iter()
            .filter(|(_, s)| s["annotations"]["archived"] != true)
            .collect();
        let home = self.home.clone();
        if let Ok(disk) = tokio::task::spawn_blocking(move || read_disk_summaries(&home)).await {
            for (id, summary) in disk {
                if !seen.contains(&id) {
                    summaries.entry(id).or_insert(summary);
                }
            }
        }
        Ok(summaries)
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

    async fn snapshot(&self, id: &str) -> Result<View> {
        self.history_view(id, None).await.map(HistoryView::view)
    }

    fn thread_reason(&self, requests: &[Value], active: bool) -> Option<&'static str> {
        if self.read_only {
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
        }
    }

    async fn history_view(
        &self,
        id: &str,
        cursor: Option<history::Cursor<'_>>,
    ) -> Result<HistoryView> {
        let (daemon, mut summary) = self.conversation(id).await?;
        if cursor.is_none()
            && let Some(data) = self.readable_trajectory(&daemon, id).await?
        {
            if summary["annotations"].is_null()
                && let Ok(mut live) = self.daemon_summaries_at(&daemon).await
                && let Some(fresh) = live.remove(id)
            {
                summary = fresh;
            }
            return Ok(HistoryView::Full(
                self.full_view(id, &summary, &daemon, data).await?,
            ));
        }

        if summary["trajectoryId"].is_null()
            && let Ok(mut live) = self.daemon_summaries_at(&daemon).await
            && let Some(fresh) = live.remove(id)
        {
            summary = fresh;
        }
        let trajectory = summary["trajectoryId"]
            .as_str()
            .context("Antigravity 会话版本不可用")?;
        let latest = cursor.is_none();
        let page = history::browse(self, &daemon, id, trajectory, cursor).await?;
        let live_tail = latest && page.is_tail();
        let projects = self.projects().await.unwrap_or_else(|_| json!([]));
        let mut thread = summary_with_projects(id, &summary, &projects);
        thread["historyTrajectoryId"] = json!(trajectory);
        thread["historyStepCount"] = json!(page.total_steps());
        thread["revision"] = json!(0);
        thread["mode"] = json!("default");
        let observations = if live_tail {
            let status = page.status();
            let active = matches!(
                status.as_str(),
                Some(
                    "CASCADE_RUN_STATUS_RUNNING"
                        | "CASCADE_RUN_STATUS_BUSY"
                        | "CASCADE_RUN_STATUS_CANCELING"
                )
            );
            let idle = status == "CASCADE_RUN_STATUS_IDLE";
            let steps = page.steps();
            let execution = active_execution(steps);
            let mut requests =
                interactions::views_slice(Some(id), Some(trajectory), page.start(), steps, self.read_only);
            self.apply_question_capabilities(&mut requests);
            let bounded_trajectory = json!({"generatorMetadata": page.generator_metadatas()});
            let model = current_model(&bounded_trajectory, steps).or_else(|| {
                [&summary["lastModel"], &summary["latestModel"], &summary["model"]]
                    .into_iter()
                    .filter_map(Value::as_str)
                    .find(|id| !id.is_empty() && *id != "MODEL_UNSPECIFIED")
            });
            let catalog = if model.is_some() {
                self.model_catalog().await
            } else {
                Vec::new()
            };
            let selected = model.and_then(|id| catalog.iter().find(|m| m.id == id || m.native == id));
            thread["owner"] = json!(!self.read_only);
            thread["synchronized"] = json!(true);
            thread["activeTurnId"] = if active {
                json!(execution)
            } else {
                Value::Null
            };
            thread["runtimeStatus"] = json!(if active {
                "running"
            } else if idle {
                "idle"
            } else {
                "unknown"
            });
            if let Some(activity) = activity_state(steps, active) {
                thread["codexActivity"] = json!(activity);
            }
            thread["model"] = json!(selected.map(|m| &m.id));
            thread["modelName"] = json!(
                selected
                    .map(|m| m.name.as_str())
                    .unwrap_or("Antigravity 模型")
            );
            thread["pendingRequests"] = json!(requests.len());
            thread["requests"] = json!(requests);
            let finished = execution.is_some_and(|exec| {
                execution_finished(&json!({"executorMetadatas": page.executor_metadatas()}), exec)
            });
            thread["canSend"] = json!(!self.read_only && idle && requests.is_empty());
            thread["canSteer"] = json!(
                !self.read_only
                    && supports_append(status)
                    && execution.is_some()
                    && !finished
                    && requests.is_empty()
            );
            thread["canInterrupt"] = json!(!self.read_only && active && execution.is_some());
            if let Some(permission) = permissions::preset_id(&summary["annotations"]["permissionPreset"]) {
                thread["controls"] = json!({"permission": permission});
            }
            if let Some(queue) = page.queue() {
                queue.display(&mut thread);
            }
            thread["reason"] = json!(self.thread_reason(&requests, active));
            page.observations()
        } else {
            thread["owner"] = json!(false);
            thread["synchronized"] = json!(false);
            thread["activeTurnId"] = Value::Null;
            thread["runtimeStatus"] = json!("unknown");
            thread["model"] = Value::Null;
            thread["pendingRequests"] = json!(0);
            thread["requests"] = json!([]);
            for capability in ["canSend", "canSteer", "canInterrupt"] {
                thread[capability] = json!(false);
            }
            thread["reason"] = json!(if latest {
                "最新记录单条过大，请在 Antigravity 本机 App 处理当前任务。"
            } else {
                "正在浏览更早的历史记录"
            });
            Vec::new()
        };
        let older = page.older_cursor();
        let view = View {
            thread,
            messages: page.messages().into(),
            streamed: None,
            observations: observations.into(),
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
        if let Some(permission) = permissions::preset_id(&summary["annotations"]["permissionPreset"]) {
            view["controls"] = json!({"permission": permission});
        }
        if let Ok(queue) = queue::read(self, daemon, id).await {
            queue.display(&mut view);
        }
        view["reason"] = json!(self.thread_reason(&requests, active));
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

    async fn paged_interaction_response(
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
            .context("Antigravity 请求已处理或过期")?;
        let step = page
            .waiting_step(index)
            .context("Antigravity 请求已处理或过期")?;
        interactions::step_response(thread, trajectory, index, step, answer)
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
            Ok(None) => {
                self.paged_interaction_response(&daemon, thread, answer)
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
                let mut rows: Vec<_> = projects
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|p| {
                        let mut count = 0usize;
                        let mut latest = 0i64;
                        for s in summaries.values() {
                            if s["trajectoryMetadata"]["projectId"] == p["id"] {
                                count += 1;
                                let ts = timestamp_ms(s["lastModifiedTime"].as_str().unwrap_or(""));
                                if ts > latest {
                                    latest = ts;
                                }
                            }
                        }
                        (latest, json!({"id":p["id"],"name":p["name"],"count":count}))
                    })
                    .collect();
                rows.sort_by(|a, b| b.0.cmp(&a.0));
                let rows: Vec<_> = rows.into_iter().map(|(_, row)| row).collect();
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
            "controls.read" => self.permission_catalog(thread_id(params)?).await,
            _ => return Ok(None),
        };
        Ok(Some(result))
    }
}

fn normalize_sqlite_timestamp(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() < 19 {
        return String::new();
    }
    let mut normalized = trimmed.to_owned();
    if normalized.as_bytes().get(10) == Some(&b' ') {
        normalized.replace_range(10..11, "T");
    }
    if normalized.ends_with('Z') {
        return normalized;
    }
    if let Some(stem) = normalized
        .strip_suffix("+00:00")
        .or_else(|| normalized.strip_suffix("-00:00"))
    {
        return format!("{stem}Z");
    }
    // Handle arbitrary numeric timezone offset like +08:00 or -05:00.
    let bytes = normalized.as_bytes();
    if bytes.len() >= 25 {
        let sign_pos = bytes.len() - 6;
        let sign = bytes[sign_pos];
        if matches!(sign, b'+' | b'-')
            && bytes[sign_pos + 3] == b':'
            && let (Ok(oh), Ok(om)) = (
                normalized[sign_pos + 1..sign_pos + 3].parse::<i64>(),
                normalized[sign_pos + 4..sign_pos + 6].parse::<i64>(),
            )
            && oh <= 23
            && om <= 59
        {
            let utc_str = format!("{}Z", &normalized[..sign_pos]);
            let local_ms = timestamp_ms(&utc_str);
            if local_ms > 0 {
                let offset_ms = (oh * 60 + om) * 60 * 1000 * if sign == b'+' { 1 } else { -1 };
                let utc_ms = local_ms - offset_ms;
                if let Ok(dt) = time::OffsetDateTime::from_unix_timestamp_nanos(
                    i128::from(utc_ms) * 1_000_000,
                ) {
                    return format!(
                        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
                        dt.year(),
                        dt.month() as u8,
                        dt.day(),
                        dt.hour(),
                        dt.minute(),
                        dt.second(),
                        dt.millisecond()
                    );
                }
            }
        }
    }
    format!("{normalized}Z")
}

fn annotation_archived(home: &std::path::Path, id: &str) -> bool {
    let path = home.join("annotations").join(format!("{id}.pbtxt"));
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    text.contains("archived:true") || text.contains("archived: true")
}

fn read_disk_summaries(home: &std::path::Path) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    let db_path = home.join("conversation_summaries.db");
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return out;
    };
    let _ = conn.busy_timeout(Duration::from_millis(500));
    let mut archived = HashSet::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT DISTINCT conversation_id FROM conversations_fts WHERE archived != 0")
        && let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0))
    {
        for id in rows.flatten() {
            archived.insert(id);
        }
    }
    let Ok(mut stmt) = conn.prepare(
        "SELECT conversation_id, title, last_modified_time, workspace_uris, project_id
         FROM conversation_summaries
         WHERE parent_conversation_id = ''
           AND nesting_depth = 0
           AND killed = 0
         ORDER BY last_modified_time DESC
         LIMIT 5000",
    ) else {
        return out;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    }) else {
        return out;
    };
    let conversations_dir = home.join("conversations");
    for row in rows.flatten() {
        let (id, title, modified, workspace_uris_json, project_id) = row;
        if valid_id(&id).is_err()
            || archived.contains(&id)
            || annotation_archived(home, &id)
            || !conversations_dir.join(format!("{id}.db")).is_file()
        {
            continue;
        }
        let uris: Vec<Value> = serde_json::from_str::<Vec<String>>(&workspace_uris_json)
            .unwrap_or_default()
            .into_iter()
            .filter(|uri| !uri.is_empty() && !uri.chars().any(char::is_control))
            .map(|uri| json!(uri))
            .collect();
        let workspaces: Vec<Value> = uris
            .iter()
            .map(|uri| json!({"workspaceFolderAbsoluteUri": uri}))
            .collect();
        let mut metadata = serde_json::Map::new();
        if !project_id.is_empty() {
            metadata.insert("projectId".into(), json!(project_id));
        }
        if !uris.is_empty() {
            metadata.insert("workspaceUris".into(), Value::Array(uris));
        }
        let mut summary = json!({
            "summary": title,
            "lastModifiedTime": normalize_sqlite_timestamp(&modified),
            "trajectoryMetadata": Value::Object(metadata),
        });
        if !workspaces.is_empty() {
            summary["workspaces"] = Value::Array(workspaces);
        }
        out.insert(id, summary);
    }
    out
}

