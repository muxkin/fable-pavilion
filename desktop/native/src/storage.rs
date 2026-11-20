use crate::{
    files::BLOCK,
    gateway::Database,
    history_media::legacy_upload_receipt,
    migration::GatewayEnvironment,
    state::{legacy_private_file, now, private_file},
};
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::Client;
use ring::aead;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Semaphore;
use url::Url;
use uuid::Uuid;

mod import;
mod plugin;
mod receipts;
use plugin::NativeStorage;
pub(crate) use receipts::initialize as initialize_receipts;

const GRANT_TTL_MS: i64 = 900_000;
const OBJECT_TTL_MS: i64 = 86_400_000;

#[derive(Clone)]
pub struct Storage {
    inner: Arc<Transport>,
}

struct Transport {
    http: Client,
    provider: Provider,
    prefix: String,
    batch: usize,
    jobs: Semaphore,
}

enum Provider {
    Plugin(NativeStorage),
    #[cfg(test)]
    Fixture(tests::FixtureProvider),
}

pub struct Transports {
    pub direct: Option<crate::direct::Direct>,
    pub storage: Option<Storage>,
}

impl Transports {
    pub fn load(directory: &Path, relay: &Url, environment: &GatewayEnvironment) -> Result<Self> {
        let file = directory.join("transport.env");
        let profile = if file.exists() {
            dotenvy::Iter::new(private_file(&file, false)?)
                .collect::<Result<HashMap<_, _>, _>>()
                .map_err(|_| anyhow::anyhow!("原生适配器 transport.env 格式无效"))?
        } else {
            HashMap::new()
        };
        let explicit = |name: &str| {
            std::env::var(name)
                .ok()
                .or_else(|| profile.get(name).cloned())
        };
        let legacy = match explicit("POCKET_NATIVE_STORAGE_ENV_FILE") {
            Some(path) => {
                let path = PathBuf::from(path);
                ensure!(path.is_absolute(), "对象存储配置文件必须是绝对路径");
                transport_settings(legacy_private_file(&path)?)?
            }
            None if environment.is_external() => filter_transport(environment.values.clone()),
            None => migrated_transport_settings(directory, crate::migration::source())?,
        };
        let get = |name: &str| explicit(name).or_else(|| legacy.get(name).cloned());
        let direct = if get("POCKET_NATIVE_P2P")
            .or_else(|| get("POCKET_P2P"))
            .as_deref()
            == Some("0")
        {
            None
        } else {
            let urls: Vec<_> = get("POCKET_STUN_URLS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .map(str::to_owned)
                .collect();
            ensure!(
                urls.len() <= 8
                    && urls.iter().all(|url| url.len() <= 256
                        && !url.chars().any(char::is_whitespace)
                        && (url.starts_with("stun:") || url.starts_with("stuns:"))),
                "STUN 配置无效"
            );
            Some(crate::direct::Direct::new(urls))
        };
        let storage = if let Some(key) = explicit("POCKET_NATIVE_STORAGE_PLUGIN")
            .or_else(|| legacy.get("POCKET_NATIVE_STORAGE_PLUGIN").cloned())
            .filter(|value| !value.is_empty())
        {
            let config = explicit("POCKET_NATIVE_STORAGE_PLUGIN_CONFIG")
                .or_else(|| legacy.get("POCKET_NATIVE_STORAGE_PLUGIN_CONFIG").cloned())
                .filter(|value| !value.is_empty())
                .map(PathBuf::from);
            let plugin = NativeStorage::load(directory, relay, &key, config.as_deref())?;
            Some(Storage::new(Provider::Plugin(plugin), &get)?)
        } else {
            None
        };
        Ok(Self { direct, storage })
    }
}

fn migrated_transport_settings(
    directory: &Path,
    source: Option<&Path>,
) -> Result<HashMap<String, String>> {
    let Some(source) = source else {
        return Ok(HashMap::new());
    };
    let config = directory.join("gateway.env");
    let config = if config.try_exists()? {
        config
    } else {
        source.join("gateway.env")
    };
    match legacy_private_file(&config) {
        Ok(file) => transport_settings(file),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(HashMap::new())
        }
        Err(error) => Err(error),
    }
}

fn transport_settings(file: std::fs::File) -> Result<HashMap<String, String>> {
    let settings = dotenvy::Iter::new(file)
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|_| anyhow::anyhow!("既有传输配置格式无效"))?;
    Ok(filter_transport(settings))
}

fn filter_transport(mut settings: HashMap<String, String>) -> HashMap<String, String> {
    settings.retain(|key, _| {
        matches!(
            key.as_str(),
            "POCKET_MEDIA_PREFIX"
                | "POCKET_NATIVE_STORAGE_PLUGIN"
                | "POCKET_NATIVE_STORAGE_PLUGIN_CONFIG"
                | "POCKET_NATIVE_STORAGE_BATCH_MIB"
                | "POCKET_NATIVE_P2P"
                | "POCKET_P2P"
                | "POCKET_STUN_URLS"
        )
    });
    settings
}

