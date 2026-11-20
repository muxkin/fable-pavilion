use super::*;

impl DeviceSession {
    pub(super) fn track_upload(&mut self, request: &Value, result: Option<&Value>) {
        let Some(value) = result else {
            return;
        };
        let (id, finish) = if request["type"] == "file" && request["action"] != "read" {
            (request["fileId"].as_str(), request["action"] == "finish")
        } else if request["type"] == "rpc" && request["call"]["method"] == "upload.begin" {
            (value["id"].as_str(), false)
        } else if request["type"] == "rpc"
            && matches!(
                request["call"]["method"].as_str(),
                Some("upload.chunk" | "upload.finish")
            )
        {
            (
                request["call"]["params"]["uploadId"].as_str(),
                request["call"]["method"] == "upload.finish",
            )
        } else {
            return;
        };
        let Some(id) = id.and_then(|id| Uuid::parse_str(id).ok()) else {
            return;
        };
        if finish {
            self.uploads.remove(&id);
        } else if let Some(activity) = self.activity.clone() {
            self.uploads
                .insert(id, (activity, Instant::now() + Duration::from_secs(120)));
        }
    }

    pub(super) fn file_scope(&self, request: &Value) -> Result<Scope> {
        if let Some(id) = backend_id(request).filter(|id| self.backends.codex.get(id).is_some()) {
            return codex_file_scope(id, &request["threadId"]);
        }
        let plugin = request["backendId"]
            .as_str()
            .and_then(|id| self.backends.plugins.get(id))
            .context("附件所属实例不可用")?;
        let thread = plugin_thread(&request["threadId"])?;
        ensure!(
            plugin.uploads_enabled()
                || matches!(request["action"].as_str(), Some("read" | "missing")),
            "附件写入不可用"
        );
        Ok(Scope::plugin(plugin.id(), thread))
    }

    pub(super) async fn begin_upload(&self, scope: Scope, body: Value) -> Result<Option<Value>> {
        let db = self.db.clone();
        let device = self.device.id.clone();
        let batch = self
            .backends
            .storage
            .as_ref()
            .map(crate::storage::Storage::batch);
        let activity = self.activity.clone();
        tokio::task::spawn_blocking(move || {
            let _activity = activity;
            db.lock()
                .expect("database mutex poisoned")
                .begin_upload(&device, &scope, body, batch)
                .map(Some)
        })
        .await?
    }

    pub(super) async fn finish_compatible_upload(&self, scope: Scope, call: &Value) -> Result<Option<Value>> {
        let id = thread_id(&call["params"]["uploadId"])?;
        let db = self.db.clone();
        let device = self.device.id.clone();
        let activity = self.activity.clone();
        tokio::task::spawn_blocking(move || {
            let _activity = activity;
            db.lock()
                .expect("database mutex poisoned")
                .finish_compatible_upload(&device, &scope, id)
                .map(Some)
        })
        .await?
    }

    pub(super) async fn legacy_upload_chunk(&self, call: &Value, bytes: Vec<u8>) -> Result<Option<Value>> {
        let scope = self.file_scope(&json!({
            "backendId":backend_id(call),"threadId":call["params"]["id"],"action":"write",
        }))?;
        let id = thread_id(&call["params"]["uploadId"])?;
        let offset = call["query"]["offset"]
            .as_str()
            .context("旧附件偏移缺失")?
            .parse::<u64>()?;
        let db = self.db.clone();
        let device = self.device.id.clone();
        let activity = self.activity.clone();
        tokio::task::spawn_blocking(move || {
            let _activity = activity;
            db.lock()
                .expect("database mutex poisoned")
                .legacy_chunk(&device, &scope, id, offset, &bytes)
                .map(Some)
        })
        .await?
    }

    pub(super) async fn describe_staged_upload(&self, scope: Scope, reference: &str) -> Result<Option<Value>> {
        let path = std::path::PathBuf::from(reference);
        if !path.is_absolute() {
            return Ok(None);
        }
        let db = self.db.clone();
        let device = self.device.id.clone();
        let batch = self
            .backends
            .storage
            .as_ref()
            .map(crate::storage::Storage::batch);
        let activity = self.activity.clone();
        tokio::task::spawn_blocking(move || {
            let _activity = activity;
            let native = {
                let store = db.lock().expect("database mutex poisoned");
                store
                    .is_native_upload_reference(&path)
                    .then(|| store.describe_upload(&device, &scope, &path))
                    .transpose()?
            };
            if let Some(mut manifest) = native {
                manifest["storage"] = json!(batch.is_some());
                if let Some(batch) = batch {
                    manifest["storageBatchBlocks"] = json!(batch);
                }
                return Ok(Some(manifest));
            }
            let (backend, thread) = scope.backend_and_thread();
            let Some(source) = history_media::legacy_upload(&path, backend, thread, &device)?
            else {
                return Ok(None);
            };
            let download = Download::prepare(source, device, scope, batch)?;
            db.lock()
                .expect("database mutex poisoned")
                .register_download(download)
                .map(Some)
        })
        .await?
    }

    pub(super) async fn file(&self, request: Value, bytes: Vec<u8>) -> Result<(Value, Vec<u8>)> {
        let id = thread_id(&request["fileId"])?;
        let scope = self.file_scope(&request)?;
        let db = self.db.clone();
        let device = self.device.id.clone();
        let batch = self
            .backends
            .storage
            .as_ref()
            .map(crate::storage::Storage::batch);
        let activity = self.activity.clone();
        tokio::task::spawn_blocking(move || {
            let _activity = activity;
            let action = request["action"].as_str().context("附件操作无效")?;
            let mut store = db.lock().expect("database mutex poisoned");
            if action == "read" {
                ensure!(bytes.is_empty(), "附件读取参数无效");
                let index = request["index"].as_u64().context("附件块不存在")?;
                return Ok((
                    json!({"index":index}),
                    store.read_upload(&device, &scope, id, index)?,
                ));
            }
            if matches!(action, "missing" | "write" | "finish") {
                store.import_pending_upload(&device, &scope, id, batch)?;
            }
            Ok((
                store.file_request(
                    &device,
                    &scope,
                    id,
                    action,
                    request["index"].as_u64(),
                    &bytes,
                )?,
                Vec::new(),
            ))
        })
        .await?
    }
}
