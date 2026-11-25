use super::*;

impl DeviceSession {
    pub(super) fn codex_watch(&self, backend: &str, thread: Uuid) -> Option<&Watch> {
        self.watches.get(&(backend.to_owned(), thread))
    }

    pub(super) async fn watch(&mut self, backend: &str, request: &Value) -> Result<Value> {
        let id = thread_id(&request["threadId"])?;
        let key = (backend.to_owned(), id);
        if let Some(watch) = self.watches.get_mut(&key) {
            watch.published = None;
            watch.versions.clear();
            return Ok(json!({"ok": true}));
        }
        ensure!(
            self.watches.len() + self.plugin_watches.len() < 8,
            "订阅数量过多"
        );
        let connector = self
            .backends
            .codex
            .get(backend)
            .expect("selected Codex instance");
        let params = json!({"id": id});
        let summary = connector
            .read("thread.read", &params, &Value::Null, None)
            .await?
            .context("找不到此会话")?;
        let live = connector.watch(id);
        let connector = connector.clone();
        let history = tokio::spawn(async move {
            connector
                .read("history.read", &params, &Value::Null, None)
                .await
                .ok()
                .flatten()
        });
        self.watches.insert(
            key,
            Watch {
                live,
                summary: summary["thread"].clone(),
                fallback: None,
                history: Some(history),
                fallback_epoch: Uuid::new_v4(),
                fallback_after: Instant::now() + Duration::from_secs(1),
                published: None,
                versions: HashMap::new(),
                operations: HashMap::new(),
                was_running: false,
            },
        );
        Ok(json!({"ok": true}))
    }

    pub(super) async fn publish(&mut self, io: &mut (impl AsyncWrite + Unpin)) -> Result<()> {
        for (backend, connector) in self.backends.codex.all() {
            let status = connector.status(self.live_transport(backend));
            if self.last_status.get(backend) != Some(&status) {
                reply(
                    io,
                    json!({"type":"event","backendId":backend,"event":{
                        "type":"status","status":status,
                    }}),
                )
                .await?;
                self.last_status.insert(backend.to_owned(), status);
            }
        }
        for ((backend, id), watch) in &mut self.watches {
            if watch
                .history
                .as_ref()
                .is_some_and(|task| task.is_finished())
            {
                watch.fallback = watch.history.take().unwrap().await.ok().flatten();
            }
            let live = watch.live.as_ref().and_then(Live::view);
            let changed = if let Some(view) = live {
                let mark = view.mark();
                if watch.published.as_ref() == Some(&mark) {
                    None
                } else {
                    self.db
                        .lock()
                        .expect("database mutex poisoned")
                        .observe_operations(backend, &id.to_string(), &view)?;
                    let mut thread = view.thread.clone();
                    for field in ["projectId", "projectName"] {
                        thread[field] = watch.summary[field].clone();
                    }
                    Some((mark, thread, view.messages.clone()))
                }
            } else if watch.history.is_some()
                || (watch.live.is_some()
                    && watch.published.is_none()
                    && Instant::now() < watch.fallback_after)
            {
                None
            } else {
                let history_unavailable = watch.fallback.is_none();
                let status = self.last_status.get(backend);
                let reason = if history_unavailable {
                    "历史记录暂时无法读取。请在电脑的 Codex 桌面打开此会话。"
                } else if status.is_some_and(|status| status["capabilities"]["openThread"] == true)
                {
                    "已加载历史。选择「继续此会话」连接桌面。"
                } else if status.is_some_and(|status| status["desktopIpcConnected"] == true) {
                    "已连接 Codex 桌面。请在电脑上打开此会话后开始控制。"
                } else {
                    "已加载历史。请确认电脑上的 Codex 桌面已启动，并打开此会话。"
                };
                let mark = (watch.fallback_epoch, 0, Some(reason.to_owned()));
                if watch.published.as_ref() == Some(&mark) {
                    None
                } else {
                    let mut summary = watch.summary.clone();
                    let properties = json!({
                        "revision":0,"owner":false,"synchronized":false,"runtimeStatus":"notLoaded",
                        "activeTurnId":null,"model":null,"pendingRequests":0,"canSend":false,"canInterrupt":false,
                        "reason":reason,"historyUnavailable":history_unavailable,
                    });
                    if let Some(thread) = summary.as_object_mut() {
                        thread.extend(properties.as_object().unwrap().clone());
                    }
                    Some((
                        mark,
                        summary,
                        watch
                            .fallback
                            .as_ref()
                            .and_then(|page| page["messages"].as_array())
                            .cloned()
                            .unwrap_or_default(),
                    ))
                }
            };
            if let Some((mark, thread, messages)) = changed {
                let now_running = thread["runtimeStatus"].as_str() == Some("running")
                    || thread["activeTurnId"].as_str().is_some();
                if watch.was_running && !now_running {
                    self.usage_refresh_backends.insert(backend.clone());
                }
                watch.was_running = now_running;
                let (order, changed) = diff_messages(messages.iter(), &mut watch.versions)?;
                reply(io, json!({"type":"sync","backendId":backend,"threadId":id,"updates":[{
                    "kind":"manifest","epoch":mark.0,"thread":thread,"order":order,"changed":changed,
                }]})).await?;
                watch.published = Some(mark);
            }
            let operations = self
                .db
                .lock()
                .expect("database mutex poisoned")
                .recent_operations_for(backend, &self.device.id, &id.to_string())?;
            let mut current = HashMap::new();
            for operation in operations {
                let request = operation["id"].as_str().unwrap_or_default().to_owned();
                if watch.operations.get(&request) != Some(&operation) {
                    reply(
                        io,
                        json!({"type":"event","backendId":backend,"threadId":id,
                        "event":{"type":"operation","operation":operation}}),
                    )
                    .await?;
                }
                current.insert(request, operation);
            }
            watch.operations = current;
        }
        Ok(())
    }

