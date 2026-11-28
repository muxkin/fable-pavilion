use super::*;

#[async_trait]
impl Adapter for Backend {
    fn id(&self) -> &str {
        &self.id
    }

    fn uploads_enabled(&self) -> bool {
        !self.read_only
    }

    fn validate_selection(&self, skills: &[String], plugins: &[String]) -> Result<()> {
        ensure!(valid_selection(skills), "Antigravity 技能选项无效");
        ensure!(valid_selection(plugins), "Antigravity 插件选项无效");
        Ok(())
    }

    async fn info(&self) -> Value {
        Backend::info(self).await
    }

    async fn status(&self) -> Value {
        Backend::status(self).await
    }

    async fn read(&self, method: &str, params: &Value, query: &Value) -> Result<Option<Value>> {
        match method {
            "creation.projects" => {
                let projects = self.projects().await?;
                Ok(Some(json!({"projects":projects})))
            }
            "references.list" => export::file_references(
                self,
                thread_id(params)?,
                query["q"].as_str().unwrap_or_default(),
            )
            .await
            .map(Some),
            "swarm.read" => swarm::read_swarm(self, thread_id(params)?).await.map(Some),
            "swarm.member.read" => swarm::read_member(
                self,
                thread_id(params)?,
                query["member"].as_str().context("Swarm 成员名无效")?,
            )
            .await
            .map(Some),
            "skills.list" => {
                let skills = if query["creation"] == "1" || params["id"] == "new" {
                    self.creation_skills(query["projectId"].as_str()).await?
                } else {
                    self.skills(thread_id(params)?).await?
                };
                Ok(Some(
                    json!({"skills":skills.into_iter().map(|s| s.choice).collect::<Vec<_>>()}),
                ))
            }
            "plugins.list" => {
                let plugins = if query["creation"] == "1" || params["id"] == "new" {
                    self.creation_plugins(query["projectId"].as_str()).await?
                } else {
                    self.plugins(thread_id(params)?).await?
                };
                Ok(Some(
                    json!({"plugins":plugins.into_iter().map(|plugin| plugin.choice).collect::<Vec<_>>()}),
                ))
            }
            "usage.read" => Ok(Some(
                self.usage(query["refresh"].as_str() == Some("1")).await,
            )),
            "content.read" => {
                let id = thread_id(params)?;
                let message_id = query["messageId"].as_str().context("消息 ID 无效")?;
                let index = message_id
                    .strip_prefix("antigravity-step-")
                    .context("消息 ID 无效")?
                    .parse::<usize>()
                    .context("消息 ID 无效")?;
                let Some(step) = self.history_step(id, index).await? else {
                    return Ok(None);
                };
                let Some(mut message) = messages(std::slice::from_ref(&step), index, true)
                    .into_iter()
                    .next()
                else {
                    return Ok(None);
                };
                message["id"] = json!(message_id);
                Ok(Some(json!({"message":message})))
            }
            _ => self.rpc(method, params, query).await,
        }
    }

