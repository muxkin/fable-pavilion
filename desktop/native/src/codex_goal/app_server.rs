use super::{Change, OBJECTIVE_LIMIT};
use crate::{
    codex_live::{Outcome, View},
    plugins::GoalOperation,
    state::hash,
};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashSet, path::PathBuf, sync::Arc, time::Duration};
use tokio::{sync::Mutex, time::timeout};
use uuid::Uuid;

mod transport;
pub(crate) use transport::AppServer;

#[derive(Clone)]
pub(crate) struct Goals {
    home: PathBuf,
    write: Arc<Mutex<()>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Goal {
    thread_id: Uuid,
    created_at: u64,
    objective: String,
    status: String,
    token_budget: Option<u64>,
    tokens_used: u64,
    time_used_seconds: u64,
}

impl Goal {
    fn parse(value: &Value, thread: Uuid) -> Result<Self> {
        let goal = Self::deserialize(value)?;
        ensure!(
            goal.thread_id == thread
                && (1..=OBJECTIVE_LIMIT).contains(&goal.objective.chars().count())
                && matches!(
                    goal.status.as_str(),
                    "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"
                ),
            "Codex 目标状态无效"
        );
        Ok(goal)
    }

    fn id(&self) -> String {
        format!("{}:{}", self.thread_id, self.created_at)
    }

    fn revision(&self) -> u64 {
        // Accounting updates may change updatedAt even while the objective is stable.
        let revision_fields = json!([self.id(), self.objective, self.status, self.token_budget]);
        u64::from_str_radix(&hash(&revision_fields.to_string())[..13], 16)
            .expect("goal revision is hexadecimal")
            + 1
    }

    fn catalog(&self) -> Value {
        json!({
            "ref":{"id":self.id(),"revision":self.revision()},
            "objective":self.objective,"phase":self.status,"tokenBudget":self.token_budget,
            "tokensUsed":self.tokens_used,"timeUsedSeconds":self.time_used_seconds,
        })
    }
}

pub(crate) fn snapshot_revision(value: &Value, thread: Uuid) -> Option<u64> {
    if value.is_null() {
        Some(0)
    } else {
        Goal::parse(value, thread).ok().map(|goal| goal.revision())
    }
}

impl Goals {
    pub(crate) fn new(home: PathBuf) -> Self {
        Self {
            home,
            write: Default::default(),
        }
    }

    pub(crate) async fn enrich(&self, result: &mut Value, thread: Uuid, view: &View) {
        if !view.supports_controls() {
            return;
        }
        let inspection = timeout(Duration::from_secs(3), async {
            let mut server = self.connect(thread).await?;
            let goal = get(&mut server, thread).await?;
            Ok::<_, anyhow::Error>(goal)
        })
        .await;
        result["goalObjectiveMaxLength"] = json!(OBJECTIVE_LIMIT);
        if let Ok(Ok(goal)) = inspection {
            result["actions"]
                .as_array_mut()
                .expect("Codex control actions")
                .push(json!("goal"));
            result["goal"] = goal.map(|goal| goal.catalog()).unwrap_or_default();
            return;
        }
        result["goal"] = view
            .native_goal
            .as_ref()
            .and_then(|goal| Goal::parse(goal, thread).ok())
            .map(|goal| goal.catalog())
            .unwrap_or_default();
        result["goalUnavailableReason"] =
            json!("Codex 目标控制需要连接此会话所在的共享 App Server");
    }

    async fn connect(&self, thread: Uuid) -> Result<AppServer> {
        let mut server = AppServer::connect(&self.home).await?;
        ensure!(
            thread_loaded(&mut server, thread).await?,
            "当前会话未加载在共享 Codex App Server 中"
        );
        Ok(server)
    }

