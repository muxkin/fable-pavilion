use super::*;

impl DeviceSession {
    pub(super) fn plugin_write(&self, plugin: Arc<dyn Adapter>, method: &str, call: &Value) -> Result<Value> {
        let thread = plugin_thread(&call["params"]["id"])?;
        let (request, action, draft_uploads) = match method {
            "thread.open" => {
                ensure!(
                    call["body"].as_object().is_some_and(|body| body.len() == 1),
                    "DSH 打开请求无效"
                );
                (
                    serde_json::from_value(call["body"]["requestId"].clone())?,
                    Write::Open,
                    None,
                )
            }
            "request.respond" => {
                let response: crate::requests::Response =
                    serde_json::from_value(call["body"].clone())?;
                response.validate()?;
                (response.request_id, Write::Respond(response), None)
            }
            "settings.update" => {
                let mut body = call["body"].clone();
                let fields = body.as_object_mut().context("DSH 模型设置无效")?;
                let request =
                    serde_json::from_value(fields.remove("requestId").unwrap_or_default())?;
                ensure!(
                    fields.contains_key("expectedModel") && fields.contains_key("expectedEffort"),
                    "DSH 模型状态缺失"
                );
                (
                    request,
                    Write::Settings(serde_json::from_value::<ModelSettings>(body)?),
                    None,
                )
            }
            "control.execute" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct ControlRequest {
                    request_id: Uuid,
                    control: Control,
                }
                let body: ControlRequest = serde_json::from_value(call["body"].clone())?;
                if matches!(&body.control, Control::Permission { .. }) {
                    ensure!(
                        call["body"]["control"].get("expected").is_some(),
                        "DSH 权限状态缺失"
                    );
                }
                (body.request_id, Write::Control(body.control), None)
            }
            _ => {
                serde_json::from_value::<PluginRequest>(call["body"].clone())?.parse(
                    method,
                    plugin.as_ref(),
                    |draft, ids| {
                        let scope = match draft {
                            Some(draft) => Scope::codex_draft(plugin.id(), draft),
                            None => Scope::plugin(plugin.id(), thread),
                        };
                        let store = self.db.lock().expect("database mutex poisoned");
                        ids.iter()
                            .map(|id| store.verified_upload(&self.device.id, &scope, *id))
                            .collect()
                    },
                )?
            }
        };
        let live = self
            .plugin_watches
            .get(&(plugin.id().to_owned(), thread.to_owned()))
            .map(|watch| watch.live.clone());
        if !matches!(
            &action,
            Write::Create { .. } | Write::Open | Write::Rename { .. }
        ) {
            ensure!(live.is_some(), "请先打开 DSH 会话");
        }
        let admission = plugin.admit_write()?;
        let (operation, fresh) = self
            .db
            .lock()
            .expect("database mutex poisoned")
            .begin_plugin(plugin.id(), request, &self.device.id, thread, &action)
            .map_err(|_| Conflict)?;
        if fresh {
            let db = self.db.clone();
            let device_id = self.device.id.clone();
            let thread = thread.to_owned();
            let activity = self.activity.clone();
            tokio::spawn(async move {
                let _activity = activity;
                let _admission = admission;
                let created = |id: &str| {
                    db.lock().expect("database mutex poisoned").record_plugin_thread(
                        plugin.id(),
                        request,
                        id,
                        draft_uploads.as_ref().map(|draft| (device_id.as_str(), draft)),
                    )
                };
                let result = timeout(
                    action.dispatch_timeout(),
                    plugin.write(&thread, request, action, live.clone(), &created),
                )
                .await
                .unwrap_or(Delivery::Uncertain);
                let view = live.and_then(|live| live.0.borrow().clone());
                let mut db = db.lock().expect("database mutex poisoned");
                if db.finish_plugin(plugin.id(), request, result).is_ok()
                    && let Some(view) = view.filter(|value| value.thread["synchronized"] == true)
                {
                    let _ = db.observe_plugin(plugin.id(), &thread, &view.observations);
                }
            });
        }
        Ok(operation)
    }

    pub(super) async fn rpc(&mut self, call: Value) -> Result<Option<Value>> {
        let method = call["method"].as_str().unwrap_or_default();
        ensure!(
            !rpc_activity(method) || self.backends.update_gate.connection_allowed(),
            "正在准备更新"
        );
        if matches!(
            method,
            "security.backup.status" | "security.backup.import" | "security.backup.challenge"
        ) {
            let service = self
                .backends
                .account_security
                .as_ref()
                .context("此适配器尚未启用秘钥簿")?;
            let value = if method == "security.backup.status" {
                service.status(&call["query"]).await?
            } else if method == "security.backup.challenge" {
                let db = self.db.lock().expect("database mutex poisoned");
                service.challenge(call["body"].clone(), &db.identity, &self.device.id)?
            } else {
                let host = self
                    .db
                    .lock()
                    .expect("database mutex poisoned")
                    .identity
                    .public()
                    .to_peer_id()
                    .to_string();
                service
                    .import(&host, &self.device.id, call["body"].clone())
                    .await?
            };
            return Ok(Some(value));
        }
        if method == "backends.list" {
            let mut backends: Vec<_> = self
                .backends
                .codex
                .all()
                .filter_map(|(id, backend)| backend.info(id, self.online(id)))
                .collect();
            backends.extend(self.backends.plugins.infos().await);
            let store = self.db.lock().expect("database mutex poisoned");
            for info in &mut backends {
                let id = info["id"].as_str().context("实例 ID 无效")?;
                appearance::Saved::read(&store.db, id)?.apply(info);
            }
            return Ok(Some(json!({"backends":backends})));
        }
        if matches!(
            method,
            "backends.appearance.read" | "backends.appearance.update"
        ) {
            return self
                .backend_appearance(&call, method == "backends.appearance.update")
                .await;
        }
        if method == "device.revoke" {
            self.db
                .lock()
                .expect("database mutex poisoned")
                .revoke_device(&self.device.id)?;
            return Ok(Some(json!({"ok":true})));
        }
        let Some(backend) = backend_id(&call) else {
            return Ok(None);
        };
        if method == "usage.reset" {
            let connector = self
                .backends
                .codex
                .get(backend)
                .ok_or(ResetError::Unavailable)?;
            return self
                .reset_usage(backend, connector, &call["body"])
                .await
                .map(Some);
        }
        let Some(connector) = self.backends.codex.get(backend) else {
            let Some(plugin) = call["backendId"]
                .as_str()
                .and_then(|id| self.backends.plugins.get(id))
            else {
                return Ok(None);
            };
            return match method {
                "status.read" => Ok(Some(plugin.status().await)),
                "session.read" => Ok(Some(json!({
                    "device":{"id":self.device.id,"name":self.device.name},
                    "status":plugin.status().await,"backend":plugin.info().await,
                }))),
                "operation.read" => {
                    let id = thread_id(&call["params"]["id"])?;
                    self.db
                        .lock()
                        .expect("database mutex poisoned")
                        .operation_for(plugin.id(), &self.device.id, &id.to_string())
                }
                "operations.list" => {
                    let thread = plugin_thread(&call["params"]["id"])?;
                    let operations = self
                        .db
                        .lock()
                        .expect("database mutex poisoned")
                        .recent_operations_for(plugin.id(), &self.device.id, thread)?;
                    Ok(Some(json!(operations)))
                }
                "upload.begin" => {
                    let thread = plugin_thread(&call["params"]["id"])?;
                    let is_draft = codex_draft_id(&call["params"]["id"])?.is_some();
                    let writable = is_draft
                        || self
                            .plugin_watches
                            .get(&(plugin.id().to_owned(), thread.to_owned()))
                            .and_then(|watch| watch.live.0.borrow().clone())
                            .is_some_and(|view| view.thread["synchronized"] == true);
                    ensure!(writable && plugin.uploads_enabled(), "请先同步可写会话");
                    self.begin_upload(Scope::plugin(plugin.id(), thread), call["body"].clone())
                        .await
                }
                "upload.finish" => {
                    let thread = plugin_thread(&call["params"]["id"])?;
                    self.finish_compatible_upload(Scope::plugin(plugin.id(), thread), &call)
                        .await
                }
                "media.describe" | "log.export" => {
                    let thread = plugin_thread(&call["params"]["id"])?;
                    let scope = Scope::plugin(plugin.id(), thread);
                    let media = if method == "log.export" {
                        Media::Download(plugin.export_log(thread).await?)
                    } else {
                        let reference = call["body"]["path"]
                            .as_str()
                            .filter(|path| (1..=4096).contains(&path.encode_utf16().count()))
                            .context("附件地址无效")?;
                        if let Some(manifest) = self
                            .describe_staged_upload(scope.clone(), reference)
                            .await?
                        {
                            return Ok(Some(manifest));
                        }
                        plugin.media(thread, reference).await?
                    };
                    let db = self.db.clone();
                    let device = self.device.id.clone();
                    let backend = plugin.id().to_owned();
                    let thread = thread.to_owned();
                    let batch = self
                        .backends
                        .storage
                        .as_ref()
                        .map(crate::storage::Storage::batch);
                    let activity = self.activity.clone();
                    tokio::task::spawn_blocking(move || {
                        let _activity = activity;
                        let source = match media {
                            Media::Download(source) => source,
                            Media::VerifiedFile {
                                name,
                                size,
                                attachment_id,
                                sha256,
                            } => {
                                let retained = db
                                    .lock()
                                    .expect("database mutex poisoned")
                                    .retained_attachment(&scope, &sha256)?;
                                let file = match retained {
                                    Some(file) => file,
                                    None => history_media::legacy_dsh_file(
                                        &backend,
                                        &thread,
                                        &attachment_id,
                                    )?,
                                };
                                history_media::Source {
                                    file,
                                    name,
                                    expected: Some((size, sha256)),
                                }
                            }
                        };
                        let download = Download::prepare(source, device, scope, batch)?;
                        db.lock()
                            .expect("database mutex poisoned")
                            .register_download(download)
                            .map(Some)
                    })
                    .await?
                }
                "message.send" | "turn.steer" | "turn.interrupt" | "thread.rename"
                | "thread.create" | "queue.add" | "queue.remove" | "settings.update"
                | "control.execute" | "request.respond" | "thread.open" => {
                    self.plugin_write(plugin, method, &call).map(Some)
                }
                _ => plugin.read(method, &call["params"], &call["query"]).await,
            };
        };
        let online = self.online(backend);
        match method {
            "status.read" => Ok(Some(connector.status(online))),
            "session.read" => Ok(Some(json!({
                "device":{"id":self.device.id,"name":self.device.name},
                "status":connector.status(online),"backend":connector.info(backend, online),
            }))),
            "media.describe" => {
                let target = &call["params"]["id"];
                let path = call["body"]["path"]
                    .as_str()
                    .filter(|path| (1..=4096).contains(&path.encode_utf16().count()))
                    .context("附件地址无效")?
                    .to_owned();
                let scope = codex_file_scope(backend, target)?;
                if let Some(manifest) = self.describe_staged_upload(scope.clone(), &path).await? {
                    return Ok(Some(manifest));
                }
                let thread = thread_id(target)?;
                let db = self.db.clone();
                let device = self.device.id.clone();
                let batch = self
                    .backends
                    .storage
                    .as_ref()
                    .map(crate::storage::Storage::batch);
                let live = self
                    .codex_watch(backend, thread)
                    .and_then(|watch| watch.live.as_ref());
                let source = connector.media(thread, device.clone(), path, live).await?;
                let activity = self.activity.clone();
                tokio::task::spawn_blocking(move || {
                    let _activity = activity;
                    let download = Download::prepare(source, device, scope, batch)?;
                    db.lock()
                        .expect("database mutex poisoned")
                        .register_download(download)
                        .map(Some)
                })
                .await?
            }
            "upload.begin" if connector.has_desktop() => {
                let target = &call["params"]["id"];
                let scope = if let Some(draft) = codex_draft_id(target)? {
                    ensure!(
                        connector.has_creation_attachments(),
                        "此 Codex 实例不支持新会话附件"
                    );
                    Scope::codex_draft(backend, draft)
                } else {
                    let thread = thread_id(target)?;
                    ensure!(self.codex_watch(backend, thread).is_some(), "请先打开会话");
                    Scope::codex(backend, thread)
                };
                self.begin_upload(scope, call["body"].clone()).await
            }
            "upload.finish" => {
                self.finish_compatible_upload(
                    codex_file_scope(backend, &call["params"]["id"])?,
                    &call,
                )
                .await
            }
            "operation.read" => {
                let id = thread_id(&call["params"]["id"])?;
                Ok(self
                    .db
                    .lock()
                    .expect("database mutex poisoned")
                    .operation_for(backend, &self.device.id, &id.to_string())?)
            }
            "operations.list" => {
                let id = if call["params"]["id"] == "new" {
                    "new".to_owned()
                } else {
                    thread_id(&call["params"]["id"])?.to_string()
                };
                let values = self
                    .db
                    .lock()
                    .expect("database mutex poisoned")
                    .recent_operations_for(backend, &self.device.id, &id)?;
                Ok(Some(json!(values)))
            }
            "message.send" | "turn.steer" | "turn.interrupt" if connector.has_desktop() => self
                .execute(backend, connector, method, &call)
                .await
                .map(Some),
            "queue.add" | "queue.remove" => {
                let thread = thread_id(&call["params"]["id"])?;
                let mut change: queue::Change = serde_json::from_value(call["body"].clone())?;
                change.validate(method == "queue.add")?;
                self.dispatch(
                    backend,
                    connector,
                    thread,
                    change.request_id,
                    Action::Queue { change },
                )
                .map(Some)
            }
            "request.respond" => {
                let thread = thread_id(&call["params"]["id"])?;
                let response: requests::Response = serde_json::from_value(call["body"].clone())?;
                response.validate()?;
                self.dispatch(
                    backend,
                    connector,
                    thread,
                    response.request_id,
                    Action::Respond { response },
                )
                .map(Some)
            }
            "settings.update" | "control.execute" => {
                let thread = thread_id(&call["params"]["id"])?;
                let mut body = call["body"].clone();
                let request = thread_id(
                    &body
                        .as_object_mut()
                        .context("设置参数无效")?
                        .remove("requestId")
                        .context("设置参数无效")?,
                )?;
                let action = if method == "settings.update" {
                    let models = connector
                        .read("models.list", &Value::Null, &Value::Null, None)
                        .await?
                        .context("尚未配置 Codex")?;
                    Action::Settings {
                        input: settings::model_change(&body, &models)?,
                    }
                } else {
                    ensure!(
                        body.as_object().is_some_and(|value| value.len() == 1),
                        "设置参数无效"
                    );
                    Action::Permission {
                        input: settings::permission_change(&body["control"])?,
                    }
                };
                self.dispatch(backend, connector, thread, request, action)
                    .map(Some)
            }
            "thread.open" | "thread.create" | "thread.rename" | "thread.fork" => {
                self.manage(backend, connector, method, &call).map(Some)
            }
            "usage.read" => {
                let watched = self
                    .watches
                    .keys()
                    .find(|(id, _)| id == backend)
                    .map(|(_, thread)| thread);
                connector
                    .read(method, &json!({"id":watched}), &call["query"], None)
                    .await
            }
            _ => {
                let live = thread_id(&call["params"]["id"])
                    .ok()
                    .and_then(|id| self.codex_watch(backend, id))
                    .and_then(|watch| watch.live.as_ref());
                connector
                    .read(method, &call["params"], &call["query"], live)
                    .await
            }
        }
    }

    pub(super) async fn reset_usage(&self, backend: &str, connector: &Backend, body: &Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Request<'a> {
            proof: &'a str,
            request_id: Uuid,
        }

        let Request { proof, request_id } =
            Request::deserialize(body).map_err(|_| ResetError::InvalidProof)?;
        ensure!(
            !request_id.is_nil()
                && proof.len() == 43
                && proof
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
            ResetError::InvalidProof,
        );
        let active = self.backends.usage_reset.admit()?;
        let host = self
            .db
            .lock()
            .expect("database mutex poisoned")
            .identity
            .public()
            .to_peer_id()
            .to_string();
        let device = self.device.id.clone();
        self.backends
            .usage_reset
            .redeem(proof, &host, &device, backend, request_id)
            .await?;
        self.ensure_device().map_err(|_| ResetError::InvalidProof)?;
        let receipt = self
            .db
            .lock()
            .expect("database mutex poisoned")
            .usage_reset_receipt(backend, &device, request_id)
            .map_err(|error| {
                error
                    .downcast_ref::<ResetError>()
                    .copied()
                    .unwrap_or(ResetError::Uncertain)
            })?;
        if let Some(receipt) = receipt {
            return Ok(serde_json::to_value(receipt)?);
        }
        ensure!(connector.has_usage_reset(), ResetError::Unavailable);
        let admission = connector
            .admit_write()
            .map_err(|_| ResetError::Unavailable)?;
        let thread = self
            .watches
            .keys()
            .find(|(id, _)| id == backend)
            .map(|(_, thread)| *thread);
        let db = self.db.clone();
        let connector = connector.clone();
        let backend = backend.to_owned();
        // Once authorized, preserve the receipt if the browser disconnects before the reply.
        let activity = self.activity.clone();
        let result = tokio::spawn(async move {
            let _activity = activity;
            let _active = active;
            let _admission = admission;
            let result = connector.reset_usage(thread, request_id).await?;
            db.lock()
                .expect("database mutex poisoned")
                .record_usage_reset(&backend, &device, request_id, &result)
                .map_err(|_| ResetError::Uncertain)?;
            Ok::<_, ResetError>(result)
        })
        .await
        .map_err(|_| ResetError::Uncertain)??;
        Ok(serde_json::to_value(result)?)
    }

    pub(super) async fn backend_appearance(&self, call: &Value, write: bool) -> Result<Option<Value>> {
        let Some(id) = call["params"]["id"].as_str() else {
            return Ok(None);
        };
        let info = if let Some(backend) = self.backends.codex.get(id) {
            backend.info(id, self.online(id))
        } else if let Some(plugin) = self.backends.plugins.get(id) {
            Some(plugin.info().await)
        } else {
            None
        };
        let Some(info) = info else { return Ok(None) };
        let saved = if write {
            let body = call["body"].clone();
            let change =
                tokio::task::spawn_blocking(move || appearance::Change::parse(body)).await??;
            let mut store = self.db.lock().expect("database mutex poisoned");
            appearance::Saved::update(&mut store.db, id, change)?
        } else {
            let store = self.db.lock().expect("database mutex poisoned");
            appearance::Saved::read(&store.db, id)?
        };
        Ok(Some(saved.document(&info)))
    }

    pub(super) fn manage(
        &self,
        backend: &str,
        connector: &Backend,
        method: &str,
        call: &Value,
    ) -> Result<Value> {
        ensure!(connector.has_desktop(), "尚未连接 Codex");
        let (request, mut change, draft) =
            serde_json::from_value::<conversations::Request>(call["body"].clone())?
                .parse(method)?;
        if change.first_turn().is_some() {
            ensure!(
                connector.has_creation_tools(),
                "此 Codex 实例不支持新会话工具"
            );
        }
        let (thread, live) = if method == "thread.create" && call["params"]["id"] == "new" {
            ("new".to_owned(), None)
        } else {
            let id = thread_id(&call["params"]["id"])?;
            (
                id.to_string(),
                self.codex_watch(backend, id)
                    .and_then(|watch| watch.live.clone()),
            )
        };
        let admission = connector.admit_write()?;
        let device = self.device.id.clone();
        let (operation, fresh) = {
            let mut store = self.db.lock().expect("database mutex poisoned");
            if let Some(draft) = &draft {
                ensure!(
                    connector.has_creation_attachments(),
                    "此 Codex 实例不支持新会话附件"
                );
                let conversations::Change::Create { files, .. } = &mut change else {
                    unreachable!("only create requests accept a draft");
                };
                let scope = Scope::codex_draft(backend, draft.id);
                *files = draft
                    .uploads
                    .iter()
                    .map(|id| store.attachment(&device, &scope, *id))
                    .collect::<Result<_>>()?;
            }
            store
                .begin_management(backend, request, &device, &thread, change.name(), &change)
                .map_err(|_| Conflict)?
        };
        if fresh {
            let db = self.db.clone();
            let connector = connector.clone();
            let backend = backend.to_owned();
            let first = change.first_turn();
            let activity = self.activity.clone();
            tokio::spawn(async move {
                let _activity = activity;
                let _admission = admission;
                let mut outcome = connector
                    .manage(thread, live.as_ref(), request, change)
                    .await;
                if let (Some(first), crate::codex_live::Outcome::Completed(Some(created))) =
                    (first, &outcome)
                {
                    let created = *created;
                    let recorded = db
                        .lock()
                        .expect("database mutex poisoned")
                        .record_codex_created(&backend, request, &device, created, draft.as_ref())
                        .is_ok();
                    outcome = if recorded {
                        connector.send_first_turn(created, request, first).await
                    } else {
                        crate::codex_live::Outcome::Uncertain
                    };
                }
                let mut store = db.lock().expect("database mutex poisoned");
                if let Some(draft) = draft {
                    if store
                        .finish_create_with_uploads(&backend, request, &device, &draft, outcome)
                        .is_err()
                    {
                        let _ = store.finish_operation(
                            &backend,
                            request,
                            crate::codex_live::Outcome::Uncertain,
                        );
                    }
                } else {
                    let _ = store.finish_operation(&backend, request, outcome);
                }
            });
        }
        Ok(operation)
    }

    pub(super) async fn execute(
        &self,
        backend: &str,
        connector: &Backend,
        method: &str,
        call: &Value,
    ) -> Result<Value> {
        let thread_id = thread_id(&call["params"]["id"])?;
        let (request, mut action, skills, plugins) = action(method, &call["body"], |ids| {
            let store = self.db.lock().expect("database mutex poisoned");
            let scope = Scope::codex(backend, thread_id);
            ids.iter()
                .map(|id| store.attachment(&self.device.id, &scope, *id))
                .collect()
        })?;
        if let Action::Send { tools, .. } = &mut action
            && (!skills.is_empty() || !plugins.is_empty())
        {
            let live = self
                .codex_watch(backend, thread_id)
                .and_then(|watch| watch.live.as_ref());
            *tools = connector
                .select_tools(thread_id, live, &skills, &plugins)
                .await?;
        }
        self.dispatch(backend, connector, thread_id, request, action)
    }

    pub(super) fn dispatch(
        &self,
        backend: &str,
        connector: &Backend,
        thread_id: Uuid,
        request: Uuid,
        action: Action,
    ) -> Result<Value> {
        let thread = self
            .codex_watch(backend, thread_id)
            .and_then(|watch| watch.live.clone())
            .context("请先打开会话")?;
        let admission = connector.admit_write()?;
        let (operation, fresh) = self
            .db
            .lock()
            .expect("database mutex poisoned")
            .begin_operation(backend, request, &self.device.id, thread_id, &action)
            .map_err(|_| Conflict)?;
        if fresh {
            let db = self.db.clone();
            let connector = connector.clone();
            let backend = backend.to_owned();
            let activity = self.activity.clone();
            tokio::spawn(async move {
                let _activity = activity;
                let _admission = admission;
                let outcome = connector.execute(thread_id, &thread, request, action).await;
                let _ = db
                    .lock()
                    .expect("database mutex poisoned")
                    .finish_operation(&backend, request, outcome);
            });
        }
        Ok(operation)
    }
}
