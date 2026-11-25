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
        if method == "desktop.claim" {
            let origin = self.backends.usage_reset.origin();
            let identity = self
                .db
                .lock()
                .expect("database mutex poisoned")
                .identity
                .clone();
            let authorization = crate::desktop_authorization::sign_claim(&origin, &identity)?;
            return Ok(Some(json!({"authorization": authorization})));
        }
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
        if method.starts_with("plugins.manage.") {
            let manager = self
                .backends
                .plugin_manager
                .as_ref()
                .context("此适配器暂不支持插件管理")?;
            let value = match method {
                "plugins.manage.read" => manager.snapshot().await?,
                "plugins.manage.builtin.update" => {
                    manager.update_builtin(call["body"].clone()).await?
                }
                "plugins.manage.instance.upsert" => {
                    manager.upsert_instance(call["body"].clone()).await?
                }
                "plugins.manage.instance.toggle" => {
                    let mut body = call["body"].clone();
                    if body.get("id").is_none()
                        && let Some(id) = call["params"]["id"].as_str()
                    {
                        body["id"] = json!(id);
                    }
                    manager.toggle_instance(body).await?
                }
                "plugins.manage.instance.delete" => {
                    let id = call["params"]["id"]
                        .as_str()
                        .or_else(|| call["body"]["id"].as_str())
                        .context("插件实例 ID 无效")?;
                    manager.delete_instance(id).await?
                }
                "plugins.manage.switch" => {
                    manager.switch_instance(call["body"].clone()).await?
                }
                _ => return Ok(None),
            };
            return Ok(Some(value));
        }
        if method.starts_with("terminal.") {
            let terminal = self
                .backends
                .terminal
                .as_ref()
                .context("此适配器暂不支持终端插件")?;
            let value = match method {
                "terminal.sessions.list" => json!({
                    "sessions": terminal.list_sessions()?,
                    "status": terminal.status(),
                }),
                "terminal.session.create" => {
                    let req: crate::terminal::CreateSessionRequest =
                        serde_json::from_value(call["body"].clone()).unwrap_or_default();
                    let session = terminal.create_session(req).await?;
                    json!({ "session": session })
                }
                "terminal.session.resize" => {
                    let id = call["params"]["id"].as_str().context("终端会话 ID 无效")?;
                    let cols = call["body"]["cols"].as_u64().unwrap_or(100) as u16;
                    let rows = call["body"]["rows"].as_u64().unwrap_or(30) as u16;
                    terminal.resize(id, cols, rows)?;
                    json!({ "ok": true })
                }
                "terminal.session.close" => {
                    let id = call["params"]["id"].as_str().context("终端会话 ID 无效")?;
                    let closed = terminal.close_session(id)?;
                    json!({ "ok": true, "closed": closed })
                }
                "terminal.fs.list" => {
                    let id = call["params"]["id"].as_str().context("终端会话 ID 无效")?;
                    let path = call["body"]["path"].as_str();
                    let show_hidden = call["body"]["showHidden"] == true;
                    terminal.fs_list(id, path, show_hidden)?
                }
                "terminal.fs.mkdir" => {
                    let id = call["params"]["id"].as_str().context("终端会话 ID 无效")?;
                    let path = call["body"]["path"].as_str();
                    let name = call["body"]["name"].as_str().context("目录名无效")?;
                    terminal.fs_mkdir(id, path, name)?
                }
                "terminal.fs.rename" => {
                    let id = call["params"]["id"].as_str().context("终端会话 ID 无效")?;
                    let path = call["body"]["path"].as_str().context("路径无效")?;
                    let name = call["body"]["name"].as_str().context("新名称无效")?;
                    terminal.fs_rename(id, path, name)?
                }
                "terminal.fs.delete" => {
                    let id = call["params"]["id"].as_str().context("终端会话 ID 无效")?;
                    let path = call["body"]["path"].as_str().context("路径无效")?;
                    terminal.fs_delete(id, path)?
                }
                "terminal.forwards.list" => json!({
                    "forwards": terminal.list_forwards()?,
                    "capabilities": terminal.capabilities(),
                }),
                "terminal.forward.create" => {
                    let host = call["body"]["targetHost"].as_str().unwrap_or("127.0.0.1");
                    let port = call["body"]["targetPort"].as_u64().unwrap_or(0) as u16;
                    let forward = terminal.create_tcp_forward(host, port)?;
                    json!({ "forward": forward })
                }
                "terminal.forward.close" => {
                    let id = call["params"]["id"].as_str().context("端口转发 ID 无效")?;
                    let closed = terminal.close_forward(id)?;
                    json!({ "ok": true, "closed": closed })
                }
                "terminal.forward.http" => {
                    let id = call["params"]["id"].as_str().context("端口转发 ID 无效")?;
                    let http_method = call["body"]["method"].as_str().unwrap_or("GET");
                    let path = call["body"]["path"].as_str().unwrap_or("/");
                    let body = call["body"]["body"].as_str();
                    terminal.forward_http(id, http_method, path, body).await?
                }
                _ => return Ok(None),
            };
            return Ok(Some(value));
        }
        if method == "backends.list" {
            let mut backends: Vec<_> = self
                .backends
                .codex
                .all()
                .filter_map(|(id, backend)| backend.info(id, self.live_transport(id)))
                .collect();
            backends.extend(self.backends.plugins.infos().await);
            if let Some(terminal_info) = self
                .backends
                .terminal
                .as_ref()
                .and_then(|service| service.backend_info())
            {
                backends.push(terminal_info);
            }
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
        if method == "fs.directories" {
            let path = call["body"]["path"]
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            let include_hidden = call["body"]["includeHidden"] == true;
            let extra_roots: Vec<String> = self
                .db
                .lock()
                .expect("database mutex poisoned")
                .list_backend_projects(backend_id(&call).unwrap_or(CODEX))
                .unwrap_or_default()
                .into_iter()
                .filter_map(|(_, _, p)| {
                    std::path::Path::new(&p)
                        .parent()
                        .map(|parent| parent.to_string_lossy().into_owned())
                })
                .collect();
            let result = tokio::task::spawn_blocking(move || {
                browse_directories(path.as_deref(), include_hidden, &extra_roots)
            })
            .await??;
            return Ok(Some(result));
        }
        if method == "fs.mkdir" {
            let parent = call["body"]["parent"]
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .context("上级目录路径无效")?
                .to_owned();
            let name = call["body"]["name"]
                .as_str()
                .context("文件夹名称无效")?
                .to_owned();
            let result =
                tokio::task::spawn_blocking(move || create_directory(&parent, &name)).await??;
            return Ok(Some(result));
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
            if backend == crate::terminal::BACKEND_ID
                && let Some(terminal) = self.backends.terminal.as_ref()
                && let Some(info) = terminal.backend_info()
            {
                return match method {
                    "status.read" => Ok(Some(terminal.status())),
                    "session.read" => Ok(Some(json!({
                        "device": {"id": self.device.id, "name": self.device.name},
                        "status": terminal.status(),
                        "backend": info,
                    }))),
                    _ => Ok(None),
                };
            }
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
        let transport = self.live_transport(backend);
        match method {
            "status.read" => Ok(Some(connector.status(transport))),
            "session.read" => Ok(Some(json!({
                "device":{"id":self.device.id,"name":self.device.name},
                "status":connector.status(transport),"backend":connector.info(backend, transport),
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
                    codex_control(&body["control"])?
                };
                self.dispatch(backend, connector, thread, request, action)
                    .map(Some)
            }
            "thread.open" | "thread.create" | "thread.rename" | "thread.fork" => {
                self.manage(backend, connector, method, &call).map(Some)
            }
            "project.create" => {
                ensure!(
                    connector.has_creation_tools(),
                    "当前 Codex 实例暂不支持新建项目"
                );
                let raw_path = call["body"]["path"]
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && value.encode_utf16().count() <= 1024)
                    .context("请选择电脑上的文件夹")?
                    .to_owned();
                ensure!(
                    !raw_path.chars().any(char::is_control),
                    "文件夹路径包含无效字符"
                );
                let raw_name = call["body"]["name"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .to_owned();
                ensure!(
                    raw_name.encode_utf16().count() <= 120 && !raw_name.chars().any(char::is_control),
                    "项目名称无效"
                );
                let canonical = tokio::task::spawn_blocking(move || {
                    let path =
                        std::fs::canonicalize(&raw_path).context("所选电脑文件夹不存在或不可访问")?;
                    ensure!(path.is_dir(), "所选路径不是文件夹");
                    Ok::<_, anyhow::Error>(path.to_string_lossy().into_owned())
                })
                .await??;
                if let Ok(Some(native)) = connector
                    .read("creation.projects", &json!({"id": "new"}), &Value::Null, None)
                    .await
                    && let Some(existing) = native["projects"].as_array().and_then(|rows| {
                        rows.iter().find(|row| {
                            row["path"]
                                .as_str()
                                .and_then(|p| std::fs::canonicalize(p).ok())
                                .is_some_and(|p| p.to_string_lossy() == canonical)
                        })
                    })
                {
                    return Ok(Some(json!({
                        "project": {
                            "id": existing["id"],
                            "name": existing["name"],
                            "path": canonical,
                        },
                        "existing": true,
                    })));
                }
                let (id, name, path) = self
                    .db
                    .lock()
                    .expect("database mutex poisoned")
                    .save_backend_project(backend, &raw_name, &canonical)?;
                Ok(Some(json!({
                    "project": { "id": id, "name": name, "path": path },
                    "existing": false,
                })))
            }
            "projects.list" | "creation.projects" => {
                let mut result = connector
                    .read(method, &call["params"], &call["query"], None)
                    .await?;
                let saved = self
                    .db
                    .lock()
                    .expect("database mutex poisoned")
                    .list_backend_projects(backend)?;
                if !saved.is_empty()
                    && let Some(value) = result.as_mut()
                {
                    let native_paths = if method == "projects.list" {
                        connector
                            .read("creation.projects", &json!({"id": "new"}), &Value::Null, None)
                            .await
                            .ok()
                            .flatten()
                            .and_then(|v| v["projects"].as_array().cloned())
                            .unwrap_or_default()
                    } else {
                        Vec::new()
                    };
                    merge_backend_projects(
                        value,
                        &saved,
                        &native_paths,
                        method == "projects.list",
                    );
                }
                Ok(result)
            }
            "skills.list" | "plugins.list" => {
                let mut query = call["query"].clone();
                if query["creation"] == "1"
                    && let Some(project_id) = query["projectId"].as_str()
                    && project_id.starts_with("dir:")
                {
                    let found = self
                        .db
                        .lock()
                        .expect("database mutex poisoned")
                        .find_backend_project(backend, project_id)?;
                    if let Some((_, path)) = found
                        && let Some(obj) = query.as_object_mut()
                    {
                        obj.remove("projectId");
                        obj.insert("projectPath".into(), json!(path));
                    }
                }
                let live = thread_id(&call["params"]["id"])
                    .ok()
                    .and_then(|id| self.codex_watch(backend, id))
                    .and_then(|watch| watch.live.as_ref());
                connector
                    .read(method, &call["params"], &query, live)
                    .await
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
        ensure!(connector.has_usage_reset(), ResetError::Unavailable);
        let admission = connector
            .admit_write()
            .map_err(|_| ResetError::Unavailable)?;
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
        let thread = self
            .watches
            .keys()
            .find(|(id, _)| id == backend)
            .map(|(_, thread)| *thread);
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
        if let Some(mut receipt) = receipt {
            receipt.usage = connector
                .read(
                    "usage.read",
                    &json!({"id": thread}),
                    &json!({"refresh": "1"}),
                    None,
                )
                .await
                .ok()
                .flatten();
            return Ok(serde_json::to_value(receipt)?);
        }
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
            backend.info(id, self.live_transport(id))
        } else if let Some(plugin) = self.backends.plugins.get(id) {
            Some(plugin.info().await)
        } else if id == crate::terminal::BACKEND_ID {
            self.backends
                .terminal
                .as_ref()
                .and_then(|service| service.backend_info())
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
        let mut body = call["body"].clone();
        if method == "thread.create"
            && let Some(project_id) = body["projectId"].as_str().map(str::to_owned)
            && project_id.starts_with("dir:")
        {
            let (_, path) = self
                .db
                .lock()
                .expect("database mutex poisoned")
                .find_backend_project(backend, &project_id)?
                .context("找不到该项目对应的电脑文件夹，请重新添加项目")?;
            if let Some(map) = body.as_object_mut() {
                map.remove("projectId");
                map.insert("projectPath".into(), json!(path));
            }
        }
        let (request, mut change, draft) =
            serde_json::from_value::<conversations::Request>(body)?.parse(method)?;
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

fn canonical_path_key(raw: &str) -> String {
    std::fs::canonicalize(raw)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw.to_owned())
}

fn merge_backend_projects(
    value: &mut Value,
    saved: &[(String, String, String)],
    native_catalog: &[Value],
    include_count: bool,
) {
    let Some(rows) = value["projects"].as_array_mut() else {
        return;
    };
    let mut known_ids: std::collections::HashSet<String> = rows
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect();
    let mut known_paths: std::collections::HashSet<String> = rows
        .iter()
        .chain(native_catalog.iter())
        .filter_map(|row| row["path"].as_str())
        .filter(|path| !path.is_empty())
        .map(canonical_path_key)
        .collect();
    for (id, name, path) in saved {
        if !std::path::Path::new(path).is_dir() {
            continue;
        }
        let key = canonical_path_key(path);
        if known_ids.contains(id) || known_paths.contains(&key) {
            continue;
        }
        known_ids.insert(id.clone());
        known_paths.insert(key);
        let entry = if include_count {
            json!({ "id": id, "name": name, "path": path, "count": 0 })
        } else {
            json!({ "id": id, "name": name, "path": path })
        };
        rows.push(entry);
    }
}

fn quick_roots(home: Option<&std::path::Path>, extra_roots: &[String]) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut roots = Vec::new();
    let mut push_root = |label: String, path: std::path::PathBuf| {
        if !path.is_dir() {
            return;
        }
        let canonical = std::fs::canonicalize(&path).unwrap_or(path);
        let text = canonical.to_string_lossy().into_owned();
        if seen.insert(text.clone()) {
            roots.push(json!({ "label": label, "path": text }));
        }
    };
    if let Some(home) = home {
        push_root("主目录".into(), home.to_path_buf());
        for candidate in [
            "source",
            "src",
            "projects",
            "Projects",
            "workspace",
            "workspaces",
            "code",
            "Code",
            "Desktop",
            "Documents",
        ] {
            let sub = home.join(candidate);
            if sub.is_dir() {
                push_root(candidate.into(), sub);
            }
        }
    }
    for extra in extra_roots {
        let p = std::path::PathBuf::from(extra);
        if let Some(label) = p.file_name().and_then(|s| s.to_str()).filter(|s| !s.is_empty()) {
            push_root(label.to_owned(), p);
        }
    }
    #[cfg(windows)]
    {
        for letter in b'C'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            let path = std::path::PathBuf::from(&drive);
            if path.is_dir() {
                push_root(format!("{}:", letter as char), path);
            }
        }
    }
    #[cfg(not(windows))]
    {
        push_root("/".into(), std::path::PathBuf::from("/"));
    }
    roots
}

fn browse_directories(
    requested: Option<&str>,
    include_hidden: bool,
    extra_roots: &[String],
) -> Result<Value> {
    let home = dirs::home_dir();
    let target = match requested {
        Some(raw) => {
            ensure!(
                raw.encode_utf16().count() <= 1024 && !raw.chars().any(char::is_control),
                "文件夹路径无效"
            );
            std::path::PathBuf::from(raw)
        }
        None => home.clone().unwrap_or_else(|| std::path::PathBuf::from("/")),
    };
    let canonical =
        std::fs::canonicalize(&target).context("找不到该电脑文件夹或没有访问权限")?;
    ensure!(canonical.is_dir(), "目标路径不是文件夹");
    let parent = canonical
        .parent()
        .filter(|p| *p != canonical.as_path())
        .map(|p| p.to_string_lossy().into_owned());
    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&canonical).context("无法读取此文件夹内容")?;
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name.chars().any(char::is_control) {
            continue;
        }
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if !std::fs::metadata(&path).is_ok_and(|meta| meta.is_dir()) {
            continue;
        }
        let is_git = path.join(".git").exists();
        entries.push((name, path.to_string_lossy().into_owned(), is_git));
    }
    entries.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()).then_with(|| a.0.cmp(&b.0)));
    const MAX_ENTRIES: usize = 500;
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|(name, path, is_git)| json!({ "name": name, "path": path, "isGit": is_git }))
        .collect();
    Ok(json!({
        "path": canonical.to_string_lossy(),
        "parent": parent,
        "home": home.as_deref().map(|p| p.to_string_lossy().into_owned()),
        "roots": quick_roots(home.as_deref(), extra_roots),
        "entries": entries,
        "truncated": truncated,
    }))
}