    pub(crate) async fn change(&self, thread: Uuid, change: Change) -> Outcome {
        let Ok(change) = Change::new(change.operation, change.reference, change.objective) else {
            return Outcome::Rejected("Codex 目标参数无效".into());
        };
        let mut sent = false;
        let result = timeout(Duration::from_secs(8), async {
            let _write = self.write.lock().await;
            let mut server = self.connect(thread).await?;
            let current = get(&mut server, thread).await?;
            let request = change.request(thread, current.as_ref());
            let (method, params) = match request {
                Ok(request) => request,
                Err(error) => return Ok::<_, anyhow::Error>(Outcome::Rejected(error.into())),
            };
            sent = true;
            let reply = server.request(method, params.clone()).await?;
            if reply["error"]["code"].as_i64().is_some() {
                return Ok(Outcome::Rejected("Codex 拒绝更新目标，请刷新后重试".into()));
            }
            let confirmed = if matches!(change.operation, GoalOperation::Clear) {
                reply["result"]["cleared"] == true
            } else {
                Goal::parse(&reply["result"]["goal"], thread).is_ok_and(|goal| {
                    current
                        .as_ref()
                        .is_none_or(|current| current.created_at == goal.created_at)
                        && params["status"]
                            .as_str()
                            .is_none_or(|status| status == goal.status)
                        && params["objective"]
                            .as_str()
                            .is_none_or(|text| text == goal.objective)
                })
            };
            Ok(if confirmed {
                Outcome::Completed(None)
            } else {
                Outcome::Uncertain
            })
        })
        .await;
        match result {
            Ok(Ok(outcome)) => outcome,
            _ if sent => Outcome::Uncertain,
            _ => Outcome::Rejected("此会话的共享 Codex 目标接口暂不可用".into()),
        }
    }
}

pub(crate) async fn thread_loaded(server: &mut AppServer, thread: Uuid) -> Result<bool> {
    let mut query = json!({});
    let mut cursors = HashSet::new();
    loop {
        let loaded = server.request("thread/loaded/list", query).await?;
        ensure!(loaded["error"].is_null(), "Codex 无法确认已加载的会话");
        let result = &loaded["result"];
        let entries = result["data"].as_array().context("Codex 会话目录无效")?;
        if entries
            .iter()
            .any(|id| id.as_str().and_then(|id| Uuid::parse_str(id).ok()) == Some(thread))
        {
            return Ok(true);
        }
        let Some(cursor) = result["nextCursor"].as_str() else {
            return Ok(false);
        };
        ensure!(
            (1..=4096).contains(&cursor.len()) && cursors.insert(cursor.to_owned()),
            "Codex 会话分页游标无效"
        );
        query = json!({"cursor":cursor});
    }
}

async fn get(server: &mut AppServer, thread: Uuid) -> Result<Option<Goal>> {
    let reply = server
        .request("thread/goal/get", json!({"threadId":thread}))
        .await?;
    ensure!(reply["error"].is_null(), "Codex 目标接口不可用");
    let goal = reply["result"]
        .get("goal")
        .context("Codex 目标响应缺少结果")?;
    if goal.is_null() {
        Ok(None)
    } else {
        Goal::parse(goal, thread).map(Some)
    }
}

impl Change {
    fn request(
        &self,
        thread: Uuid,
        current: Option<&Goal>,
    ) -> Result<(&'static str, Value), &'static str> {
        let mut params = json!({"threadId":thread,"origin":"user"});
        if matches!(self.operation, GoalOperation::Create) {
            if current.is_some() {
                return Err("Codex 目标已存在，请刷新");
            }
            params["objective"] = json!(self.objective);
            params["status"] = json!("active");
            return Ok(("thread/goal/set", params));
        }
        let current = current
            .filter(|current| {
                self.reference.as_ref().is_some_and(|reference| {
                    reference.id == current.id() && reference.revision == current.revision()
                })
            })
            .ok_or("Codex 目标已变化，请刷新")?;
        match self.operation {
            GoalOperation::Edit => params["objective"] = json!(self.objective),
            GoalOperation::Pause if current.status == "active" => {
                params["status"] = json!("paused")
            }
            GoalOperation::Resume
                if matches!(
                    current.status.as_str(),
                    "paused" | "blocked" | "usageLimited" | "budgetLimited"
                ) =>
            {
                params["status"] = json!("active")
            }
            GoalOperation::Complete if current.status != "complete" => {
                params["status"] = json!("complete")
            }
            GoalOperation::Clear => return Ok(("thread/goal/clear", params)),
            _ => return Err("此 Codex 目标状态已变化，请刷新"),
        }
        Ok(("thread/goal/set", params))
    }
}
