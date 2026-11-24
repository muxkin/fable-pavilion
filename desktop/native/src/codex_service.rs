#[cfg(feature = "official-plugins")]
use crate::{
    app_tools::Tool,
    codex::History,
    codex_live::{Action, Desktop, Outcome, Thread},
    codex_peer::Endpoint,
    codex_voice::{Session, Voice},
    conversations, history_media, settings,
};
#[cfg(feature = "official-plugins")]
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
#[cfg(feature = "official-plugins")]
use serde_json::Value;
#[cfg(feature = "official-plugins")]
use serde_json::json;
use std::path::PathBuf;
#[cfg(feature = "official-plugins")]
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
#[cfg(feature = "official-plugins")]
use uuid::Uuid;

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
pub(crate) struct Availability {
    pub history: bool,
    pub desktop: bool,
    #[serde(default)]
    pub ipc_online: bool,
    #[serde(default)]
    pub app_tool_messages: bool,
    pub open: bool,
    pub create: bool,
    #[serde(default)]
    pub create_attachments: bool,
    #[serde(default)]
    pub create_tools: bool,
    pub rename: bool,
    pub fork: bool,
    pub fork_reply: bool,
    #[serde(default)]
    pub voice: bool,
    #[serde(default)]
    pub usage_reset: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub(crate) struct Options {
    pub home: Option<PathBuf>,
    pub root: Option<PathBuf>,
    pub socket: Option<PathBuf>,
    pub executable: Option<PathBuf>,
    pub app_tools: Option<PathBuf>,
    pub cli: Option<PathBuf>,
    pub explicit: bool,
}

pub(crate) fn voice_sdp(sdp: &str) -> bool {
    if sdp.len() > 64 * 1024 || sdp.lines().next() != Some("v=0") {
        return false;
    }
    let mut audio_tracks = 0;
    let mut data_channels = 0;
    for media in sdp.lines().filter_map(|line| line.strip_prefix("m=")) {
        match media.split_ascii_whitespace().next() {
            Some("audio") => audio_tracks += 1,
            Some("application") => data_channels += 1,
            _ => return false,
        }
    }
    audio_tracks == 1 && data_channels <= 1
}

#[cfg(feature = "official-plugins")]
pub(crate) struct Local {
    history: History,
    desktop: Option<Desktop>,
    voice: Option<Voice>,
    ipc_online: AtomicBool,
    app_server_online: AtomicBool,
}

#[cfg(feature = "official-plugins")]
impl Local {
    pub(crate) fn open(options: &Options, read_only: bool, named: bool) -> Result<Self> {
        let home = options.home.as_deref().context("尚未配置 Codex 目录")?;
        let history = History::open(home)?;
        let endpoint = if read_only {
            None
        } else {
            Endpoint::discover(home, options, named)
        };
        let voice = if read_only {
            None
        } else {
            Voice::new(
                endpoint.as_ref().and_then(Endpoint::executable),
                options.cli.as_deref(),
                history.clone(),
                named,
            )
        };
        let desktop = endpoint
            .map(|endpoint| Desktop::new(endpoint, history.clone(), options.cli.as_deref()));
        Ok(Self {
            history,
            desktop,
            voice,
            ipc_online: AtomicBool::new(false),
            app_server_online: AtomicBool::new(false),
        })
    }

    pub(crate) fn availability(&self) -> Availability {
        let catalog = self
            .desktop
            .as_ref()
            .map(|desktop| desktop.tools.catalog())
            .unwrap_or_default();
        let ipc_online = self.ipc_online.load(Ordering::Relaxed);
        let app_server_online = self.app_server_online.load(Ordering::Relaxed);
        Availability {
            history: true,
            desktop: self.desktop.is_some(),
            ipc_online,
            app_tool_messages: catalog.can_message(),
            open: catalog.has(Tool::Open),
            create: catalog.can_create(),
            create_attachments: catalog.can_create(),
            create_tools: catalog.can_create()
                && catalog.has(Tool::Open)
                && (ipc_online || app_server_online)
                && self
                    .desktop
                    .as_ref()
                    .is_some_and(|desktop| desktop.reply_fork.supports_blank()),
            rename: catalog.has(Tool::Rename),
            fork: catalog.has(Tool::Fork),
            fork_reply: self
                .desktop
                .as_ref()
                .is_some_and(|desktop| desktop.reply_fork.supported()),
            voice: self.voice.is_some(),
            usage_reset: catalog.has(Tool::UsageReset),
        }
    }

