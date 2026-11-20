use crate::{codex_backend::Group, plugin_host::UpdateHold, plugins::Registry};
use anyhow::Result;

pub(crate) struct Maintenance {
    codex: Group,
    plugins: Registry,
}
pub(crate) struct Held {
    holds: Vec<UpdateHold>,
}

impl Maintenance {
    pub(crate) fn new(codex: Group, plugins: Registry) -> Self {
        Self { codex, plugins }
    }
    pub(crate) async fn hold(&self) -> Result<Held> {
        let mut hosts = self.codex.update_hosts();
        hosts.extend(self.plugins.update_hosts()?);
        let mut holds = Vec::new();
        for host in hosts {
            match host.hold_for_update().await {
                Ok(held) => holds.push(held),
                Err(error) => {
                    for held in holds {
                        held.resume().await;
                    }
                    return Err(error);
                }
            }
        }
        Ok(Held { holds })
    }
}
impl Held {
    pub(crate) fn commit(self) {
        for held in self.holds {
            held.commit();
        }
    }
    pub(crate) async fn resume(self) {
        for held in self.holds {
            held.resume().await;
        }
    }
}
