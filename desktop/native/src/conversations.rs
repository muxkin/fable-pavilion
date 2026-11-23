use crate::files::Attachment;
#[cfg(feature = "official-plugins")]
use crate::{
    app_tools::{self, AppTools, Tool},
    codex::History,
    codex_live::{Desktop, Outcome, Thread},
    files::attachment_prompt,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
#[cfg(feature = "official-plugins")]
use serde_json::json;
#[cfg(feature = "official-plugins")]
use std::path::PathBuf;
#[cfg(feature = "official-plugins")]
use std::{sync::Arc, time::Duration};
#[cfg(feature = "official-plugins")]
use tokio::time::timeout;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub request_id: Uuid,
    title: Option<String>,
    prompt: Option<String>,
    project_id: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    last_turn_id: Option<String>,
    draft_id: Option<Uuid>,
    #[serde(default)]
    upload_ids: Vec<Uuid>,
    #[serde(default)]
    skill_ids: Vec<String>,
    #[serde(default)]
    plugin_ids: Vec<String>,
}

pub(crate) struct DraftUploads {
    pub(crate) id: Uuid,
    pub(crate) uploads: Vec<Uuid>,
}

pub(crate) struct FirstTurn {
    pub(crate) text: String,
    pub(crate) files: Vec<Attachment>,
    pub(crate) skill_ids: Vec<String>,
    pub(crate) plugin_ids: Vec<String>,
    pub(crate) model: Option<String>,
    pub(crate) thinking: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub enum Change {
    Open,
    Rename(String),
    Fork,
    ForkReply(String),
    Create {
        title: Option<String>,
        prompt: String,
        project_id: Option<String>,
        model: Option<String>,
        thinking: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        files: Vec<Attachment>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        skill_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        plugin_ids: Vec<String>,
    },
}

impl Request {
    pub(crate) fn parse(mut self, method: &str) -> Result<(Uuid, Change, Option<DraftUploads>)> {
        let creating = method == "thread.create";
        let renaming = method == "thread.rename";
        ensure!(
            (method == "thread.fork" || self.last_turn_id.is_none())
                && (creating
                    || (self.prompt.is_none()
                        && self.project_id.is_none()
                        && self.model.is_none()
                        && self.thinking.is_none()))
                && (creating || renaming || self.title.is_none()),
            "会话操作参数无效"
        );
        ensure!(
            self.draft_id.is_some() == !self.upload_ids.is_empty()
                && (creating || self.upload_ids.is_empty())
                && self.upload_ids.len() <= 10
                && self
                    .upload_ids
                    .iter()
                    .enumerate()
                    .all(|(index, id)| { !self.upload_ids[..index].contains(id) }),
            "新会话附件参数无效"
        );
        ensure!(
            creating || (self.skill_ids.is_empty() && self.plugin_ids.is_empty()),
            "会话操作参数无效"
        );
        for ids in [&self.skill_ids, &self.plugin_ids] {
            ensure!(
                ids.len() <= 10
                    && ids.iter().all(|id| {
                        (1..=160).contains(&id.encode_utf16().count())
                            && !id.chars().any(char::is_control)
                    }),
                "技能或插件选择无效"
            );
        }
        let draft = self.draft_id.map(|id| DraftUploads {
            id,
            uploads: self.upload_ids,
        });
        let title = self.title.take().map(|title| title.trim().to_owned());
        ensure!(
            title
                .as_ref()
                .is_none_or(|title| title.encode_utf16().count() <= 160
                    && !title.chars().any(char::is_control)),
            "会话名称无效"
        );
        let change = match method {
            "thread.open" => Change::Open,
            "thread.fork" => match self.last_turn_id {
                None => Change::Fork,
                Some(turn) => {
                    ensure!(
                        (1..=200).contains(&turn.encode_utf16().count())
                            && !turn.chars().any(char::is_control),
                        "回复 ID 无效"
                    );
                    Change::ForkReply(turn)
                }
            },
            "thread.rename" => Change::Rename(
                title
                    .filter(|title| !title.is_empty())
                    .context("请输入名称")?,
            ),
            "thread.create" => {
                let prompt = self.prompt.as_deref().unwrap_or_default().trim();
                ensure!(
                    (!prompt.is_empty() || draft.is_some())
                        && prompt.encode_utf16().count() <= 16_000,
                    "请输入第一条消息"
                );
                for (value, max) in [
                    (&self.project_id, 200),
                    (&self.model, 500),
                    (&self.thinking, 40),
                ] {
                    ensure!(
                        value.as_ref().is_none_or(|value| !value.is_empty()
                            && value.encode_utf16().count() <= max
                            && !value.chars().any(char::is_control)),
                        "新会话选项无效"
                    );
                }
                Change::Create {
                    title: title.filter(|title| !title.is_empty()),
                    prompt: prompt.to_owned(),
                    project_id: self.project_id,
                    model: self.model,
                    thinking: self.thinking,
                    files: Vec::new(),
                    skill_ids: self.skill_ids,
                    plugin_ids: self.plugin_ids,
                }
            }
            _ => anyhow::bail!("会话操作不支持"),
        };
        Ok((self.request_id, change, draft))
    }
}

impl Change {
    pub(crate) fn first_turn(&self) -> Option<FirstTurn> {
        let Self::Create {
            prompt,
            files,
            skill_ids,
            plugin_ids,
            model,
            thinking,
            ..
        } = self
        else {
            return None;
        };
        if skill_ids.is_empty() && plugin_ids.is_empty() {
            return None;
        }
        Some(FirstTurn {
            text: prompt.clone(),
            files: files.clone(),
            skill_ids: skill_ids.clone(),
            plugin_ids: plugin_ids.clone(),
            model: model.clone(),
            thinking: thinking.clone(),
        })
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Rename(_) => "rename",
            Self::Fork | Self::ForkReply(_) => "fork",
            Self::Create { .. } => "create",
        }
    }