    pub(crate) async fn refresh(&self) -> Availability {
        if let Some(desktop) = &self.desktop {
            let app_server_online = crate::codex_goal::AppServer::available(self.history.home());
            let (ipc_online, _, _) = tokio::join!(
                desktop.ipc_available(),
                desktop.tools.refresh(),
                desktop.reply_fork.probe()
            );
            self.ipc_online.store(ipc_online, Ordering::Relaxed);
            self.app_server_online
                .store(app_server_online, Ordering::Relaxed);
        }
        self.availability()
    }

    pub(crate) fn subscribe(&self, id: Uuid) -> Option<Arc<Thread>> {
        self.desktop.as_ref()?.subscribe(id)
    }

    pub(crate) fn start_voice(&self, thread: Uuid, session: Uuid, sdp: &str) -> Result<Session> {
        self.voice
            .as_ref()
            .context(crate::codex_voice::Failure("Codex 语音尚未启用"))?
            .start(thread, session, sdp)
    }

    pub(crate) async fn read(
        &self,
        method: &str,
        params: &Value,
        query: &Value,
        live: Option<&Thread>,
    ) -> Result<Option<Value>> {
        match method {
            "models.list" => {
                if let Some(desktop) = &self.desktop {
                    return desktop.models().await.map(Some);
                }
                let history = self.history.clone();
                tokio::task::spawn_blocking(move || history.models().map(Some)).await?
            }
            "content.read" => {
                let id = thread_id(&params["id"])?;
                let message_id = query["messageId"]
                    .as_str()
                    .filter(|value| !value.is_empty() && value.encode_utf16().count() <= 500)
                    .context("消息 ID 无效")?;
                if let Some(view) = live.and_then(|live| live.view.borrow().clone())
                    && let Some(mut message) = view
                        .messages
                        .iter()
                        .find(|message| message["id"] == message_id)
                        .cloned()
                {
                    if let Some(text) = view.expanded.get(message_id) {
                        message["text"] = json!(text);
                        message["truncated"] = json!(false);
                    }
                    if let Some(details) = view.activities.get(message_id) {
                        crate::tool_activity::apply_details(&mut message, details);
                    }
                    return Ok(Some(json!({"message":message})));
                }
                let history = self.history.clone();
                let message_id = message_id.to_owned();
                tokio::task::spawn_blocking(move || history.content(id, &message_id)).await?
            }
            "skills.list" | "plugins.list" => {
                let catalog = if query["creation"] == "1" {
                    let desktop = self.desktop.as_ref().context("尚未连接 Codex")?;
                    ensure!(
                        self.availability().create_tools,
                        "此 Codex 桌面版本不支持新会话工具"
                    );
                    let id = params["id"].as_str().context("会话 ID 无效")?.to_owned();
                    let lookup = self.history.clone();
                    let anchor = tokio::task::spawn_blocking(move || lookup.anchor(&id)).await??;
                    let project = query["projectId"]
                        .as_str()
                        .filter(|value| !value.is_empty());
                    let (cwd, _) =
                        conversations::destination(&desktop.tools, &self.history, &anchor, project)
                            .await?;
                    let home = self.history.home().to_owned();
                    tokio::task::spawn_blocking(move || {
                        crate::tools_catalog::Catalog::scan(&home, &cwd, &[])
                    })
                    .await??
                } else {
                    self.tools(thread_id(&params["id"])?, live).await?
                };
                let skills = method == "skills.list";
                let name = if skills { "skills" } else { "plugins" };
                Ok(Some(json!({name:catalog.list(skills)})))
            }
            "controls.read" => {
                let id = params["id"].as_str().context("会话 ID 无效")?;
                let view = live
                    .and_then(|live| live.view.borrow().clone())
                    .filter(|view| !view.app_tools || view.app_server);
                let state = view.as_ref().map_or_else(
                    || settings::permission(&Value::Null),
                    |view| view.thread["controls"].clone(),
                );
                let mut controls = settings::controls(state, view.is_some());
                if let (Some(desktop), Some(view), Ok(thread)) =
                    (&self.desktop, view.as_ref(), Uuid::parse_str(id))
                {
                    desktop.goals.enrich(&mut controls, thread, view).await;
                }
                Ok(Some(controls))
            }
            "creation.projects" => {
                let desktop = self.desktop.as_ref().context("尚未连接 Codex")?;
                let id = params["id"].as_str().context("会话 ID 无效")?.to_owned();
                let lookup = self.history.clone();
                let anchor = tokio::task::spawn_blocking(move || lookup.anchor(&id)).await??;
                let projects =
                    conversations::projects(&desktop.tools, self.history.clone(), &anchor).await?;
                Ok(Some(json!({"projects":projects})))
            }
            "usage.read" => {
                let value = if let Some(desktop) = &self.desktop {
                    match self.usage_anchor(&params["id"]).await? {
                        Some(id) => desktop.usage.read(id).await,
                        None => crate::usage::unavailable("暂无可用于查询用量的 Codex 会话"),
                    }
                } else {
                    crate::usage::unavailable("本机桌面用量暂不可用")
                };
                Ok(Some(value))
            }
            _ => {
                let history = self.history.clone();
                let method = method.to_owned();
                let params = params.clone();
                let query = query.clone();
                tokio::task::spawn_blocking(move || history.rpc(&method, &params, &query)).await?
            }
        }
    }