fn create_directory(parent: &str, raw_name: &str) -> Result<Value> {
    ensure!(
        parent.encode_utf16().count() <= 1024 && !parent.chars().any(char::is_control),
        "上级目录路径无效"
    );
    let name = raw_name.trim();
    ensure!(
        !name.is_empty()
            && name.encode_utf16().count() <= 120
            && name != "."
            && name != ".."
            && !name.contains('/')
            && !name.contains('\\')
            && !name.contains(':')
            && !name.chars().any(char::is_control),
        "文件夹名称无效，不能包含路径分隔符或特殊控制字符"
    );
    let base = std::fs::canonicalize(parent).context("上级目录不存在或不可访问")?;
    ensure!(base.is_dir(), "上级路径不是文件夹");
    let target = base.join(name);
    ensure!(!target.exists(), "同名文件夹或文件已存在");
    std::fs::create_dir(&target).context("创建文件夹失败，请检查目录权限")?;
    let canonical = std::fs::canonicalize(&target).unwrap_or(target);
    Ok(json!({
        "name": name,
        "path": canonical.to_string_lossy(),
    }))
}

#[cfg(test)]
mod fs_tests {
    use super::*;

    #[test]
    fn browse_and_create_directory_enforces_single_segment_and_hides_dotfiles_by_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".hidden")).unwrap();
        std::fs::create_dir(dir.path().join("alpha")).unwrap();
        std::fs::create_dir(dir.path().join("alpha/.git")).unwrap();
        std::fs::write(dir.path().join("file.txt"), b"hi").unwrap();

        let listed = browse_directories(Some(dir.path().to_str().unwrap()), false, &[]).unwrap();
        let entries = listed["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "alpha");
        assert_eq!(entries[0]["isGit"], true);

        let with_hidden =
            browse_directories(Some(dir.path().to_str().unwrap()), true, &[]).unwrap();
        assert_eq!(with_hidden["entries"].as_array().unwrap().len(), 2);

        assert!(create_directory(dir.path().to_str().unwrap(), "../escape").is_err());
        assert!(create_directory(dir.path().to_str().unwrap(), "a/b").is_err());
        assert!(create_directory(dir.path().to_str().unwrap(), "alpha").is_err());

        let created = create_directory(dir.path().to_str().unwrap(), "new-project").unwrap();
        assert_eq!(created["name"], "new-project");
        assert!(dir.path().join("new-project").is_dir());
    }

    #[test]
    fn merge_backend_projects_dedupes_by_canonical_path() {
        let dir = tempfile::tempdir().unwrap();
        let existing = dir.path().join("existing");
        let fresh = dir.path().join("fresh");
        std::fs::create_dir(&existing).unwrap();
        std::fs::create_dir(&fresh).unwrap();
        let existing_str = std::fs::canonicalize(&existing)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let fresh_str = std::fs::canonicalize(&fresh)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut payload = json!({
            "projects": [{ "id": "native-1", "name": "Existing", "count": 3 }]
        });
        let native_catalog = vec![json!({
            "id": "native-1",
            "name": "Existing",
            "path": existing_str,
        })];
        let saved = vec![
            ("dir:1111".into(), "Dup".into(), existing_str),
            ("dir:2222".into(), "Fresh".into(), fresh_str.clone()),
            ("dir:3333".into(), "Gone".into(), "/nonexistent/path/xyz".into()),
        ];
        merge_backend_projects(&mut payload, &saved, &native_catalog, true);
        let rows = payload["projects"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["id"], "dir:2222");
        assert_eq!(rows[1]["name"], "Fresh");
        assert_eq!(rows[1]["path"], fresh_str);
        assert_eq!(rows[1]["count"], 0);
    }
}