impl Storage {
    fn new(provider: Provider, get: &impl Fn(&str) -> Option<String>) -> Result<Self> {
        let prefix = get("POCKET_MEDIA_PREFIX").unwrap_or_else(|| "codex-pocket".to_owned());
        ensure!(
            !prefix.is_empty()
                && prefix.len() <= 63
                && prefix.bytes().all(|b| b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'-'
                    || b == b'_'),
            "对象存储前缀无效"
        );
        let batch = get("POCKET_NATIVE_STORAGE_BATCH_MIB")
            .map(|v| v.parse::<usize>())
            .transpose()?
            .unwrap_or(25);
        ensure!((1..=50).contains(&batch), "对象存储批次须在 1–50 MiB");
        let http = match &provider {
            Provider::Plugin(_) => storage_client()?,
            #[cfg(test)]
            Provider::Fixture(fixture) => fixture.http.clone(),
        };
        Ok(Self {
            inner: Arc::new(Transport {
                http,
                provider,
                prefix,
                batch,
                jobs: Semaphore::new(2),
            }),
        })
    }

    pub fn batch(&self) -> usize {
        self.inner.batch
    }

    pub async fn handle(
        &self,
        db: Database,
        device: String,
        scope: crate::files::Scope,
        id: Uuid,
        action: &str,
        request: &Value,
    ) -> Result<Value> {
        let _job = self
            .inner
            .jobs
            .try_acquire()
            .context("对象存储正在处理其他附件")?;
        if matches!(action, "storage-plan" | "storage-import") {
            let (db, device, scope) = (db.clone(), device.clone(), scope.clone());
            let batch = self.batch();
            tokio::task::spawn_blocking(move || {
                db.lock()
                    .expect("database mutex poisoned")
                    .import_pending_upload(&device, &scope, id, Some(batch))
            })
            .await??;
        }
        if action == "storage-plan" {
            let indices: Vec<usize> = serde_json::from_value(request["indices"].clone())?;
            ensure!(
                !indices.is_empty()
                    && indices.len() <= self.batch()
                    && indices
                        .windows(2)
                        .all(|pair| pair[0].checked_add(1) == Some(pair[1])),
                "对象存储批次无效"
            );
            let (manifest, complete) = db
                .lock()
                .expect("database mutex poisoned")
                .storage_manifest(&device, &scope, id)?;
            let size = indices.iter().try_fold(0, |total, &index| {
                Ok::<_, anyhow::Error>(total + block_length(&manifest, index)? + aead::MAX_TAG_LEN)
            })?;
            let object = Uuid::new_v4();
            let key = self.inner.key(object);
            let grant = if complete {
                None
            } else {
                Some(self.inner.provider.plan(&key, size).await?)
            };
            db.lock()
                .expect("database mutex poisoned")
                .record_storage_object(object, &device, &scope, id, &indices, complete)?;
            if let Some(grant) = grant {
                return Ok(json!({"objectId":object,"upload":grant}));
            }
            let mut ciphertext = Vec::with_capacity(size);
            for &index in &indices {
                let db = db.clone();
                let device = device.clone();
                let manifest = manifest.clone();
                let scope = scope.clone();
                let block = tokio::task::spawn_blocking(move || {
                    let plain = db.lock().expect("database mutex poisoned").read_upload(
                        &device,
                        &scope,
                        id,
                        index as u64,
                    )?;
                    encrypt(&manifest, index, plain)
                })
                .await??;
                ciphertext.extend(block);
            }
            self.inner.provider.put(&key, ciphertext).await?;
            let url = self
                .inner
                .provider
                .download_url(&key, GRANT_TTL_MS / 1_000)
                .await?;
            return Ok(
                json!({"objectId":object,"url":url.as_str(), "indices":indices, "size":size}),
            );
        }

        let object = Uuid::parse_str(request["objectId"].as_str().context("对象编号无效")?)?;
        let native = db.lock().expect("database mutex poisoned").db.query_row(
            "SELECT indices,download FROM native_storage_objects WHERE id=?1 AND device=?2 AND thread=?3 AND transfer=?4 AND expires>?5",
            params![object.to_string(), device, scope.key(), id.to_string(), now()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        ).optional()?;
        let key = self.inner.key(object);
        let (indices, download) = match &native {
            Some((indices, download)) => (serde_json::from_str(indices)?, *download),
            None if action == "storage-import" => (
                legacy_object_indices(&device, &scope, id, object, &key)?,
                false,
            ),
            None => anyhow::bail!("对象不属于此附件或已过期"),
        };
        match action {
            "storage-import" if !download => {
                let received = self
                    .inner
                    .receive_object(&db, &device, &scope, id, &key, indices)
                    .await?;
                if !received && native.is_none() {
                    return Ok(json!({"ok":true}));
                }
            }
            "storage-done" if download => {}
            _ => anyhow::bail!("对象方向无效"),
        }
        // The bucket policy expires unfinished ciphertext even if the desktop is offline.
        if self.inner.provider.remove(&key).await.is_ok() && native.is_some() {
            db.lock().expect("database mutex poisoned").db.execute(
                "DELETE FROM native_storage_objects WHERE id=?1",
                [object.to_string()],
            )?;
        }
        Ok(json!({"ok":true}))
    }
}

fn legacy_object_indices(
    device: &str,
    scope: &crate::files::Scope,
    transfer: Uuid,
    object: Uuid,
    key: &str,
) -> Result<Vec<usize>> {
    let (backend, thread) = scope.backend_and_thread();
    let record = legacy_upload_receipt(backend, thread, device, transfer)?
        .context("旧对象不属于此附件或已过期")?
        .storage_object(object)?
        .context("旧对象不存在")?;
    ensure!(
        record["id"] == object.to_string()
            && record["transfer"] == transfer.to_string()
            && record["key"] == key
            && record["expires"]
                .as_i64()
                .is_some_and(|expires| expires > now()),
        "旧对象不属于此附件或已过期"
    );
    let indices: Vec<usize> = serde_json::from_value(record["indices"].clone())?;
    ensure!(
        (1..=15).contains(&indices.len())
            && indices.iter().all(|&index| index < 256)
            && indices.windows(2).all(|pair| pair[0] + 1 == pair[1]),
        "旧对象的分块清单无效"
    );
    Ok(indices)
}

fn origin(raw: &str) -> Result<Url> {
    let url = Url::parse(raw)?;
    ensure!(
        url.scheme() == "https"
            && url.host().is_some()
            && url.path() == "/"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "对象存储要求 HTTPS 源"
    );
    Ok(url)
}

fn storage_client() -> Result<Client> {
    Ok(Client::builder()
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(120))
        .build()?)
}