    async fn usage_anchor(&self, thread: &Value) -> Result<Option<Uuid>> {
        if let Some(id) = thread.as_str().and_then(|id| Uuid::parse_str(id).ok()) {
            return Ok(Some(id));
        }
        let history = self.history.clone();
        tokio::task::spawn_blocking(move || history.latest_thread()).await?
    }

    pub(crate) async fn reset_usage(
        &self,
        thread: &Value,
        request: Uuid,
    ) -> Result<crate::usage::ResetResult, crate::usage::ResetError> {
        use crate::usage::ResetError;
        let desktop = self.desktop.as_ref().ok_or(ResetError::Unavailable)?;
        let anchor = self
            .usage_anchor(thread)
            .await
            .map_err(|_| ResetError::Unavailable)?
            .ok_or(ResetError::Unavailable)?;
        desktop.usage.reset(anchor, request).await
    }

    async fn tools(
        &self,
        id: Uuid,
        live: Option<&Thread>,
    ) -> Result<crate::tools_catalog::Catalog> {
        let history = self.history.clone();
        let disabled = live
            .and_then(|live| {
                live.view
                    .borrow()
                    .as_ref()
                    .map(|view| view.disabled_plugins.clone())
            })
            .unwrap_or_default();
        tokio::task::spawn_blocking(move || history.tools(id, &disabled)).await?
    }

    pub(crate) async fn select_tools(
        &self,
        id: Uuid,
        live: Option<&Thread>,
        skills: &[String],
        plugins: &[String],
    ) -> Result<Vec<Value>> {
        self.tools(id, live).await?.select(skills, plugins)
    }

    pub(crate) async fn media(
        &self,
        backend: String,
        thread: Uuid,
        device: String,
        reference: String,
        live: Option<&Thread>,
    ) -> Result<history_media::Source> {
        let history = self.history.clone();
        let view = live.and_then(|live| live.view.borrow().clone());
        tokio::task::spawn_blocking(move || {
            history_media::description(
                &history,
                &backend,
                thread,
                &device,
                &reference,
                view.as_deref(),
            )
        })
        .await?
    }

    pub(crate) async fn manage(
        &self,
        request: Uuid,
        change: conversations::Change,
        thread: String,
        live: Option<Arc<Thread>>,
    ) -> Outcome {
        let Some(desktop) = &self.desktop else {
            return Outcome::Rejected("尚未连接 Codex".into());
        };
        change
            .execute(desktop.clone(), self.history.clone(), thread, live, request)
            .await
    }

    pub(crate) async fn execute(
        &self,
        thread: Uuid,
        live: Option<&Thread>,
        request: Uuid,
        action: Action,
    ) -> Outcome {
        let Some(live) = live else {
            return Outcome::Rejected("请先打开会话".into());
        };
        if let Action::Goal { change } = action {
            let Some(desktop) = &self.desktop else {
                return Outcome::Rejected("尚未连接 Codex".into());
            };
            if !live
                .view
                .borrow()
                .as_ref()
                .is_some_and(|view| view.supports_controls())
            {
                return Outcome::Rejected("请先打开 Codex 会话".into());
            }
            return desktop.goals.change(thread, change).await;
        }
        live.execute(action, request).await
    }
}

#[cfg(feature = "official-plugins")]
pub(crate) fn thread_id(value: &Value) -> Result<Uuid> {
    Ok(Uuid::parse_str(value.as_str().context("会话 ID 无效")?)?)
}