    async fn media(
        &self,
        thread: &str,
        reference: &str,
        from_document: Option<&str>,
    ) -> Result<Media> {
        valid_id(thread)?;
        if reference.starts_with("antigravity-image:") {
            let (step, index) = media::reference(reference)?;
            let native_step = self.history_step(thread, step).await?.unwrap_or_default();
            return media::download(
                &self.home,
                thread,
                &native_step["userInput"]["media"][index],
            )
            .map(Media::Download);
        }
        let uris = self.conversation_workspaces(thread).await?;
        let roots = export::workspace_roots(&uris);
        let (daemon, summary) = self.conversation(thread).await?;
        let steps = if let Some(data) = self.readable_trajectory(&daemon, thread).await? {
            data["trajectory"]["steps"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        } else if let Some(trajectory) = summary["trajectoryId"].as_str() {
            history::browse(self, &daemon, thread, trajectory, None)
                .await
                .map(|page| page.steps().to_vec())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        media::download_cited_with_document(
            &self.home,
            thread,
            &roots,
            &steps,
            reference,
            from_document,
        )
        .map(Media::Download)
    }

    async fn export_log(&self, thread: &str) -> Result<crate::history_media::Source> {
        export::export_session(self, thread).await
    }

    fn subscribe(self: Arc<Self>, thread: &str) -> Result<Arc<Subscription>> {
        valid_id(thread)?;
        let mut subscriptions = self
            .subscriptions
            .lock()
            .expect("Antigravity subscription lock poisoned");
        subscriptions.retain(|_, subscription| subscription.strong_count() > 0);
        if let Some(subscription) = subscriptions.get(thread).and_then(Weak::upgrade) {
            return Ok(subscription);
        }
        ensure!(subscriptions.len() < 32, "Antigravity 订阅数量过多");
        let (update, receiver) = tokio::sync::watch::channel(None);
        let subscription = Arc::new(Subscription(receiver));
        subscriptions.insert(thread.to_owned(), Arc::downgrade(&subscription));
        drop(subscriptions);
        let thread = thread.to_owned();
        tokio::spawn(async move {
            let mut revision = 0u64;
            let mut fingerprint = None;
            loop {
                let result = tokio::select! {
                    _ = update.closed() => break,
                    result = self.history_view(&thread, None) => result.map(HistoryView::view),
                };
                match result {
                    Ok(mut view) => {
                        let next = view_fingerprint(&view);
                        if fingerprint != Some(next) {
                            revision += 1;
                            view.thread["revision"] = json!(revision);
                            if update.send(Some(Arc::new(view))).is_err() {
                                break;
                            }
                            fingerprint = Some(next);
                        }
                    }
                    Err(_) => {
                        let previous = update.borrow().clone();
                        if let Some(previous) = previous.filter(|v| {
                            v.thread["synchronized"] == true
                                || v.thread["boundedQuestionAvailable"] == true
                        }) {
                            let mut stale = (*previous).clone();
                            revision += 1;
                            stale.thread["revision"] = json!(revision);
                            stale.thread["synchronized"] = json!(false);
                            stale.thread["boundedQuestionAvailable"] = json!(false);
                            for field in ["canSend", "canSteer", "canInterrupt"] {
                                stale.thread[field] = json!(false);
                            }
                            if let Some(requests) = stale.thread["requests"].as_array_mut() {
                                for request in requests {
                                    request["actionable"] = json!(false);
                                }
                            }
                            stale.thread["reason"] = json!("Antigravity 连接已断开，正在重新同步");
                            if update.send(Some(Arc::new(stale))).is_err() {
                                break;
                            }
                            fingerprint = None;
                        }
                    }
                }
                tokio::select! {
                    _ = update.closed() => break,
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                }
            }
        });
        Ok(subscription)
    }

    async fn write(
        &self,
        thread: &str,
        request: Uuid,
        action: Write,
        _live: Option<Arc<Subscription>>,
        created: &RecordCreated<'_>,
    ) -> Delivery {
        if self.read_only {
            return Delivery::Rejected("Antigravity 当前为只读模式");
        }
        match action {
            Write::Respond(answer) => self.respond_to_interaction(thread, &answer).await,
            Write::Control(crate::plugins::Control::Permission {
                value,
                expected,
                expected_revision,
            }) => {
                self.set_permission(
                    thread,
                    &value,
                    expected.as_deref(),
                    expected_revision.as_deref(),
                )
                .await
            }
            Write::Send {
                text,
                files,
                skills,
                plugin_ids,
                model,
            } => {
                if self.validate_selection(&skills, &plugin_ids).is_err() {
                    return Delivery::Rejected("Antigravity 工具选项无效");
                }
                let text = text.trim();
                if !(valid_text(text) || text.is_empty() && !files.is_empty()) {
                    return Delivery::Rejected("请输入有效消息（最多 16000 字符）或添加附件");
                }
                let Ok(view) = self.snapshot(thread).await else {
                    return Delivery::Rejected("Antigravity 会话尚未同步");
                };
                if view.thread["canSend"] != true {
                    return Delivery::Rejected("此 Antigravity 会话当前不能发送消息");
                }
                let native_model = if let Some(model) = model {
                    let Ok(model) = self.native_model(&model).await else {
                        return Delivery::Rejected(
                            "所选模型当前不在 Antigravity 目录中，请重新选择",
                        );
                    };
                    Some(model)
                } else {
                    // Always send an explicit planModel so Antigravity never rejects
                    // execution after compaction with "plan model not specified".
                    let current = view.thread["model"]
                        .as_str()
                        .filter(|id| !id.is_empty());
                    match current {
                        Some(id) => self.native_model(id).await.ok(),
                        None => None,
                    }
                    .or_else(|| None)
                };
                let native_model = match native_model {
                    Some(model) => Some(model),
                    None => self
                        .model_catalog()
                        .await
                        .into_iter()
                        .next()
                        .map(|m| json!(m.native)),
                };
                let Ok(staged) = media::stage_uploads(&files).await else {
                    return Delivery::Rejected("Antigravity 附件无效、已变化或超过限制");
                };
                let Ok(prompt) = crate::files::attachment_prompt(text, &staged.files, false) else {
                    return Delivery::Rejected("Antigravity 附件路径无效");
                };
                let mut items = Vec::new();
                if !prompt.is_empty() {
                    items.push(json!({"text":prompt}));
                }
                if !skills.is_empty() {
                    let Ok(catalog) = self.skills(thread).await else {
                        return Delivery::Rejected("Antigravity 技能目录暂不可用");
                    };
                    let Ok(selected) = selected_skills(&catalog, &skills) else {
                        return Delivery::Rejected("所选技能已移除或当前会话不可用，请重新选择");
                    };
                    items.extend(selected);
                }
                if !plugin_ids.is_empty() {
                    let Ok(catalog) = self.plugins(thread).await else {
                        return Delivery::Rejected("Antigravity 插件目录暂不可用");
                    };
                    let Ok(selected) = plugin_selection::selected(&catalog, &plugin_ids) else {
                        return Delivery::Rejected("所选插件已移除或当前会话不可用，请重新选择");
                    };
                    items.extend(selected);
                }
                let mut body = json!({"cascadeId":thread,"items":items,"clientMessageId":request});
                if let Some(model) = native_model {
                    body["cascadeConfig"] = json!({"plannerConfig":{"planModel":model}});
                }
                if !staged.media.is_empty() {
                    body["media"] = json!(staged.media);
                }
                let result = self.dispatch("SendUserCascadeMessage", body).await;
                drop(staged);
                delivery(result, Delivery::Accepted(None))
            }
            Write::Steer {
                expected,
                text,
                files,
            } => {
                let text = text.trim();
                if (!text.is_empty() && !valid_text(text))
                    || (text.is_empty() && files.is_empty())
                {
                    return Delivery::Rejected("请输入追加指令或添加附件");
                }
                let Ok(view) = self.snapshot(thread).await else {
                    return Delivery::Rejected("Antigravity 会话尚未同步");
                };
                if view.thread["canSteer"] != true
                    || view.thread["activeTurnId"] != expected
                    || view.thread["pendingRequests"] != 0
                {
                    return Delivery::Rejected("Antigravity 当前任务已变化或正在等待确认");
                }
                let Ok(staged) = media::stage_uploads(&files).await else {
                    return Delivery::Rejected("Antigravity 附件无效、已变化或超过限制");
                };
                let Ok(prompt) = crate::files::attachment_prompt(text, &staged.files, false) else {
                    return Delivery::Rejected("Antigravity 附件路径无效");
                };
                let mut items = Vec::new();
                if !prompt.is_empty() {
                    items.push(json!({"text": prompt}));
                }
                let mut body = json!({
                    "cascadeId": thread,
                    "items": items,
                    "clientMessageId": request,
                    "deliveryStrategy": NEXT_INVOCATION,
                });
                if !staged.media.is_empty() {
                    body["media"] = json!(staged.media);
                }
                let result = self.dispatch("SendUserCascadeMessage", body).await;
                drop(staged);
                delivery(result, Delivery::Accepted(Some(expected)))
            }
            Write::Interrupt { expected } => {
                let Ok(view) = self.snapshot(thread).await else {
                    return Delivery::Rejected("Antigravity 会话尚未同步");
                };
                if view.thread["canInterrupt"] != true || view.thread["activeTurnId"] != expected {
                    return Delivery::Rejected("Antigravity 当前任务已变化");
                }
                delivery(
                    self.dispatch("CancelCascadeInvocation", json!({"cascadeId":thread}))
                        .await,
                    Delivery::Accepted(Some(expected)),
                )
            }
            Write::Queue { expected, text } => {
                queue::add(self, thread, request, &expected, &text).await
            }
            Write::RemoveQueued { expected, message } => {
                queue::remove(self, thread, &expected, &message).await
            }
            Write::Rename { title } => {
                if title.trim().is_empty() || !valid_title(&title) {
                    return Delivery::Rejected("会话名称无效");
                }
                if valid_id(thread).is_err() {
                    return Delivery::Rejected("Antigravity 会话标识无效");
                }
                let Ok(summaries) = self.summaries().await else {
                    return Delivery::Rejected("Antigravity 会话列表不可用");
                };
                if !summaries.contains_key(thread) {
                    return Delivery::Rejected("找不到 Antigravity 会话");
                }
                delivery(
                    self.rename(thread, title.trim()).await,
                    Delivery::Completed(None),
                )
            }
            Write::Create {
                title,
                prompt,
                project,
                settings,
                files,
                skills,
                plugin_ids,
            } => {
                if self.validate_selection(&skills, &plugin_ids).is_err() {
                    return Delivery::Rejected("Antigravity 工具选项无效");
                }
                let text = prompt.trim();
                if !(valid_text(text) || text.is_empty() && !files.is_empty()) {
                    return Delivery::Rejected("请输入第一条消息（最多 16000 字符）或添加附件");
                }
                if title.as_deref().is_some_and(|s| !valid_title(s)) {
                    return Delivery::Rejected("会话名称无效");
                }
                if settings.thinking.as_ref().is_some_and(|s| !s.is_empty())
                    || settings.permission.is_some()
                    || settings.preset.is_some()
                    || settings.plan.is_some()
                {
                    return Delivery::Rejected("Antigravity 暂不支持此新会话设置");
                }
                let Some(project) = project.filter(|s| !s.is_empty()) else {
                    return Delivery::Rejected("请选择 Antigravity 项目");
                };
                let Ok(projects) = self.project_catalog(true).await else {
                    return Delivery::Rejected("Antigravity 项目列表不可用");
                };
                if !projects
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|p| p["id"] == project)
                {
                    return Delivery::Rejected("Antigravity 项目不存在");
                }
                let mut config = json!({});
                if let Some(model) = settings.model {
                    let Ok(model) = self.native_model(&model).await else {
                        return Delivery::Rejected("模型不在 Antigravity 目录中");
                    };
                    config = json!({"plannerConfig":{"planModel":model}});
                } else if let Some(default_model) = self.model_catalog().await.into_iter().next() {
                    config = json!({"plannerConfig":{"planModel":default_model.native}});
                }
                let Ok(staged) = media::stage_uploads(&files).await else {
                    return Delivery::Rejected("Antigravity 附件无效、已变化或超过限制");
                };
                let Ok(prompt_text) = crate::files::attachment_prompt(text, &staged.files, false)
                else {
                    return Delivery::Rejected("Antigravity 附件路径无效");
                };
                let mut items = Vec::new();
                if !prompt_text.is_empty() {
                    items.push(json!({"text":prompt_text}));
                }
                if !skills.is_empty() {
                    let Ok(catalog) = self.creation_skills(Some(&project)).await else {
                        return Delivery::Rejected("Antigravity 技能目录暂不可用");
                    };
                    let Ok(selected) = selected_skills(&catalog, &skills) else {
                        return Delivery::Rejected("所选技能已移除或当前项目不可用，请重新选择");
                    };
                    items.extend(selected);
                }
                if !plugin_ids.is_empty() {
                    let Ok(catalog) = self.creation_plugins(Some(&project)).await else {
                        return Delivery::Rejected("Antigravity 插件目录暂不可用");
                    };
                    let Ok(selected) = plugin_selection::selected(&catalog, &plugin_ids) else {
                        return Delivery::Rejected("所选插件已移除或当前项目不可用，请重新选择");
                    };
                    items.extend(selected);
                }
                let result = self.dispatch("StartCascade", json!({"source":"CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT",
                    "trajectoryType":"CORTEX_TRAJECTORY_TYPE_CASCADE","projectEnvConfig":{"projectId":project,"defaultProjectEnvironment":{}}})).await;
                let result = match result {
                    Ok(v) => v,
                    Err(e) if e.is::<DownstreamUncertain>() => return Delivery::Uncertain,
                    Err(_) => return Delivery::Rejected("Antigravity 本地服务不可用"),
                };
                let Some(id) = result["cascadeId"]
                    .as_str()
                    .filter(|id| valid_id(id).is_ok())
                else {
                    return Delivery::Uncertain;
                };
                // Persist the new native identity before any further downstream mutation.
                if created(id).is_err() {
                    return Delivery::Uncertain;
                }
                if let Some(title) = title.filter(|s| !s.trim().is_empty()) {
                    if self.rename(id, title.trim()).await.is_err() {
                        return Delivery::Uncertain;
                    }
                }
                let mut body = json!({
                    "cascadeId": id,
                    "items": items,
                    "cascadeConfig": config,
                    "clientMessageId": request,
                });
                if !staged.media.is_empty() {
                    body["media"] = json!(staged.media);
                }
                let sent = self.dispatch("SendUserCascadeMessage", body).await;
                drop(staged);
                match sent {
                    Ok(_) => Delivery::Completed(Some(id.to_owned())),
                    Err(_) => Delivery::Uncertain,
                }
            }
            _ => Delivery::Rejected("此 Antigravity 操作尚不受支持"),
        }
    }
}
