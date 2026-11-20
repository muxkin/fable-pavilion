//! Human account recovery material. This store is separate from device identity and Agent credentials.
//! Only the local capability-authenticated settings server can reveal codes; the Noise RPC is import-only.
use anyhow::{Context, Result, bail, ensure};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ring::{aead, hmac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;
use zeroize::Zeroizing;

pub(crate) type Shared = Arc<Mutex<Vault>>;
const FILE: &str = "account-security-v1.json";
const MAX_FILE: u64 = 1024 * 1024;
const UNLOCK_LIFETIME: Duration = Duration::from_secs(10 * 60);
const ASSOCIATED: &[u8] = b"fable-pavilion:offline-account-security:v1";

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Account {
    pub(crate) id: String,
    pub(crate) username: String,
    pub(crate) display_name: String,
}

// Deliberately no Debug: diagnostics must never format a seed or recovery code.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Document {
    pub(crate) version: u8,
    pub(crate) origin: String,
    pub(crate) account: Account,
    pub(crate) revision: u64,
    pub(crate) totp_secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) recovery_code: Option<String>,
}

impl Drop for Document {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.totp_secret.zeroize();
        if let Some(code) = self.recovery_code.as_mut() {
            code.zeroize();
        }
    }
}

impl Document {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        ensure!(value.len() <= 16_384, "备份内容过大");
        let document: Self = serde_json::from_str(value).context("账号秘钥簿格式无效")?;
        ensure!(
            document.version == 1 && document.revision > 0 && document.revision <= 1_000_000,
            "账号秘钥簿版本无效"
        );
        let origin = url::Url::parse(&document.origin).context("备份服务地址无效")?;
        let local = matches!(origin.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        ensure!(
            (origin.scheme() == "https" || (origin.scheme() == "http" && local))
                && origin.origin().ascii_serialization() == document.origin,
            "备份服务地址无效"
        );
        ensure!(
            (1..=128).contains(&document.account.id.len())
                && document
                    .account
                    .id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
            "备份账号无效"
        );
        for label in [&document.account.username, &document.account.display_name] {
            ensure!(
                label.len() <= 320 && !label.chars().any(char::is_control),
                "备份账号名称无效"
            );
        }
        decode_secret(&document.totp_secret)?;
        if let Some(code) = &document.recovery_code {
            ensure!(
                code.len() == 44 && STANDARD.decode(code).is_ok_and(|b| b.len() == 32),
                "恢复码格式无效"
            );
        }
        Ok(document)
    }
    pub(crate) fn key(&self) -> String {
        account_key(&self.origin, &self.account.id)
    }
}

