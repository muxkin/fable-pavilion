use super::*;

pub(super) fn plugin_thread(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|id| {
            (1..=200).contains(&id.encode_utf16().count())
                && !id
                    .chars()
                    .any(|ch| ch.is_control() || matches!(ch, '/' | '\\'))
        })
        .context("DSH 会话标识无效")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PluginRequest {
    request_id: Uuid,
    text: Option<String>,
    expected_turn_id: Option<String>,
    title: Option<String>,
    prompt: Option<String>,
    project_id: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    permission: Option<String>,
    agent_preset: Option<String>,
    plan: Option<bool>,
    expected_queue_fingerprint: Option<String>,
    message_id: Option<String>,
    draft_id: Option<Uuid>,
    upload_ids: Option<Vec<Uuid>>,
    skill_ids: Option<Vec<String>>,
    plugin_ids: Option<Vec<String>>,
}

impl PluginRequest {
    pub(super) fn parse(
        self,
        method: &str,
        adapter: &dyn Adapter,
        resolve: impl FnOnce(Option<Uuid>, &[Uuid]) -> Result<Vec<VerifiedUpload>>,
    ) -> Result<(Uuid, Write, Option<conversations::DraftUploads>)> {
        let skills = self.skill_ids.unwrap_or_default();
        let plugin_ids = self.plugin_ids.unwrap_or_default();
        ensure!(
            skills.len() <= 10
                && plugin_ids.len() <= 10
                && ((skills.is_empty() && plugin_ids.is_empty())
                    || matches!(method, "message.send" | "thread.create"))
                && skills.iter().chain(&plugin_ids).all(|name| {
                    (1..=200).contains(&name.encode_utf16().count())
                        && !name.chars().any(char::is_control)
                }),
            "插件工具选项无效"
        );
        adapter.validate_selection(&skills, &plugin_ids)?;
        let uploads = self.upload_ids.as_deref().unwrap_or_default();
        ensure!(
            uploads.len() <= 10
                && (uploads.is_empty()
                    || matches!(method, "message.send" | "turn.steer" | "thread.create"))
                && (self.draft_id.is_none() || method == "thread.create")
                && (method != "thread.create" || uploads.is_empty() || self.draft_id.is_some()),
            "插件附件参数无效"
        );
        let files = if uploads.is_empty() {
            Vec::new()
        } else {
            resolve(self.draft_id, uploads)?
        };
        let draft_uploads = if method == "thread.create" && !uploads.is_empty() {
            self.draft_id.map(|id| conversations::DraftUploads {
                id,
                uploads: uploads.to_vec(),
            })
        } else {
            None
        };
        let text = |input: Option<String>, limit: usize| {
            let value = input.unwrap_or_default();
            let trimmed = value.trim();
            ensure!(
                (1..=limit).contains(&trimmed.encode_utf16().count()),
                "DSH 内容无效"
            );
            Ok::<_, anyhow::Error>(trimmed.to_owned())
        };
        let prompt_text = |input: Option<String>| {
            let value = input.unwrap_or_default();
            let trimmed = value.trim();
            ensure!(
                trimmed.encode_utf16().count() <= 16_000
                    && (!trimmed.is_empty() || !files.is_empty()),
                "DSH 内容无效"
            );
            Ok::<_, anyhow::Error>(trimmed.to_owned())
        };
        let expected = || {
            self.expected_turn_id
                .as_deref()
                .filter(|id| !id.is_empty() && id.len() <= 200)
                .map(str::to_owned)
                .context("当前回合无效")
        };
        let mut settings = CreationSettings {
            model: self.model,
            thinking: self.thinking,
            permission: self.permission,
            preset: self.agent_preset,
            plan: self.plan,
        };
        let message_model = if method == "message.send" {
            let model = settings.model.take();
            ensure!(
                model.as_deref().is_none_or(|id| {
                    !id.is_empty()
                        && id.len() <= 512
                        && id == id.trim()
                        && !id.chars().any(char::is_control)
                }),
                "消息模型标识无效"
            );
            model
        } else {
            None
        };
        if method != "thread.create" {
            ensure!(
                self.prompt.is_none() && self.project_id.is_none() && settings.is_empty(),
                "DSH 请求参数无效"
            );
        }
        let queue = matches!(method, "queue.add" | "queue.remove");
        if !queue {
            ensure!(
                self.expected_queue_fingerprint.is_none() && self.message_id.is_none(),
                "DSH 请求参数无效"
            );
        }
        let queue_fingerprint = || {
            self.expected_queue_fingerprint
                .as_ref()
                .filter(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .cloned()
                .context("队列指纹无效")
        };
        let action = match method {
            "message.send" if self.title.is_none() && self.expected_turn_id.is_none() => {
                Write::Send {
                    text: prompt_text(self.text)?,
                    files,
                    skills,
                    plugin_ids,
                    model: message_model,
                }
            }
            "turn.steer" if self.title.is_none() => Write::Steer {
                expected: expected()?,
                text: prompt_text(self.text)?,
                files,
            },
            "turn.interrupt" if self.text.is_none() && self.title.is_none() => Write::Interrupt {
                expected: expected()?,
            },
            "thread.rename" if self.text.is_none() && self.expected_turn_id.is_none() => {
                let title = text(self.title, 160)?;
                ensure!(!title.chars().any(char::is_control), "会话名称无效");
                Write::Rename { title }
            }
            "queue.add"
                if self.title.is_none()
                    && self.expected_turn_id.is_none()
                    && self.message_id.is_none() =>
            {
                Write::Queue {
                    text: text(self.text, 16_000)?,
                    expected: queue_fingerprint()?,
                }
            }
            "queue.remove"
                if self.title.is_none()
                    && self.expected_turn_id.is_none()
                    && self.text.is_none() =>
            {
                let message = self
                    .message_id
                    .filter(|id| {
                        (1..=200).contains(&id.encode_utf16().count())
                            && !id.chars().any(char::is_control)
                    })
                    .context("队列条目标识无效")?;
                Write::RemoveQueued {
                    message,
                    expected: queue_fingerprint()?,
                }
            }
            "thread.create" if self.text.is_none() && self.expected_turn_id.is_none() => {
                let title = self
                    .title
                    .as_deref()
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                    .map(str::to_owned);
                ensure!(
                    title
                        .as_ref()
                        .is_none_or(|title| title.encode_utf16().count() <= 160
                            && !title.chars().any(char::is_control)),
                    "会话名称无效"
                );
                let project = self.project_id;
                ensure!(
                    project
                        .as_ref()
                        .is_none_or(|id| (1..=200).contains(&id.encode_utf16().count())
                            && !id.chars().any(char::is_control)),
                    "工作区标识无效"
                );
                Write::Create {
                    title,
                    prompt: prompt_text(self.prompt)?,
                    project,
                    settings,
                    files,
                    skills,
                    plugin_ids,
                }
            }
            _ => anyhow::bail!("DSH 请求参数无效"),
        };
        Ok((self.request_id, action, draft_uploads))
    }
}

#[derive(Debug)]
pub(super) struct Conflict;
impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("operation conflict")
    }
}
impl std::error::Error for Conflict {}