    #[cfg(feature = "official-plugins")]
    pub async fn execute(
        self,
        desktop: Desktop,
        history: History,
        thread: String,
        live: Option<Arc<Thread>>,
        request: Uuid,
    ) -> Outcome {
        if matches!(self, Self::Open) {
            let Some(live) = &live else {
                return Outcome::Rejected("请先在工作台选择会话".into());
            };
            if live
                .view
                .borrow()
                .as_ref()
                .is_some_and(|view| view.is_ready_to_continue())
            {
                return Outcome::Completed(None);
            }
            if !desktop.ipc_available().await {
                return if desktop.tools.refresh().await.can_message() {
                    wait_for_open(live).await
                } else {
                    Outcome::Rejected("本机 Codex 桌面未提供可用的会话连接".into())
                };
            }
        }
        let lookup = history.clone();
        let lookup_thread = thread.clone();
        let anchor = tokio::task::spawn_blocking(move || lookup.anchor(&lookup_thread))
            .await
            .ok()
            .and_then(Result::ok);
        let Some(anchor) = anchor else {
            return Outcome::Rejected("找不到本机会话".into());
        };
        let tools = desktop.tools.clone();
        let (tool, arguments) = match self {
            Self::ForkReply(turn) => {
                let verified = match live.as_ref().and_then(|live| live.reply_forkable(&turn)) {
                    Some(verified) => verified,
                    None => {
                        let Ok(source) = Uuid::parse_str(&anchor) else {
                            return Outcome::Rejected("找不到原会话".into());
                        };
                        let history = history.clone();
                        let reply = turn.clone();
                        tokio::task::spawn_blocking(move || history.has_saved_reply(source, &reply))
                            .await
                            .is_ok_and(|result| result.unwrap_or(false))
                    }
                };
                if !verified {
                    return Outcome::Rejected("无法确认所选回复已完成，请刷新后重试".into());
                }
                return desktop
                    .reply_fork
                    .fork(history.home(), &anchor, &turn)
                    .await;
            }

            Self::Open => (Tool::Open, json!({"threadId":thread})),
            Self::Rename(title) => (
                Tool::Rename,
                json!({"source":"codex","threadId":thread,"title":title}),
            ),
            Self::Fork => (
                Tool::Fork,
                json!({"threadId":thread,"environment":{"type":"same-directory"}}),
            ),
            Self::Create {
                title,
                prompt,
                project_id,
                model,
                thinking,
                files,
                skill_ids,
                plugin_ids,
            } => {
                if model.is_some() || thinking.is_some() {
                    let valid = desktop.models().await.ok().is_some_and(|catalog| {
                        catalog["models"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|entry| {
                                model.as_deref().is_some_and(|id| entry["id"] == id)
                                    && thinking.as_deref().is_none_or(|effort| {
                                        entry["efforts"].as_array().is_some_and(|levels| {
                                            levels.iter().any(|level| level == effort)
                                        })
                                    })
                            })
                    });
                    if !valid {
                        return Outcome::Rejected(
                            "模型或推理强度不在桌面目录中，请重新选择".into(),
                        );
                    }
                }
                if !skill_ids.is_empty() || !plugin_ids.is_empty() {
                    if !desktop.reply_fork.supports_blank() || !tools.catalog().has(Tool::Open) {
                        return Outcome::Rejected("此 Codex 桌面版本暂不支持新会话工具".into());
                    }
                    let Ok((mut cwd, project_id)) =
                        destination(&tools, &history, &anchor, project_id.as_deref()).await
                    else {
                        return Outcome::Rejected("所选桌面项目已不可用".into());
                    };
                    let home = history.home().to_owned();
                    let workspace = cwd.clone();
                    let chosen = tokio::task::spawn_blocking(move || {
                        crate::tools_catalog::Catalog::scan(&home, &workspace, &[])?
                            .select(&skill_ids, &plugin_ids)
                    })
                    .await;
                    if !matches!(chosen, Ok(Ok(_))) {
                        return Outcome::Rejected(
                            "所选技能或插件已停用、移除或不属于所选项目".into(),
                        );
                    }
                    if project_id.is_none() {
                        let Some(base) =
                            dirs::home_dir().map(|home| home.join("Documents").join("Codex"))
                        else {
                            return Outcome::Rejected("无法准备新会话的工作目录".into());
                        };
                        let root = base.join("Agent Space");
                        cwd = root.join(request.to_string());
                        if std::fs::create_dir_all(base)
                            .map_err(anyhow::Error::from)
                            .and_then(|()| crate::state::private_directory(&root))
                            .and_then(|()| crate::state::private_directory(&cwd))
                            .is_err()
                        {
                            return Outcome::Rejected("无法准备新会话的工作目录".into());
                        }
                    }
                    let Ok(cwd) = cwd.canonicalize() else {
                        return Outcome::Rejected("所选桌面项目目录不可用".into());
                    };
                    let mut params = json!({"threadSource":"user","historyMode":"paginated","cwd":cwd,"projectId":project_id});
                    if let Some(model) = model {
                        params["model"] = json!(model);
                    }
                    if let Some(effort) = thinking {
                        params["config"] = json!({"model_reasoning_effort":effort});
                    }
                    let initial_title = title.unwrap_or_else(|| {
                        let preview = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
                        let preview: String = preview
                            .chars()
                            .filter(|ch| !ch.is_control())
                            .take(60)
                            .collect();
                        if !preview.is_empty() {
                            return preview;
                        }
                        files.first().map_or_else(
                            || "新会话".into(),
                            |file| file.name.chars().take(60).collect(),
                        )
                    });
                    return desktop
                        .reply_fork
                        .blank(history.home(), params, &initial_title)
                        .await;
                }
                let Ok(prompt) = attachment_prompt(&prompt, &files, false) else {
                    return Outcome::Rejected("无法读取新会话附件，请重新上传".into());
                };
                let mut args = json!({"prompt":prompt,"target":{"type":"projectless"}});
                for (key, value) in [("title", title), ("model", model), ("thinking", thinking)] {
                    if let Some(value) = value {
                        args[key] = json!(value);
                    }
                }
                if let Some(id) = project_id {
                    let Ok(projects) = projects(&tools, history, &anchor).await else {
                        return Outcome::Rejected("无法读取桌面项目，请重新选择".into());
                    };
                    let Some(project) = projects
                        .iter()
                        .find(|project| project.id == id || project.desktop_id == id)
                    else {
                        return Outcome::Rejected("所选桌面项目已不可用".into());
                    };
                    args["target"] = json!({"type":"project","projectId":project.desktop_id,"environment":{"type":"local"}});
                }
                (Tool::Create, args)
            }
        };
        let Ok(mut stream) = tools.connect(tool).await else {
            return Outcome::Rejected(
                if matches!(tool, Tool::Open) {
                    "请先在电脑上的 Codex 桌面打开此会话，工作台同步后即可控制。"
                } else {
                    "Codex 桌面未提供此操作"
                }
                .into(),
            );
        };
        let reply = app_tools::call(&mut stream, &anchor, request, tool, arguments).await;
        if matches!(tool, Tool::Open) {
            return wait_for_open(&live.expect("open requires a subscription")).await;
        }
        let Ok(reply) = reply else {
            return Outcome::Uncertain;
        };
        if matches!(tool, Tool::Rename) {
            return Outcome::Completed(None);
        }
        let local =
            reply["hostId"] == "local" || (matches!(tool, Tool::Fork) && reply["hostId"].is_null());
        let result = reply["threadId"]
            .as_str()
            .filter(|id| *id != thread)
            .and_then(|id| Uuid::parse_str(id).ok());
        match result {
            Some(result) if local => Outcome::Completed(Some(result)),
            _ => Outcome::Uncertain,
        }
    }
}