fn account_key(origin: &str, id: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{origin}\n{id}")))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Summary {
    key: String,
    origin: String,
    account: Account,
    revision: u64,
    updated_at: i64,
    recovery_backed_up: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_source: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sealed {
    nonce: String,
    ciphertext: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    summary: Summary,
    sealed: Sealed,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Protection {
    System,
    Device,
    Passphrase { salt: String, wrapped: Sealed },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct File {
    version: u8,
    key_id: Uuid,
    protection: Protection,
    records: Vec<Record>,
}

trait Credentials: Send {
    fn read(&self, id: Uuid) -> Result<Zeroizing<Vec<u8>>>;
    fn write(&self, id: Uuid, key: &[u8]) -> Result<()>;
}

struct SystemCredentials;
impl Credentials for SystemCredentials {
    fn read(&self, id: Uuid) -> Result<Zeroizing<Vec<u8>>> {
        let entry = keyring::Entry::new(
            "com.fablepavilion.adapter.offline-security",
            &id.to_string(),
        )
        .map_err(|_| anyhow::anyhow!("系统凭据库未就绪"))?;
        entry
            .get_secret()
            .map(Zeroizing::new)
            .map_err(|_| anyhow::anyhow!("系统凭据库未就绪，请解锁本机凭据库"))
    }
    fn write(&self, id: Uuid, key: &[u8]) -> Result<()> {
        let entry = keyring::Entry::new(
            "com.fablepavilion.adapter.offline-security",
            &id.to_string(),
        )
        .map_err(|_| anyhow::anyhow!("系统凭据库未就绪"))?;
        entry
            .set_secret(key)
            .map_err(|_| anyhow::anyhow!("系统凭据库未就绪，请解锁凭据库或设置本地秘钥簿口令"))?;
        ensure!(self.read(id)?.as_slice() == key, "系统凭据库未保存备份密钥");
        Ok(())
    }
}

pub(crate) struct Vault {
    directory: PathBuf,
    file: Option<File>,
    credentials: Box<dyn Credentials>,
    unlocked: Option<(Zeroizing<Vec<u8>>, Instant)>,
    #[cfg(test)]
    fail_persist: bool,
}

impl Vault {
    pub(crate) fn open(directory: &Path) -> Result<Self> {
        Self::with_credentials(directory, Box::new(SystemCredentials))
    }
    fn with_credentials(directory: &Path, credentials: Box<dyn Credentials>) -> Result<Self> {
        crate::state::private_directory(directory)?;
        let path = directory.join(FILE);
        let file = if path.exists() {
            let mut bytes = Vec::new();
            crate::state::private_file(&path, false)?
                .take(MAX_FILE + 1)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() as u64 <= MAX_FILE, "秘钥簿过大");
            let mut file: File =
                serde_json::from_slice(&bytes).context("秘钥簿损坏，请保留文件并联系支持")?;
            ensure!(
                file.version == 1 && file.records.len() <= 32,
                "秘钥簿版本无效"
            );
            if matches!(file.protection, Protection::System) {
                match fs::symlink_metadata(device_key_path(directory, file.key_id)) {
                    Ok(_) => {
                        // The disk schema remains readable by older adapters. Only this
                        // version interprets its matching owner-only local key as Device.
                        Self::read_device_key(directory, file.key_id)?;
                        file.protection = Protection::Device;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
            Some(file)
        } else {
            None
        };
        Ok(Self {
            directory: directory.to_owned(),
            file,
            credentials,
            unlocked: None,
            #[cfg(test)]
            fail_persist: false,
        })
    }
    fn active_key(&mut self) -> Result<Zeroizing<Vec<u8>>> {
        if self
            .unlocked
            .as_ref()
            .is_some_and(|(_, until)| *until <= Instant::now())
        {
            self.unlocked = None;
        }
        if let Some((key, _)) = &self.unlocked {
            return Ok(Zeroizing::new(key.to_vec()));
        }
        let file = self.file.as_ref().context("尚未保存账号秘钥簿")?;
        let key = match file.protection {
            Protection::System => self.credentials.read(file.key_id),
            Protection::Device => self.device_key(file.key_id),
            Protection::Passphrase { .. } => bail!("秘钥簿已锁定，请输入本地秘钥簿口令"),
        }?;
        ensure!(key.len() == 32, "秘钥簿密钥无效");
        self.unlocked = Some((
            Zeroizing::new(key.to_vec()),
            Instant::now() + UNLOCK_LIFETIME,
        ));
        Ok(key)
    }
    pub(crate) fn status(&mut self) -> Value {
        if self
            .unlocked
            .as_ref()
            .is_some_and(|(_, until)| *until <= Instant::now())
        {
            self.unlocked = None;
        }
        let (protection, locked) = match self.file.as_ref().map(|f| &f.protection) {
            None => ("unconfigured", false),
            Some(Protection::System) => ("system", false),
            Some(Protection::Device) => ("device", false),
            Some(Protection::Passphrase { .. }) => ("passphrase", self.unlocked.is_none()),
        };
        json!({"version":1, "protection":protection, "locked":locked,
            "accounts":self.file.as_ref().map(|f|f.records.iter().map(|r|&r.summary).collect::<Vec<_>>()).unwrap_or_default()})
    }
    pub(crate) fn remote_status(&mut self, origin: &str, account: &str) -> Value {
        let record = self.file.as_ref().and_then(|f| {
            f.records
                .iter()
                .find(|r| r.summary.key == account_key(origin, account))
        });
        json!({"version":1,"supported":true,"saved":record.is_some(),"hasTotp":record.is_some(),
            "revision":record.map(|r|r.summary.revision),"hasRecovery":record.is_some_and(|r|r.summary.recovery_backed_up),
            "needsLocalUnlock":self.file.as_ref().is_some_and(|file|matches!(file.protection,Protection::Passphrase{..})) && self.unlocked.as_ref().is_none_or(|(_,until)|*until <= Instant::now())})
    }
    pub(crate) fn configure_passphrase(&mut self, passphrase: &str) -> Result<()> {
        ensure!(self.file.is_none(), "已有秘钥簿，不能直接重置保护方式");
        ensure!(
            (12..=1024).contains(&passphrase.chars().count()),
            "本地秘钥簿口令至少需要12个字符"
        );
        let salt = rand::random::<[u8; 16]>();
        let derived = derive(passphrase, &salt)?;
        let key = Zeroizing::new(rand::random::<[u8; 32]>().to_vec());
        let file = File {
            version: 1,
            key_id: Uuid::new_v4(),
            protection: Protection::Passphrase {
                salt: STANDARD.encode(salt),
                wrapped: seal(&derived, &key, ASSOCIATED)?,
            },
            records: vec![],
        };
        self.persist(&file)?;
        self.file = Some(file);
        self.unlocked = Some((key, Instant::now() + UNLOCK_LIFETIME));
        Ok(())
    }
    pub(crate) fn unlock(&mut self, passphrase: &str) -> Result<()> {
        let file = self.file.as_ref().context("尚未保存账号秘钥簿")?;
        let key = match &file.protection {
            Protection::System => self.credentials.read(file.key_id)?,
            Protection::Device => self.device_key(file.key_id)?,
            Protection::Passphrase { salt, wrapped } => {
                ensure!(passphrase.len() <= 4096, "本地秘钥簿口令无效");
                let salt = STANDARD.decode(salt).context("秘钥簿损坏")?;
                ensure!(salt.len() == 16, "秘钥簿损坏");
                open(&derive(passphrase, &salt)?, wrapped, ASSOCIATED)
                    .context("本地秘钥簿口令不正确")?
            }
        };
        ensure!(key.len() == 32, "秘钥簿密钥无效");
        self.unlocked = Some((key, Instant::now() + UNLOCK_LIFETIME));
        Ok(())
    }
    pub(crate) fn lock(&mut self) {
        self.unlocked = None;
    }
    pub(crate) fn ready(&mut self) -> Result<()> {
        if self.file.is_some() {
            self.active_key()?;
        } else {
            let key = Zeroizing::new(rand::random::<[u8; 32]>().to_vec());
            self.persist_default(key, vec![])?;
        }
        Ok(())
    }
    /// Only an already unlocked legacy passphrase can be removed. A failed migration
    /// keeps its original ciphertext and protection, including if a new key was saved.
    pub(crate) fn use_default_protection(&mut self) -> Result<()> {
        let Some(file) = &self.file else {
            return self.ready();
        };
        if !matches!(file.protection, Protection::Passphrase { .. }) {
            self.active_key()?;
            return Ok(());
        }
        let previous_key = self.active_key()?;
        let key = Zeroizing::new(rand::random::<[u8; 32]>().to_vec());
        let mut records = Vec::new();
        for record in &self.file.as_ref().expect("existing vault").records {
            let associated = serde_json::to_vec(&record.summary)?;
            let plaintext = open(&previous_key, &record.sealed, &associated)?;
            Document::parse(std::str::from_utf8(&plaintext).context("账号秘钥簿损坏")?)?;
            records.push(Record {
                summary: record.summary.clone(),
                sealed: seal(&key, &plaintext, &associated)?,
            });
        }
        self.persist_default(key, records)
    }
    fn device_key_path(&self, id: Uuid) -> PathBuf {
        device_key_path(&self.directory, id)
    }
    fn device_key(&self, id: Uuid) -> Result<Zeroizing<Vec<u8>>> {
        Self::read_device_key(&self.directory, id)
    }
    fn read_device_key(directory: &Path, id: Uuid) -> Result<Zeroizing<Vec<u8>>> {
        let mut key = Zeroizing::new(Vec::new());
        crate::state::private_file(&device_key_path(directory, id), false)?
            .take(33)
            .read_to_end(&mut key)?;
        ensure!(key.len() == 32, "本机秘钥簿密钥无效，请保留现有文件");
        Ok(key)
    }
    fn persist_default(&mut self, key: Zeroizing<Vec<u8>>, records: Vec<Record>) -> Result<()> {
        let key_id = Uuid::new_v4();
        let protection = if self.credentials.write(key_id, &key).is_ok() {
            Protection::System
        } else {
            // This fallback protects application-local data with the same owner-only
            // filesystem boundary as the adapter identity. It does not claim OS keyring
            // protection against someone who can copy the whole private state directory.
            let path = self.device_key_path(key_id);
            let mut output = crate::state::create_private_file(&path)?;
            let result = (|| -> Result<()> {
                output.write_all(&key)?;
                output.sync_all()?;
                Ok(())
            })();
            drop(output);
            if let Err(error) = result {
                let _ = fs::remove_file(path);
                return Err(error);
            }
            Protection::Device
        };
        let file = File {
            version: 1,
            key_id,
            protection,
            records,
        };
        if let Err(error) = self.persist(&file) {
            if matches!(file.protection, Protection::Device) {
                let _ = fs::remove_file(self.device_key_path(key_id));
            }
            return Err(error);
        }
        self.file = Some(file);
        self.unlocked = Some((key, Instant::now() + UNLOCK_LIFETIME));
        Ok(())
    }
    pub(crate) fn import(&mut self, document: &Document) -> Result<()> {
        self.store(document, None)
    }
    fn store(&mut self, document: &Document, source: Option<&str>) -> Result<()> {
        if self.file.is_none() {
            self.ready()?;
        }
        let mut file = self.file.as_ref().expect("initialized vault").clone();
        let key = self.active_key()?;
        let record_key = document.key();
        let mut persisted = document.clone();
        let mut recovery_source = source.map(str::to_owned).or_else(|| {
            document
                .recovery_code
                .as_ref()
                .map(|_| "service".to_owned())
        });
        if let Some(previous) = file.records.iter().find(|r| r.summary.key == record_key) {
            ensure!(
                previous.summary.revision <= document.revision,
                "账号秘钥簿已更新，请勿使用旧的授权"
            );
            if previous.summary.revision == document.revision && document.recovery_code.is_none() {
                let old = self.read(&record_key)?;
                recovery_source = previous.summary.recovery_source.clone();
                persisted.recovery_code = old.recovery_code.clone();
            }
        } else {
            ensure!(file.records.len() < 32, "本机已保存32个账号的秘钥簿条目");
        }
        let content = Zeroizing::new(serde_json::to_vec(&persisted)?);
        let summary = Summary {
            key: record_key.clone(),
            origin: document.origin.clone(),
            account: document.account.clone(),
            revision: document.revision,
            updated_at: crate::state::now(),
            recovery_backed_up: persisted.recovery_code.is_some(),
            recovery_source,
        };
        let sealed = seal(&key, &content, &serde_json::to_vec(&summary)?)?;
        file.records.retain(|r| r.summary.key != record_key);
        file.records.push(Record { summary, sealed });
        self.persist(&file)?;
        self.file = Some(file);
        Ok(())
    }
    pub(crate) fn import_recovery(&mut self, key: &str, recovery: &str) -> Result<()> {
        self.require_local_unlock()?;
        ensure!(
            recovery.len() == 44 && STANDARD.decode(recovery).is_ok_and(|b| b.len() == 32),
            "恢复码格式无效"
        );
        let mut document = self.read(key)?;
        document.recovery_code = Some(recovery.to_owned());
        self.store(&document, Some("manual"))
    }
    pub(crate) fn remove(&mut self, key: &str) -> Result<()> {
        self.require_local_unlock()?;
        let mut file = self.file.as_ref().context("秘钥簿暂无条目")?.clone();
        ensure!(
            file.records.iter().any(|r| r.summary.key == key),
            "找不到此账号的秘钥簿条目"
        );
        file.records.retain(|r| r.summary.key != key);
        self.persist(&file)?;
        self.file = Some(file);
        Ok(())
    }
    pub(crate) fn code(&mut self, key: &str) -> Result<Value> {
        self.require_local_unlock()?;
        let document = self.read(key)?;
        let now = crate::state::now();
        let counter = u64::try_from(now / 30_000)?;
        let seed = decode_secret(&document.totp_secret)?;
        Ok(
            json!({"code":totp(&seed,counter,6),"expiresAt":(counter+1)*30_000,"account":document.account,"origin":document.origin}),
        )
    }
    pub(crate) fn recovery(&mut self, key: &str) -> Result<Value> {
        self.require_local_unlock()?;
        let document = self.read(key)?;
        ensure!(
            document.recovery_code.is_some(),
            "此账号的恢复码尚未备份，请在下次更新恢复码时保存"
        );
        Ok(
            json!({"recoveryCode":document.recovery_code,"account":document.account,"origin":document.origin}),
        )
    }
    fn read(&mut self, record: &str) -> Result<Document> {
        let key = self.active_key()?;
        let record = self
            .file
            .as_ref()
            .and_then(|file| file.records.iter().find(|r| r.summary.key == record))
            .context("找不到此账号的秘钥簿条目")?;
        let plaintext = open(&key, &record.sealed, &serde_json::to_vec(&record.summary)?)?;
        Document::parse(std::str::from_utf8(&plaintext).context("账号秘钥簿损坏")?)
    }
    fn require_local_unlock(&mut self) -> Result<()> {
        // System and device protection are already authorized by the local settings
        // capability and owner-only storage. Only legacy passphrases need user input.
        self.active_key()?;
        Ok(())
    }
    fn persist(&self, value: &File) -> Result<()> {
        #[cfg(test)]
        ensure!(!self.fail_persist, "synthetic persistence failure");
        let temporary = self
            .directory
            .join(format!(".account-security-{}", Uuid::new_v4()));
        let result = (|| -> Result<()> {
            let mut file = crate::state::private_file(&temporary, true)?;
            let mut compatible = value.clone();
            if matches!(compatible.protection, Protection::Device) {
                compatible.protection = Protection::System;
            }
            serde_json::to_writer(&mut file, &compatible)?;
            file.flush()?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, self.directory.join(FILE))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}

fn device_key_path(directory: &Path, id: Uuid) -> PathBuf {
    directory.join(format!("account-security-key-{id}.bin"))
}

fn derive(passphrase: &str, salt: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let mut key = Zeroizing::new(vec![0; 32]);
    let params = Params::new(65_536, 3, 1, Some(32))
        .map_err(|_| anyhow::anyhow!("无法初始化本地备份加密"))?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|_| anyhow::anyhow!("无法解锁本地备份"))?;
    Ok(key)
}
fn seal(key: &[u8], plaintext: &[u8], associated: &[u8]) -> Result<Sealed> {
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key)
            .map_err(|_| anyhow::anyhow!("秘钥簿密钥无效"))?,
    );
    let nonce = rand::random::<[u8; 12]>();
    let mut ciphertext = Zeroizing::new(plaintext.to_vec());
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(associated),
        &mut *ciphertext,
    )
    .map_err(|_| anyhow::anyhow!("无法加密秘钥簿"))?;
    Ok(Sealed {
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(&ciphertext),
    })
}
fn open(key: &[u8], value: &Sealed, associated: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key)
            .map_err(|_| anyhow::anyhow!("秘钥簿密钥无效"))?,
    );
    let nonce: [u8; 12] = STANDARD
        .decode(&value.nonce)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("秘钥簿损坏"))?;
    let mut ciphertext = Zeroizing::new(STANDARD.decode(&value.ciphertext)?);
    let bytes = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(associated),
            &mut ciphertext,
        )
        .map_err(|_| anyhow::anyhow!("秘钥簿无法解密"))?
        .len();
    ciphertext.truncate(bytes);
    Ok(ciphertext)
}
fn decode_secret(value: &str) -> Result<Zeroizing<Vec<u8>>> {
    ensure!((32..=104).contains(&value.len()), "动态码密钥格式无效");
    let mut bits = 0u32;
    let mut count = 0u8;
    let mut decoded = Zeroizing::new(Vec::new());
    for c in value.bytes() {
        let byte = match c {
            b'A'..=b'Z' => c - b'A',
            b'2'..=b'7' => c - b'2' + 26,
            _ => bail!("动态码密钥格式无效"),
        };
        bits = (bits << 5) | u32::from(byte);
        count += 5;
        if count >= 8 {
            count -= 8;
            decoded.push((bits >> count) as u8);
        }
    }
    ensure!(
        (20..=64).contains(&decoded.len()) && bits & ((1u32 << count) - 1) == 0,
        "动态码密钥格式无效"
    );
    Ok(decoded)
}
fn totp(seed: &[u8], counter: u64, digits: usize) -> String {
    let signature = hmac::sign(
        &hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, seed),
        &counter.to_be_bytes(),
    );
    let signature = signature.as_ref();
    let offset = usize::from(signature[signature.len() - 1] & 15);
    let number = u32::from_be_bytes(
        signature[offset..offset + 4]
            .try_into()
            .expect("HMAC SHA1 truncation"),
    ) & 0x7fff_ffff;
    format!("{:0digits$}", number % 10u32.pow(digits as u32))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Memory(Arc<Mutex<Option<Vec<u8>>>>);
    impl Credentials for Memory {
        fn read(&self, _: Uuid) -> Result<Zeroizing<Vec<u8>>> {
            self.0
                .lock()
                .unwrap()
                .clone()
                .map(Zeroizing::new)
                .context("unavailable")
        }
        fn write(&self, _: Uuid, key: &[u8]) -> Result<()> {
            *self.0.lock().unwrap() = Some(key.to_vec());
            Ok(())
        }
    }
    struct Missing;
    impl Credentials for Missing {
        fn read(&self, _: Uuid) -> Result<Zeroizing<Vec<u8>>> {
            bail!("unavailable")
        }
        fn write(&self, _: Uuid, _: &[u8]) -> Result<()> {
            bail!("unavailable")
        }
    }
    fn document(revision: u64, recovery: bool) -> Document {
        Document::parse(&json!({"version":1,"origin":"https://app.example.test","account":{"id":"fixture-user","username":"fixture","displayName":"测试账号"},"revision":revision,"totpSecret":"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ","recoveryCode":if recovery{Some(STANDARD.encode([42u8;32]))}else{None}}).to_string()).unwrap()
    }
    #[test]
    fn rfc6238_sha1_vectors_and_six_digits() {
        for (timestamp, expected) in [
            (59, "94287082"),
            (1111111109, "07081804"),
            (1111111111, "14050471"),
            (1234567890, "89005924"),
            (2000000000, "69279037"),
            (20000000000u64, "65353130"),
        ] {
            assert_eq!(totp(b"12345678901234567890", timestamp / 30, 8), expected);
            assert_eq!(
                totp(b"12345678901234567890", timestamp / 30, 6),
                &expected[2..]
            );
        }
    }
    #[test]
    fn encrypted_system_store_survives_restart_and_rejects_tampering() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let directory = temp.path().join("vault");
        let secret = Arc::new(Mutex::new(None));
        let mut vault = Vault::with_credentials(&directory, Box::new(Memory(secret.clone())))?;
        let document = document(1, true);
        let key = document.key();
        vault.import(&document)?;
        let file = fs::read_to_string(directory.join(FILE))?;
        assert!(!file.contains(&document.totp_secret));
        assert!(!file.contains(document.recovery_code.as_ref().unwrap()));
        drop(vault);
        let mut vault = Vault::with_credentials(&directory, Box::new(Memory(secret)))?;
        vault.unlock("")?;
        assert_eq!(
            vault.recovery(&key)?["recoveryCode"],
            document.recovery_code.as_ref().unwrap().as_str()
        );
        assert_eq!(vault.code(&key)?["code"].as_str().unwrap().len(), 6);
        vault.file.as_mut().unwrap().records[0].summary.account.id = "other-user".into();
        assert!(vault.code(&key).is_err());
        Ok(())
    }
    #[test]
    fn no_keyring_automatically_encrypts_with_a_private_device_key_and_survives_restart()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let directory = temp.path().join("vault");
        let mut vault = Vault::with_credentials(&directory, Box::new(Missing))?;
        let document = document(1, true);
        let key = document.key();
        vault.import(&document)?;
        assert_eq!(vault.status()["protection"], "device");
        assert_eq!(vault.status()["locked"], false);
        let file = fs::read_to_string(directory.join(FILE))?;
        assert!(!file.contains(&document.totp_secret));
        assert!(!file.contains(document.recovery_code.as_ref().unwrap()));
        let path = vault.device_key_path(vault.file.as_ref().unwrap().key_id);
        // This validates the actual owner-only ACL on Windows as well as POSIX modes.
        assert_eq!(
            crate::state::private_file(&path, false)?.metadata()?.len(),
            32
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(path.metadata()?.permissions().mode() & 0o777, 0o600);
        }
        vault.lock();
        assert!(vault.code(&key).is_ok());
        drop(vault);
        let mut vault = Vault::with_credentials(&directory, Box::new(Missing))?;
        assert_eq!(vault.status()["locked"], false);
        assert_eq!(
            vault.recovery(&key)?["recoveryCode"],
            document.recovery_code.as_ref().unwrap().as_str()
        );
        assert!(vault.code(&key).is_ok());
        Ok(())
    }
    #[test]
    fn automatic_device_files_remain_readable_by_the_previous_strict_disk_schema() -> Result<()> {
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
        enum PreviousProtection {
            System,
            Passphrase { salt: String, wrapped: Sealed },
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct PreviousFile {
            version: u8,
            key_id: Uuid,
            protection: PreviousProtection,
            records: Vec<Record>,
        }
        let temp = tempfile::tempdir()?;
        let directory = temp.path().join("vault");
        let mut vault = Vault::with_credentials(&directory, Box::new(Missing))?;
        vault.import(&document(1, true))?;
        let bytes = fs::read(directory.join(FILE))?;
        let previous: PreviousFile = serde_json::from_slice(&bytes)?;
        assert_eq!(previous.version, 1);
        assert_eq!(previous.key_id, vault.file.as_ref().unwrap().key_id);
        assert_eq!(previous.records.len(), 1);
        match previous.protection {
            PreviousProtection::System => {}
            PreviousProtection::Passphrase { salt, wrapped } => {
                let _ = (salt, wrapped);
                bail!("The default disk schema must remain System")
            }
        }
        // A later OS keyring becoming available cannot silently change the file's key.
        drop(vault);
        let mut restored =
            Vault::with_credentials(&directory, Box::new(Memory(Default::default())))?;
        assert_eq!(restored.status()["protection"], "device");
        assert!(restored.code(&document(1, true).key()).is_ok());
        assert_eq!(fs::read(directory.join(FILE))?, bytes);
        Ok(())
    }
    #[test]
    fn legacy_passphrase_remains_locked_and_can_be_migrated_to_automatic_protection() -> Result<()>
    {
        let temp = tempfile::tempdir()?;
        let directory = temp.path().join("vault");
        let mut vault = Vault::with_credentials(&directory, Box::new(Missing))?;
        let document = document(1, true);
        let key = document.key();
        vault.configure_passphrase("fixture local backup phrase")?;
        vault.import(&document)?;
        let original = fs::read(directory.join(FILE))?;
        let previous_key = vault.active_key()?;
        vault.lock();
        assert!(vault.code(&key).is_err());
        assert!(vault.use_default_protection().is_err());
        assert!(vault.unlock("wrong passphrase").is_err());
        assert_eq!(fs::read(directory.join(FILE))?, original);
        vault.unlock("fixture local backup phrase")?;
        assert!(vault.code(&key).is_ok());
        vault.use_default_protection()?;
        assert_eq!(vault.status()["protection"], "device");
        let record = &vault.file.as_ref().unwrap().records[0];
        assert!(
            open(
                &previous_key,
                &record.sealed,
                &serde_json::to_vec(&record.summary)?
            )
            .is_err()
        );
        drop(vault);
        let mut vault = Vault::with_credentials(&directory, Box::new(Missing))?;
        assert_eq!(vault.status()["locked"], false);
        assert!(vault.recovery(&key).is_ok());
        Ok(())
    }
    #[test]
    fn failed_default_migration_preserves_the_locked_legacy_vault_and_removes_new_key() -> Result<()>
    {
        let temp = tempfile::tempdir()?;
        let directory = temp.path().join("vault");
        let mut vault = Vault::with_credentials(&directory, Box::new(Missing))?;
        vault.configure_passphrase("fixture local backup phrase")?;
        let document = document(1, true);
        let key = document.key();
        vault.import(&document)?;
        let original = fs::read(directory.join(FILE))?;
        vault.fail_persist = true;
        assert!(vault.use_default_protection().is_err());
        assert_eq!(fs::read(directory.join(FILE))?, original);
        assert_eq!(vault.status()["protection"], "passphrase");
        assert!(!fs::read_dir(&directory)?.any(|item| {
            item.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("account-security-key-")
        }));
        drop(vault);
        let mut restored = Vault::with_credentials(&directory, Box::new(Missing))?;
        assert!(restored.code(&key).is_err());
        restored.unlock("fixture local backup phrase")?;
        assert!(restored.recovery(&key).is_ok());
        Ok(())
    }
    #[test]
    fn migration_prefers_system_credentials_and_preserves_multiple_accounts_and_recovery()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let directory = temp.path().join("vault");
        let credentials = Arc::new(Mutex::new(None));
        let mut vault = Vault::with_credentials(&directory, Box::new(Memory(credentials.clone())))?;
        vault.configure_passphrase("fixture local backup phrase")?;
        let one = document(1, true);
        let mut two = document(1, true);
        two.account.id = "fixture-second".into();
        vault.import(&one)?;
        vault.import(&two)?;
        vault.import(&document(1, false))?;
        vault.use_default_protection()?;
        assert_eq!(vault.status()["protection"], "system");
        drop(vault);
        let mut restored = Vault::with_credentials(&directory, Box::new(Memory(credentials)))?;
        assert_eq!(restored.status()["accounts"].as_array().unwrap().len(), 2);
        assert_eq!(
            restored.recovery(&one.key())?["recoveryCode"],
            one.recovery_code.as_ref().unwrap().as_str()
        );
        assert!(restored.code(&two.key()).is_ok());
        Ok(())
    }
    #[test]
    fn corrupt_or_unsafe_device_key_never_reinitializes_or_overwrites_existing_records()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let directory = temp.path().join("vault");
        let mut vault = Vault::with_credentials(&directory, Box::new(Missing))?;
        let document = document(1, true);
        vault.import(&document)?;
        let path = vault.device_key_path(vault.file.as_ref().unwrap().key_id);
        let original = fs::read(directory.join(FILE))?;
        fs::write(&path, [0u8; 31])?;
        drop(vault);
        assert!(Vault::with_credentials(&directory, Box::new(Missing)).is_err());
        assert_eq!(fs::read(directory.join(FILE))?, original);
        assert_eq!(fs::metadata(&path)?.len(), 31);
        // Non-files/reparse targets must also fail the shared platform file validation.
        fs::remove_file(&path)?;
        fs::create_dir(&path)?;
        assert!(Vault::with_credentials(&directory, Box::new(Missing)).is_err());
        assert_eq!(fs::read(directory.join(FILE))?, original);
        Ok(())
    }
    #[test]
    fn device_key_rejects_permissions_granted_to_other_users() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let directory = temp.path().join("vault");
        let mut vault = Vault::with_credentials(&directory, Box::new(Missing))?;
        vault.import(&document(1, true))?;
        let path = vault.device_key_path(vault.file.as_ref().unwrap().key_id);
        let original = fs::read(directory.join(FILE))?;
        drop(vault);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644))?;
        }
        #[cfg(windows)]
        {
            let result = std::process::Command::new("icacls")
                .arg(&path)
                .args(["/grant", "*S-1-1-0:(R)"])
                .output()?;
            ensure!(
                result.status.success(),
                "Cannot create the synthetic unsafe ACL fixture"
            );
        }
        assert!(Vault::with_credentials(&directory, Box::new(Missing)).is_err());
        assert_eq!(fs::read(directory.join(FILE))?, original);
        Ok(())
    }
    #[test]
    fn new_revision_without_recovery_does_not_expose_old_recovery() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let directory = temp.path().join("vault");
        let mut vault = Vault::with_credentials(&directory, Box::new(Memory(Default::default())))?;
        let old = document(1, true);
        let key = old.key();
        vault.import(&old)?;
        vault.import(&document(2, false))?;
        vault.unlock("")?;
        assert!(vault.recovery(&key).is_err());
        assert!(vault.import(&old).is_err());
        assert_eq!(
            vault.remote_status(&old.origin, &old.account.id)["hasRecovery"],
            false
        );
        Ok(())
    }
    #[test]
    fn local_manual_recovery_and_removal_require_unlock_and_preserve_other_accounts() -> Result<()>
    {
        let temp = tempfile::tempdir()?;
        let mut vault = Vault::with_credentials(
            &temp.path().join("vault"),
            Box::new(Memory(Default::default())),
        )?;
        let one = document(1, false);
        let key = one.key();
        let mut two = document(1, false);
        two.account.id = "fixture-other".into();
        vault.import(&one)?;
        vault.import(&two)?;
        let recovery = STANDARD.encode([52u8; 32]);
        assert_eq!(vault.status()["locked"], false);
        assert!(vault.import_recovery(&key, "invalid").is_err());
        vault.import_recovery(&key, &recovery)?;
        assert_eq!(vault.recovery(&key)?["recoveryCode"], recovery);
        assert_eq!(vault.status()["accounts"][1]["recoverySource"], "manual");
        vault.import(&one)?;
        assert_eq!(vault.recovery(&key)?["recoveryCode"], recovery);
        vault.remove(&key)?;
        assert!(vault.code(&key).is_err());
        assert!(vault.code(&two.key()).is_ok());
        assert_eq!(vault.status()["accounts"].as_array().unwrap().len(), 1);
        Ok(())
    }
    #[test]
    fn synthetic_local_management_fixture() -> Result<()> {
        let Some(directory) = std::env::var_os("POCKET_NATIVE_SYNTHETIC_FIXTURE") else {
            return Ok(());
        };
        let directory = PathBuf::from(directory);
        ensure!(!directory.exists(), "合成测试必须使用尚不存在的独立目录");
        let mut vault = Vault::with_credentials(&directory, Box::new(Missing))?;
        vault.configure_passphrase("fixture local backup phrase")?;
        vault.import(&document(1, true))?;
        Ok(())
    }
}