pub(super) fn backend_id(value: &Value) -> Option<&str> {
    value.get("backendId").map_or(Some(CODEX), Value::as_str)
}

pub(super) fn thread_id(value: &Value) -> Result<Uuid> {
    Ok(Uuid::parse_str(value.as_str().context("会话 ID 无效")?)?)
}

pub(super) fn codex_control(control: &Value) -> Result<Action> {
    if control["action"] != "goal" {
        return Ok(Action::Permission {
            input: settings::permission_change(control)?,
        });
    }
    let Control::Goal {
        operation,
        reference,
        objective,
    } = serde_json::from_value(control.clone())?
    else {
        anyhow::bail!("Codex 目标参数无效");
    };
    Ok(Action::Goal {
        change: crate::codex_goal::Change::new(operation, reference, objective)?,
    })
}

pub(super) fn codex_draft_id(value: &Value) -> Result<Option<Uuid>> {
    value
        .as_str()
        .and_then(|value| value.strip_prefix("new:"))
        .map(|id| Uuid::parse_str(id).context("新会话草稿标识无效"))
        .transpose()
}

pub(super) fn codex_file_scope(backend: &str, value: &Value) -> Result<Scope> {
    if let Some(draft) = codex_draft_id(value)? {
        Ok(Scope::codex_draft(backend, draft))
    } else {
        Ok(Scope::codex(backend, thread_id(value)?))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CommandBody {
    request_id: Uuid,
    text: Option<String>,
    expected_turn_id: Option<String>,
    upload_ids: Option<Vec<Uuid>>,
    plugin_ids: Option<Vec<String>>,
    skill_ids: Option<Vec<String>>,
}

pub(super) fn action(
    method: &str,
    body: &Value,
    resolve: impl FnOnce(&[Uuid]) -> Result<Vec<Attachment>>,
) -> Result<(Uuid, Action, Vec<String>, Vec<String>)> {
    let body: CommandBody = serde_json::from_value(body.clone())?;
    let skills = body.skill_ids.unwrap_or_default();
    let plugins = body.plugin_ids.unwrap_or_default();
    for ids in [&skills, &plugins] {
        ensure!(
            ids.len() <= 16
                && (ids.is_empty() || method == "message.send")
                && ids
                    .iter()
                    .all(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit())),
            "技能或插件参数无效"
        );
    }
    let ids = body.upload_ids.unwrap_or_default();
    ensure!(ids.len() <= 10, "附件数量过多");
    let files = resolve(&ids)?;
    let text = body
        .text
        .map(|value| value.trim().to_owned())
        .unwrap_or_default();
    ensure!(text.encode_utf16().count() <= 16_000, "消息文字无效");
    let expected = || {
        body.expected_turn_id
            .filter(|value| (1..=200).contains(&value.encode_utf16().count()))
            .context("目标任务无效")
    };
    let value = match method {
        "message.send" | "turn.steer" => {
            ensure!(
                !text.is_empty() || !files.is_empty(),
                "请输入消息或选择附件"
            );
            if method == "message.send" {
                Action::Send {
                    text,
                    files,
                    tools: Vec::new(),
                }
            } else {
                Action::Steer {
                    text,
                    expected: expected()?,
                    files,
                }
            }
        }
        _ => {
            ensure!(files.is_empty() && text.is_empty(), "中断请求参数无效");
            Action::Interrupt {
                expected: expected()?,
            }
        }
    };
    Ok((body.request_id, value, skills, plugins))
}
