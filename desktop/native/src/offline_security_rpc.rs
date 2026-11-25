use crate::offline_security::{Document, Shared};
use anyhow::{Context, Result, ensure};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use libp2p_identity::Keypair;
use ring::{aead, hkdf};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use url::Url;
use zeroize::Zeroizing;

#[derive(Debug)]
pub(crate) struct LocalProtection;
impl std::fmt::Display for LocalProtection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("请在适配器中解锁已有的秘钥簿")
    }
}
impl std::error::Error for LocalProtection {}

#[derive(Clone)]
pub(crate) struct Service {
    vault: Shared,
    origin: String,
    endpoint: Url,
    client: reqwest::Client,
    update_gate: Option<crate::update::UpdateGate>,
    account_status: Option<crate::desktop_account::Shared>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Import {
    proof: String,
    document: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Challenge {
    origin: String,
    account_id: String,
    revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Approval {
    account_id: String,
    revision: u64,
    origin: String,
    host_id: String,
    device_id: String,
}

impl Service {
    pub(crate) fn new(origin: &Url, vault: Shared) -> Result<Self> {
        Ok(Self {
            vault,
            origin: origin.origin().ascii_serialization(),
            endpoint: origin.join("/api/im/crypto/desktop-backup/redeem")?,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(8))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            update_gate: None,
            account_status: None,
        })
    }
    pub(crate) fn with_update_gate(mut self, gate: crate::update::UpdateGate) -> Self {
        self.update_gate = Some(gate);
        self
    }
    pub(crate) fn with_account_status(mut self, state: crate::desktop_account::Shared) -> Self {
        self.account_status = Some(state);
        self
    }
    /// An authenticated paired Noise peer can request synchronization to its own
    /// device. This proof neither enrolls a host nor reveals account secrets.
    pub(crate) fn challenge(&self, body: Value, identity: &Keypair, device: &str) -> Result<Value> {
        let request: Challenge = serde_json::from_value(body).context("秘钥簿同步请求无效")?;
        ensure!(request.origin == self.origin, "备份服务地址不匹配");
        ensure!(
            (1..=128).contains(&request.account_id.len())
                && request
                    .account_id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                && (1..=1_000_000).contains(&request.revision),
            "秘钥簿账号状态无效"
        );
        ensure!(uuid::Uuid::parse_str(device).is_ok(), "秘钥簿设备无效");
        let host = identity.public().to_peer_id().to_string();
        let nonce = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
        let issued = crate::state::now();
        let proof = format!(
            "codex-pocket/keybook-sync/1\n{}\n{host}\n{device}\n{}\n{}\n{nonce}\n{issued}",
            self.origin, request.account_id, request.revision,
        );
        Ok(json!({
            "hostId":host,"deviceId":device,"accountId":request.account_id,
            "revision":request.revision,"nonce":nonce,"issuedAt":issued,
            "signature":STANDARD.encode(identity.sign(proof.as_bytes())?),
        }))
    }
    pub(crate) async fn status(&self, query: &Value) -> Result<Value> {
        let origin = query["origin"].as_str().context("服务地址无效")?;
        let account = query["accountId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .context("账号无效")?;
        ensure!(origin == self.origin, "备份服务地址不匹配");
        let mut status = self
            .vault
            .lock()
            .expect("security vault mutex")
            .remote_status(origin, account);
        if let Some(state) = &self.account_status {
            status["accountConfirmed"] =
                json!(status["revision"].as_u64().is_some_and(|revision| {
                    state
                        .lock()
                        .expect("account status mutex")
                        .confirmed(origin, account, revision)
                }));
        }
        Ok(status)
    }
    pub(crate) async fn import(&self, host: &str, device: &str, body: Value) -> Result<Value> {
        let activity = self
            .update_gate
            .as_ref()
            .map(|gate| gate.admit().context("正在更新，请稍后重试"))
            .transpose()?
            .map(Arc::new);
        let request: Import = serde_json::from_value(body).context("备份请求格式无效")?;
        let document_bytes = Zeroizing::new(request.document);
        let document = Document::parse(&document_bytes)?;
        ensure!(document.origin == self.origin, "备份服务地址不匹配");
        ensure!(
            request.proof.len() == 43
                && request
                    .proof
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
            "备份授权无效"
        );
        let vault = self.vault.clone();
        let initializing_activity = activity.clone();
        let initialized = tokio::task::spawn_blocking(move || {
            let _activity = initializing_activity;
            vault.lock().expect("security vault mutex").ready()
        })
        .await?;
        if let Err(error) = initialized {
            let status = self.vault.lock().expect("security vault mutex").status();
            if status["protection"] == "passphrase" && status["locked"] == true {
                return Err(LocalProtection.into());
            }
            return Err(error.context("本机秘钥簿尚未保存，请重试"));
        }
        let hash = format!("{:x}", Sha256::digest(document_bytes.as_bytes()));
        let totp_hash = document
            .totp_secret
            .as_deref()
            .map(|secret| format!("{:x}", Sha256::digest(secret.as_bytes())))
            .unwrap_or_default();
        let has_totp = document.totp_secret.is_some();
        let mut request = json!({"proof":request.proof,"hostId":host,"deviceId":device,"payloadHash":hash,
            "totpHash":totp_hash});
        if let Some(code) = &document.recovery_code {
            request["recoveryAuth"] = json!(recovery_auth(code)?);
        }
        let approval = self
            .client
            .post(self.endpoint.clone())
            .json(&request)
            .send()
            .await
            .context("暂时无法确认备份授权，请重试")?;
        ensure!(
            approval.status() == reqwest::StatusCode::OK,
            "备份授权已失效，请重新确认"
        );
        let approval: Approval = approval.json().await.context("备份授权格式无效")?;
        ensure!(
            approval.account_id == document.account.id
                && approval.revision == document.revision
                && approval.origin == document.origin
                && approval.host_id == host
                && approval.device_id == device,
            "备份授权不匹配"
        );
        let vault = self.vault.clone();
        let revision = document.revision;
        let account_status = self.account_status.clone();
        let has_recovery = tokio::task::spawn_blocking(move || {
            let _activity = activity;
            if let Some(state) = account_status {
                state
                    .lock()
                    .expect("account status mutex")
                    .confirm(&document)?;
            }
            let mut vault = vault.lock().expect("security vault mutex");
            vault.import(&document)?;
            Ok::<bool, anyhow::Error>(
                vault.remote_status(&document.origin, &document.account.id)["hasRecovery"]
                    .as_bool()
                    .unwrap_or(false),
            )
        })
        .await??;
        Ok(json!({"ok":true,"revision":revision,"hasTotp":has_totp,"hasRecovery":has_recovery}))
    }
}

fn recovery_auth(code: &str) -> Result<String> {
    let raw = Zeroizing::new(STANDARD.decode(code)?);
    ensure!(raw.len() == 32, "恢复码格式无效");
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, &[0; 32]);
    let prk = salt.extract(&raw);
    let info = [b"pocket-account-v1:recovery-authentication".as_slice()];
    let okm = prk
        .expand(&info, &aead::AES_256_GCM)
        .map_err(|_| anyhow::anyhow!("恢复码校验失败"))?;
    let mut auth = Zeroizing::new([0u8; 32]);
    okm.fill(auth.as_mut())
        .map_err(|_| anyhow::anyhow!("恢复码校验失败"))?;
    Ok(STANDARD.encode(auth.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paired_sync_challenge_binds_the_exact_account_device_origin_and_revision() -> Result<()> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let temp = tempfile::tempdir()?;
        let service = Service::new(
            &Url::parse("https://example.test")?,
            Arc::new(std::sync::Mutex::new(crate::offline_security::Vault::open(
                &temp.path().join("state"),
            )?)),
        )?;
        let identity = Keypair::generate_ed25519();
        let device = uuid::Uuid::new_v4().to_string();
        let body =
            json!({"origin":"https://example.test","accountId":"synthetic-account","revision":3});
        let result = service.challenge(body.clone(), &identity, &device)?;
        let host = identity.public().to_peer_id().to_string();
        assert_eq!(result["hostId"], host);
        assert_eq!(result["deviceId"], device);
        assert_eq!(result["accountId"], "synthetic-account");
        assert_eq!(result["revision"], 3);
        let nonce = result["nonce"].as_str().unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(nonce)?.len(), 32);
        let issued = result["issuedAt"].as_i64().unwrap();
        let proof = format!(
            "codex-pocket/keybook-sync/1\nhttps://example.test\n{host}\n{device}\nsynthetic-account\n3\n{nonce}\n{issued}"
        );
        let signature = STANDARD.decode(result["signature"].as_str().unwrap())?;
        assert!(identity.public().verify(proof.as_bytes(), &signature));
        assert!(
            !identity
                .public()
                .verify(proof.replace("\n3\n", "\n4\n").as_bytes(), &signature)
        );
        let second = service.challenge(body.clone(), &identity, &device)?;
        assert_ne!(result["nonce"], second["nonce"]);
        for invalid in [
            json!({"origin":"https://foreign.test","accountId":"synthetic-account","revision":3}),
            json!({"origin":"https://example.test","accountId":"","revision":3}),
            json!({"origin":"https://example.test","accountId":"synthetic-account","revision":0}),
            json!({"origin":"https://example.test","accountId":"synthetic-account","revision":3,"deviceId":device}),
        ] {
            assert!(service.challenge(invalid, &identity, &device).is_err());
        }
        assert!(service.challenge(body, &identity, "not-a-device").is_err());
        assert!(!temp.path().join("state/account-security-v1.json").exists());
        Ok(())
    }

    #[tokio::test]
    async fn update_drain_rejects_import_before_consuming_approval_or_initializing_credentials()
    -> Result<()> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let temp = tempfile::tempdir()?;
        let directory = temp.path().join("state");
        let database = Arc::new(std::sync::Mutex::new(crate::state::Store::open(
            &directory,
        )?));
        let gate = crate::update::UpdateGate::default();
        assert!(gate.drain_requested(&database, true)?);
        let service = Service::new(
            &Url::parse("https://example.test")?,
            Arc::new(std::sync::Mutex::new(crate::offline_security::Vault::open(
                &directory,
            )?)),
        )?
        .with_update_gate(gate);
        let error = service
            .import("synthetic-host", "synthetic-device", json!({}))
            .await
            .expect_err("An importer must not enter during installation");
        assert_eq!(error.to_string(), "正在更新，请稍后重试");
        assert!(!directory.join("account-security-v1.json").exists());
        Ok(())
    }

    #[test]
    fn recovery_auth_matches_the_shared_web_hkdf_contract() -> Result<()> {
        assert_eq!(
            recovery_auth(&STANDARD.encode([42u8; 32]))?,
            "uw7oTChZz47ubcyX5satna8pf2C7vdUpRVNTZaBRlqk="
        );
        assert!(recovery_auth(&STANDARD.encode([42u8; 31])).is_err());
        Ok(())
    }
}