impl Transport {
    fn key(&self, id: Uuid) -> String {
        format!("{}/private-encrypted-v2/{id}", self.prefix)
    }
}

impl Provider {
    async fn plan(&self, key: &str, size: usize) -> Result<Value> {
        match self {
            Self::Plugin(plugin) => plugin.plan(key, size).await,
            #[cfg(test)]
            Self::Fixture(fixture) => fixture.plan(key, size),
        }
    }

    async fn download_url(&self, key: &str, seconds: i64) -> Result<Url> {
        match self {
            Self::Plugin(plugin) => plugin.download_url(key, now() + seconds * 1_000).await,
            #[cfg(test)]
            Self::Fixture(fixture) => fixture.download_url(key),
        }
    }

    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        match self {
            Self::Plugin(plugin) => plugin.put(key, bytes).await,
            #[cfg(test)]
            Self::Fixture(fixture) => fixture.put(key, bytes).await,
        }
    }

    async fn remove(&self, key: &str) -> Result<()> {
        match self {
            Self::Plugin(plugin) => plugin.remove(key).await,
            #[cfg(test)]
            Self::Fixture(fixture) => fixture.remove(key).await,
        }
    }
}

fn block_length(manifest: &Value, index: usize) -> Result<usize> {
    ensure!(manifest["hashes"].get(index).is_some(), "附件块不存在");
    let size = usize::try_from(manifest["size"].as_u64().context("附件大小无效")?)?;
    Ok((size - index * BLOCK).min(BLOCK))
}

fn cipher(manifest: &Value, index: usize) -> Result<(aead::LessSafeKey, aead::Nonce, Vec<u8>)> {
    let key = STANDARD.decode(manifest["key"].as_str().context("附件密钥无效")?)?;
    let prefix = STANDARD.decode(manifest["nonce"].as_str().context("附件 nonce 无效")?)?;
    ensure!(prefix.len() == 8, "附件 nonce 无效");
    let key = aead::UnboundKey::new(&aead::AES_256_GCM, &key)
        .map_err(|_| anyhow::anyhow!("附件密钥无效"))?;
    let mut nonce = [0; 12];
    nonce[..8].copy_from_slice(&prefix);
    nonce[8..].copy_from_slice(&u32::try_from(index)?.to_be_bytes());
    let aad = serde_json::to_vec(&json!([
        manifest["id"],
        manifest["version"],
        index,
        block_length(manifest, index)?
    ]))?;
    Ok((
        aead::LessSafeKey::new(key),
        aead::Nonce::assume_unique_for_key(nonce),
        aad,
    ))
}

fn encrypt(manifest: &Value, index: usize, mut bytes: Vec<u8>) -> Result<Vec<u8>> {
    let (key, nonce, aad) = cipher(manifest, index)?;
    key.seal_in_place_append_tag(nonce, aead::Aad::from(aad), &mut bytes)
        .map_err(|_| anyhow::anyhow!("附件加密失败"))?;
    Ok(bytes)
}

fn decrypt(manifest: &Value, index: usize, mut bytes: Vec<u8>) -> Result<Vec<u8>> {
    let (key, nonce, aad) = cipher(manifest, index)?;
    let length = key
        .open_in_place(nonce, aead::Aad::from(aad), &mut bytes)
        .map_err(|_| anyhow::anyhow!("对象附件认证失败"))?
        .len();
    bytes.truncate(length);
    Ok(bytes)
}

#[cfg(test)]
mod tests;
