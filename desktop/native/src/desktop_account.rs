//! Last server-confirmed human account for the local adapter. No session or secret is stored here.
use crate::offline_security::{Account, Document};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub(crate) type Shared = Arc<Mutex<Store>>;
const FILE: &str = "account-connection-v1.json";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved {
    version: u8,
    origin: String,
    account: Account,
    revision: u64,
    confirmed_at: i64,
}

pub(crate) struct Store {
    directory: PathBuf,
    saved: Option<Saved>,
}

impl Store {
    pub(crate) fn open(directory: &Path) -> Result<Self> {
        crate::state::private_directory(directory)?;
        let path = directory.join(FILE);
        let load = || -> Result<Saved> {
            let mut bytes = Vec::new();
            crate::state::private_file(&path, false)?
                .take(8193)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 8192, "账号状态文件过大");
            let saved: Saved = serde_json::from_slice(&bytes)?;
            let origin = url::Url::parse(&saved.origin)?;
            ensure!(
                saved.version == 1
                    && saved.revision > 0
                    && saved.confirmed_at > 0
                    && origin.origin().ascii_serialization() == saved.origin
                    && (1..=128).contains(&saved.account.id.len())
                    && saved
                        .account
                        .id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                    && [&saved.account.username, &saved.account.display_name]
                        .iter()
                        .all(|label| label.len() <= 320 && !label.chars().any(char::is_control)),
                "账号状态无效"
            );
            Ok(saved)
        };
        let saved = if path.exists() {
            match load() {
                Ok(value) => Some(value),
                Err(_) => {
                    eprintln!(
                        "Local account display metadata could not be loaded; waiting for confirmation."
                    );
                    None
                }
            }
        } else {
            None
        };
        Ok(Self {
            directory: directory.to_owned(),
            saved,
        })
    }

    /// Called only after the one-use server approval has verified this account,
    /// host, Noise device, revision and exact imported document.
    pub(crate) fn confirm(&mut self, document: &Document) -> Result<()> {
        let saved = Saved {
            version: 1,
            origin: document.origin.clone(),
            account: document.account.clone(),
            revision: document.revision,
            confirmed_at: crate::state::now(),
        };
        if let Some(previous) = &self.saved {
            ensure!(
                previous.origin != saved.origin
                    || previous.account.id != saved.account.id
                    || previous.revision <= saved.revision,
                "账号状态已更新，请重新同步"
            );
        }
        let temporary = self
            .directory
            .join(format!(".account-connection-{}", uuid::Uuid::new_v4()));
        let result = (|| -> Result<()> {
            let mut file = crate::state::create_private_file(&temporary)?;
            serde_json::to_writer(&mut file, &saved)?;
            file.flush()?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, self.directory.join(FILE)).context("暂时无法保存账号状态")?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        self.saved = Some(saved);
        Ok(())
    }

    pub(crate) fn view(&self, origin: &str, revoked: bool) -> Value {
        self.saved
            .as_ref()
            .filter(|saved| saved.origin == origin)
            .map(|saved| {
                json!({
                    "state":if revoked {"reauthorize"} else {"signedIn"},
                    "user":saved.account,"origin":saved.origin,"confirmedAt":saved.confirmed_at,
                })
            })
            .unwrap_or(Value::Null)
    }
    pub(crate) fn confirmed(&self, origin: &str, account: &str, revision: u64) -> bool {
        self.saved.as_ref().is_some_and(|saved| {
            saved.origin == origin && saved.account.id == account && saved.revision >= revision
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confirmed_identity_survives_restart_is_origin_scoped_and_is_not_a_session() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let directory = temp.path().join("state");
        let mut state = Store::open(&directory)?;
        assert!(state.view("https://example.test", false).is_null());
        assert!(!state.confirmed("https://example.test", "fixture-user", 1));
        let doc = Document::parse(
            &json!({"version":1,"origin":"https://example.test",
            "account":{"id":"fixture-user","username":"fixture","displayName":"测试账号"},
            "revision":2,"totpSecret":"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"})
            .to_string(),
        )?;
        state.confirm(&doc)?;
        let bytes = fs::read_to_string(directory.join(FILE))?;
        assert!(!bytes.contains(&doc.totp_secret));
        assert!(!bytes.contains("recoveryCode"));
        drop(state);
        let mut state = Store::open(&directory)?;
        assert_eq!(state.view(&doc.origin, false)["user"]["id"], doc.account.id);
        assert_eq!(state.view(&doc.origin, false)["state"], "signedIn");
        assert!(state.confirmed(&doc.origin, &doc.account.id, 2));
        assert!(!state.confirmed(&doc.origin, &doc.account.id, 3));
        assert!(!state.confirmed(&doc.origin, "other-account", 2));
        assert_eq!(state.view(&doc.origin, true)["state"], "reauthorize");
        assert!(state.view("https://other.test", false).is_null());
        let mut stale = doc.clone();
        stale.revision = 1;
        assert!(state.confirm(&stale).is_err());
        assert_eq!(fs::read_to_string(directory.join(FILE))?, bytes);
        Ok(())
    }
}