    pub(super) fn plugin_watch(&mut self, request: &Value) -> Result<Option<Value>> {
        let Some(plugin) = request["backendId"]
            .as_str()
            .and_then(|id| self.backends.plugins.get(id))
        else {
            return Ok(None);
        };
        let thread = plugin_thread(&request["threadId"])?;
        let key = (plugin.id().to_owned(), thread.to_owned());
        if let Some(watch) = self.plugin_watches.get_mut(&key) {
            watch.revision = None;
            watch.versions.clear();
        } else {
            ensure!(
                self.watches.len() + self.plugin_watches.len() < 8,
                "订阅数量过多"
            );
            self.plugin_watches.insert(
                key,
                PluginWatch {
                    live: plugin.subscribe(thread)?,
                    epoch: Uuid::new_v4(),
                    revision: None,
                    versions: HashMap::new(),
                    operations: HashMap::new(),
                    was_running: false,
                },
            );
        }
        Ok(Some(json!({"ok":true})))
    }

    pub(super) async fn publish_plugins(&mut self, io: &mut (impl AsyncWrite + Unpin)) -> Result<()> {
        for ((backend, thread), watch) in &mut self.plugin_watches {
            let view = watch.live.0.borrow().clone();
            if let Some(view) = view {
                let revision = view.thread["revision"].as_u64();
                if revision != watch.revision {
                    if view.thread["synchronized"] == true {
                        self.db
                            .lock()
                            .expect("database mutex poisoned")
                            .observe_plugin(backend, thread, &view.observations)?;
                    }
                    let (order, changed) = diff_messages(
                        view.messages.iter().chain(view.streamed.iter()),
                        &mut watch.versions,
                    )?;
                    let now_running = view.thread["runtimeStatus"].as_str() == Some("running")
                        || view.thread["activeTurnId"].as_str().is_some();
                    if watch.was_running && !now_running {
                        self.usage_refresh_backends.insert(backend.clone());
                    }
                    watch.was_running = now_running;
                    reply(io, json!({"type":"sync","backendId":backend,"threadId":thread,"updates":[{
                        "kind":"manifest","epoch":watch.epoch,"thread":view.thread,"order":order,"changed":changed,
                    }]})).await?;
                    watch.revision = revision;
                }
            }
            let operations = self
                .db
                .lock()
                .expect("database mutex poisoned")
                .recent_operations_for(backend, &self.device.id, thread)?;
            let mut current = HashMap::new();
            for operation in operations {
                let id = operation["id"].as_str().unwrap_or_default().to_owned();
                if watch.operations.get(&id) != Some(&operation) {
                    reply(
                        io,
                        json!({"type":"event","backendId":backend,"threadId":thread,
                            "event":{"type":"operation","operation":operation},
                        }),
                    )
                    .await?;
                }
                current.insert(id, operation);
            }
            watch.operations = current;
        }
        Ok(())
    }
}

pub(super) fn diff_messages<'a>(
    messages: impl IntoIterator<Item = &'a Value>,
    versions: &mut HashMap<String, [u8; 32]>,
) -> Result<(Vec<&'a str>, Vec<&'a Value>)> {
    let mut order = Vec::new();
    let mut changed = Vec::new();
    let mut current = HashMap::new();
    for message in messages {
        let Some(id) = message["id"].as_str() else {
            continue;
        };
        let fingerprint = Sha256::digest(serde_json::to_vec(message)?).into();
        if versions.get(id) != Some(&fingerprint) {
            changed.push(message);
        }
        current.insert(id.to_owned(), fingerprint);
        order.push(id);
    }
    *versions = current;
    Ok((order, changed))
}
