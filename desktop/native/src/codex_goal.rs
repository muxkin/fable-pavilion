use crate::plugins::{GoalOperation, GoalRef};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

const OBJECTIVE_LIMIT: usize = 4_000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Change {
    operation: GoalOperation,
    reference: Option<GoalRef>,
    objective: Option<String>,
}

impl Change {
    pub(crate) fn new(
        operation: GoalOperation,
        reference: Option<GoalRef>,
        objective: Option<String>,
    ) -> Result<Self> {
        let objective = objective.map(|value| value.trim().to_owned());
        ensure!(
            match operation {
                GoalOperation::Create => reference.is_none(),
                _ => reference.as_ref().is_some_and(|reference| {
                    (1..=200).contains(&reference.id.len())
                        && (1..=0x1f_ffff_ffff_ffff).contains(&reference.revision)
                }),
            },
            "Codex 目标引用无效"
        );
        ensure!(
            match operation {
                GoalOperation::Create | GoalOperation::Edit => objective
                    .as_ref()
                    .is_some_and(|text| (1..=OBJECTIVE_LIMIT).contains(&text.chars().count())
                        && !text.contains('\0')),
                _ => objective.is_none(),
            },
            "Codex 目标内容无效"
        );
        Ok(Self {
            operation,
            reference,
            objective,
        })
    }
}

#[cfg(feature = "official-plugins")]
mod app_server;
#[cfg(feature = "official-plugins")]
pub(crate) use app_server::{AppServer, Goals, snapshot_revision, thread_loaded};