#[cfg(feature = "official-plugins")]
async fn wait_for_open(live: &Thread) -> Outcome {
    let mut receiver = live.view.clone();
    let ready = |view: &Option<Arc<crate::codex_live::View>>| {
        view.as_ref().is_some_and(|view| view.is_ready_to_continue())
    };
    match timeout(Duration::from_secs(12), receiver.wait_for(ready)).await {
        Ok(Ok(_)) => Outcome::Completed(None),
        Ok(Err(_)) => Outcome::Rejected("本机 Codex 会话连接已断开".into()),
        Err(_) => Outcome::Uncertain,
    }
}

#[cfg(feature = "official-plugins")]
#[derive(Serialize)]
pub struct Project {
    id: String,
    name: String,
    #[serde(skip)]
    desktop_id: String,
    #[serde(skip)]
    path: Option<PathBuf>,
}

#[cfg(feature = "official-plugins")]
pub(crate) async fn destination(
    tools: &AppTools,
    history: &History,
    anchor: &str,
    project_id: Option<&str>,
) -> Result<(PathBuf, Option<String>)> {
    let Some(id) = project_id else {
        // An unassigned draft lists personal tools before it has a workspace.
        return Ok((PathBuf::new(), None));
    };
    let project = projects(tools, history.clone(), anchor)
        .await?
        .into_iter()
        .find(|project| project.id == id || project.desktop_id == id)
        .context("找不到所选桌面项目")?;
    let path = project
        .path
        .filter(|path| path.is_absolute())
        .context("桌面项目目录无效")?;
    Ok((path, Some(project.id)))
}

#[cfg(feature = "official-plugins")]
pub async fn projects(tools: &AppTools, history: History, anchor: &str) -> Result<Vec<Project>> {
    let mut stream = tools.connect(Tool::Projects).await?;
    let result = timeout(
        Duration::from_secs(4),
        app_tools::call(
            &mut stream,
            anchor,
            Uuid::new_v4(),
            Tool::Projects,
            json!({}),
        ),
    )
    .await??;
    let aliases = tokio::task::spawn_blocking(move || history.project_aliases()).await??;
    let projects = result["projects"].as_array().context("桌面项目列表无效")?;
    Ok(projects
        .iter()
        .filter(|project| project["hostId"] == "local" && project["projectKind"] == "local")
        .filter_map(|project| {
            let desktop_id = project["projectId"].as_str()?;
            Some(Project {
                id: aliases[desktop_id]
                    .as_str()
                    .unwrap_or(desktop_id)
                    .to_owned(),
                name: project["label"].as_str().unwrap_or(desktop_id).to_owned(),
                desktop_id: desktop_id.to_owned(),
                path: project["path"].as_str().map(PathBuf::from),
            })
        })
        .collect())
}
