#[cfg(feature = "official-plugins")]
use crate::app_tools::{AppTools, Tool, call, invoke, tool_text};
use crate::state::now;
#[cfg(feature = "official-plugins")]
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Mutex, OwnedMutexGuard};
#[cfg(feature = "official-plugins")]
use tokio::time::{Instant, timeout};
use url::Url;
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct ResetProofVerifier {
    http: reqwest::Client,
    endpoint: Url,
    reset: Arc<Mutex<()>>,
}

impl ResetProofVerifier {
    pub(crate) fn new(origin: &Url) -> anyhow::Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(6))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            endpoint: origin.join("/api/im/crypto/usage-reset/redeem")?,
            reset: Default::default(),
        })
    }

    pub(crate) fn origin(&self) -> String {
        self.endpoint.origin().ascii_serialization()
    }

    pub(crate) fn admit(&self) -> Result<OwnedMutexGuard<()>, ResetError> {
        self.reset
            .clone()
            .try_lock_owned()
            .map_err(|_| ResetError::InProgress)
    }

    pub(crate) async fn redeem(
        &self,
        proof: &str,
        host: &str,
        device: &str,
        backend: &str,
        request: Uuid,
    ) -> Result<(), ResetError> {
        let result = self
            .http
            .post(self.endpoint.clone())
            .json(&json!({
                "proof":proof, "hostId":host, "deviceId":device,
                "backendId":backend, "requestId":request,
            }))
            .send()
            .await
            .map_err(|_| ResetError::VerificationUnavailable)?;
        match result.status().as_u16() {
            204 => Ok(()),
            404 => Err(ResetError::Unavailable),
            400 | 401 | 403 | 409 | 410 => Err(ResetError::InvalidProof),
            429 => Err(ResetError::RateLimited),
            _ => Err(ResetError::VerificationUnavailable),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) enum ResetError {
    InvalidProof,
    VerificationUnavailable,
    Unavailable,
    Disabled,
    ChatGptRequired,
    WindowNotEligible,
    InProgress,
    RateLimited,
    ConflictingRequest,
    Uncertain,
}

impl ResetError {
    pub(crate) fn status(self) -> u16 {
        match self {
            Self::InvalidProof => 403,
            Self::RateLimited => 429,
            Self::VerificationUnavailable | Self::InProgress | Self::Uncertain => 503,
            _ => 409,
        }
    }
}

impl std::fmt::Display for ResetError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidProof => "重置确认无效或已过期，请重新确认",
            Self::VerificationUnavailable => "暂时无法验证重置确认，请重试",
            Self::Unavailable => "当前 Codex 实例不支持重置用量",
            Self::Disabled => "请先在 Codex 桌面的用量设置中允许 Codex 使用重置次数",
            Self::ChatGptRequired => "此操作需要 Codex 桌面登录 ChatGPT 账号",
            Self::WindowNotEligible => "重置需要 Codex 的 5 小时或每周额度剩余 10% 或更少",
            Self::InProgress => "正在确认一个用量重置请求，请稍后重试",
            Self::RateLimited => "操作过于频繁，请稍后重新确认",
            Self::ConflictingRequest => "请求 ID 已用于其他操作",
            Self::Uncertain => "暂未确认重置结果，请查看最新用量或重试本次请求",
        })
    }
}

impl std::error::Error for ResetError {}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ResetOutcome {
    Reset,
    AlreadyRedeemed,
    NothingToReset,
    NoCredit,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct ResetResult {
    pub(crate) outcome: ResetOutcome,
    pub(crate) usage: Option<Value>,
}

impl crate::state::Store {
    pub(crate) fn usage_reset_receipt(
        &self,
        backend: &str,
        device: &str,
        request: Uuid,
    ) -> anyhow::Result<Option<ResetResult>> {
        use rusqlite::OptionalExtension;
        let row: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT device_id,outcome FROM native_usage_resets WHERE backend_id=? AND request_id=?",
                rusqlite::params![backend, request.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((owner, outcome)) = row else {
            return Ok(None);
        };
        anyhow::ensure!(owner == device, ResetError::ConflictingRequest);
        Ok(Some(ResetResult {
            outcome: serde_json::from_str(&outcome)?,
            usage: None,
        }))
    }

    pub(crate) fn record_usage_reset(
        &self,
        backend: &str,
        device: &str,
        request: Uuid,
        result: &ResetResult,
    ) -> anyhow::Result<()> {
        self.db.execute(
            "INSERT INTO native_usage_resets (backend_id,request_id,device_id,outcome) VALUES (?,?,?,?)",
            rusqlite::params![
                backend,
                request.to_string(),
                device,
                serde_json::to_string(&result.outcome)?,
            ],
        )?;
        Ok(())
    }
}

#[cfg(feature = "official-plugins")]
#[derive(Clone)]
pub struct Usage {
    tools: AppTools,
    cached: Arc<Mutex<Option<(Instant, Value)>>>,
}

#[cfg(feature = "official-plugins")]
impl Usage {
    pub fn new(tools: AppTools) -> Self {
        Self {
            tools,
            cached: Default::default(),
        }
    }

    pub async fn read(&self, anchor: Uuid, force_refresh: bool) -> Value {
        let mut cache = self.cached.lock().await;
        if !force_refresh
            && let Some((time, value)) = &*cache
            && time.elapsed() < Duration::from_secs(30)
        {
            return value.clone();
        }
        let value = match timeout(Duration::from_secs(15), self.fetch(anchor)).await {
            Ok(Ok(value)) => value,
            _ => unavailable("本机桌面用量暂不可用"),
        };
        if value["available"] == true {
            *cache = Some((Instant::now(), value.clone()));
        } else {
            *cache = None;
        }
        value
    }

    async fn fetch(&self, anchor: Uuid) -> Result<Value> {
        let mut stream = self.tools.connect(Tool::Usage).await?;
        let value = call(
            &mut stream,
            &anchor.to_string(),
            Uuid::new_v4(),
            Tool::Usage,
            json!({}),
        )
        .await?;
        Ok(normalize(
            &value,
            self.tools.catalog().has(Tool::UsageReset),
        ))
    }

    pub(crate) async fn reset(
        &self,
        anchor: Uuid,
        request: Uuid,
    ) -> Result<ResetResult, ResetError> {
        let mut cache = self.cached.lock().await;
        let mut stream = self
            .tools
            .connect(Tool::UsageReset)
            .await
            .map_err(|_| ResetError::Unavailable)?;
        // A failed acknowledgement may still have reset the limits. Refresh on the next read.
        *cache = None;
        let reply = invoke(
            &mut stream,
            &anchor.to_string(),
            request,
            Tool::UsageReset,
            json!({"idempotencyKey":request}),
        )
        .await
        .map_err(|_| ResetError::Uncertain)?;
        let result = reset_result(&reply, request)?;
        if let Some(usage) = &result.usage {
            *cache = Some((Instant::now(), usage.clone()));
        }
        Ok(result)
    }
}

#[cfg(feature = "official-plugins")]
fn reset_result(reply: &Value, request: Uuid) -> Result<ResetResult, ResetError> {
    let text = tool_text(reply).ok_or(ResetError::Uncertain)?;
    if reply["success"] == false {
        let details = serde_json::from_str::<Value>(text).unwrap_or_default();
        return Err(match text {
            "Codex is not allowed to use usage resets. Enable \"Allow Codex to use resets\" in Usage settings." => {
                ResetError::Disabled
            }
            "Usage resets require a ChatGPT account on this task's host." => {
                ResetError::ChatGptRequired
            }
            _ if details["idempotencyKey"] == json!(request)
                && details["error"].as_str().is_some_and(|error| {
                    error.starts_with(
                        "More than 10% remains in every available core Codex usage window.",
                    )
                }) =>
            {
                ResetError::WindowNotEligible
            }
            _ => ResetError::Uncertain,
        });
    }
    let result = serde_json::from_str::<Value>(text).map_err(|_| ResetError::Uncertain)?;
    if reply["success"] != true || result["idempotencyKey"] != json!(request) {
        return Err(ResetError::Uncertain);
    }
    Ok(ResetResult {
        outcome: serde_json::from_value(result["outcome"].clone())
            .map_err(|_| ResetError::Uncertain)?,
        usage: result["usage"]
            .is_object()
            .then(|| normalize(&result["usage"], true)),
    })
}

pub fn unavailable(reason: &str) -> Value {
    json!({"available":false,"updatedAt":now(),"buckets":[],"reason":reason})
}

#[cfg(feature = "official-plugins")]
fn normalize(value: &Value, can_reset: bool) -> Value {
    // The compatibility bucket describes the same core Codex account as the map's codex bucket.
    let credits = [
        &value["rateLimitsByLimitId"]["codex"]["credits"],
        &value["rateLimits"]["credits"],
    ]
    .into_iter()
    .find_map(|credits| {
        Some(json!({
            "balance":credits["balance"].as_str(),
            "hasCredits":credits["hasCredits"].as_bool()?,
            "unlimited":credits["unlimited"].as_bool()?,
        }))
    });
    let reset_count = &value["rateLimitResetCredits"]["availableCount"];
    let reset_count = reset_count
        .as_u64()
        .or_else(|| reset_count.as_str()?.parse::<u64>().ok())
        .filter(|count| *count <= 9_007_199_254_740_991);
    let limits: Vec<_> = if let Some(limits) = value["rateLimitsByLimitId"]
        .as_object()
        .filter(|limits| !limits.is_empty())
    {
        limits
            .iter()
            .map(|(id, limit)| (id.as_str(), limit))
            .collect()
    } else {
        let limit = &value["rateLimits"];
        vec![(limit["limitId"].as_str().unwrap_or("codex"), limit)]
    };
    let buckets: Vec<_> = limits
        .into_iter()
        .filter_map(|(id, limit)| {
            let windows: Vec<_> = ["primary", "secondary"]
                .into_iter()
                .enumerate()
                .filter_map(|(index, key)| {
                    let window = &limit[key];
                    let percent = window["usedPercent"].as_f64()?.clamp(0.0, 100.0);
                    let duration = window["windowDurationMins"]
                        .as_u64()
                        .filter(|minutes| *minutes > 0);
                    let label = match duration {
                        Some(10080) => "每周用量".into(),
                        Some(300) => "5 小时用量".into(),
                        Some(minutes) => format!("{minutes} 分钟用量"),
                        None if index == 0 => "当前用量".into(),
                        None => "长期用量".into(),
                    };
                    let mut result = json!({"label":label,"usedPercent":percent});
                    if let Some(minutes) = duration {
                        result["durationMinutes"] = json!(minutes);
                    }
                    if let Some(reset) = window["resetsAt"]
                        .as_i64()
                        .filter(|seconds| *seconds > 0)
                        .and_then(|seconds| seconds.checked_mul(1000))
                    {
                        result["resetsAt"] = json!(reset);
                    }
                    Some(result)
                })
                .collect();
            if windows.is_empty() {
                return None;
            }
            let mut result =
                json!({"id":id,"name":limit["limitName"].as_str().unwrap_or(id),"windows":windows});
            if let Some(plan) = limit["planType"].as_str() {
                result["plan"] = json!(plan);
            }
            Some(result)
        })
        .collect();
    if buckets.is_empty() && credits.is_none() && reset_count.is_none() {
        return unavailable("当前账户暂未提供用量信息");
    }
    let mut result =
        json!({"available":true,"updatedAt":now(),"buckets":buckets,"canReset":can_reset});
    if let Some(credits) = credits {
        result["credits"] = credits;
    }
    if let Some(count) = reset_count {
        result["rateLimitResetCredits"] = json!({"availableCount":count});
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "official-plugins")]
    #[test]
    fn labels_weekly_primary_by_duration_and_preserves_missing_five_hour_window() {
        // The live desktop can return only a weekly primary window. The
        // compatibility bucket must not add its stale five-hour view to it.
        let mut input = json!({
            "rateLimits":{"limitId":"codex","primary":{
                "usedPercent":99,"windowDurationMins":300
            }},
            "rateLimitsByLimitId":{"codex":{"planType":"pro","primary":{
                "usedPercent":27.4,"windowDurationMins":10080,"resetsAt":1700000000
            },"secondary":null}}
        });
        let usage = normalize(&input, false);
        assert_eq!(usage["available"], true);
        assert_eq!(
            usage["buckets"],
            json!([{
                "id":"codex","name":"codex","plan":"pro","windows":[{
                    "label":"每周用量","usedPercent":27.4,"durationMinutes":10080,
                    "resetsAt":1700000000000_i64
                }]
            }])
        );

        input["rateLimitsByLimitId"]["codex"]["secondary"] = json!({
            "usedPercent":63.7,"windowDurationMins":300
        });
        let usage = normalize(&input, false);
        let windows = usage["buckets"][0]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0]["label"], "每周用量");
        assert_eq!(windows[1]["label"], "5 小时用量");
        assert_eq!(windows[1]["usedPercent"], 63.7);
    }

    #[cfg(feature = "official-plugins")]
    #[test]
    fn legacy_fallback_requires_an_absent_or_empty_bucket_map() {
        let legacy = json!({"limitId":"codex","secondary":{
            "usedPercent":12,"windowDurationMins":300
        }});
        for map in [None, Some(Value::Null), Some(json!({}))] {
            let mut input = json!({"rateLimits":legacy});
            if let Some(map) = map {
                input["rateLimitsByLimitId"] = map;
            }
            let usage = normalize(&input, false);
            assert_eq!(
                usage["buckets"][0]["windows"],
                json!([{
                    "label":"5 小时用量","usedPercent":12.0,"durationMinutes":300
                }])
            );
        }
        let usage = normalize(
            &json!({
                "rateLimits":legacy,
                "rateLimitsByLimitId":{"review":{"limitName":"Review","primary":{
                    "usedPercent":75,"windowDurationMins":10080
                }}}
            }),
            false,
        );
        assert_eq!(usage["buckets"].as_array().unwrap().len(), 1);
        assert_eq!(usage["buckets"][0]["id"], "review");
        assert_eq!(usage["buckets"][0]["windows"][0]["usedPercent"], 75.0);

        let missing = normalize(
            &json!({"rateLimitsByLimitId":{"codex":{
                "primary":null,"secondary":{"usedPercent":null,"windowDurationMins":300}
            }}}),
            false,
        );
        assert_eq!(missing["available"], false);
        assert_eq!(missing["buckets"], json!([]));
    }

    #[cfg(feature = "official-plugins")]
    #[test]
    fn reads_core_credits_and_explicit_reset_count_without_exposing_identity() {
        let input = json!({
            "accountId":"private-account",
            "rateLimits":{"limitId":"codex","primary":{"usedPercent":95}},
            "rateLimitsByLimitId":{
                "codex":{"primary":{"usedPercent":95,"windowDurationMins":300},"credits":{
                    "balance":"12.500","hasCredits":true,"unlimited":false
                }},
                "other":{"credits":{"balance":"99.00","hasCredits":true,"unlimited":false}}
            },
            "rateLimitResetCredits":{"availableCount":"5","credits":[{"id":"private-credit"}]}
        });
        let usage = normalize(&input, true);
        assert_eq!(
            usage["credits"],
            json!({"balance":"12.500","hasCredits":true,"unlimited":false})
        );
        assert_eq!(usage["rateLimitResetCredits"], json!({"availableCount":5}));
        assert_eq!(usage["canReset"], true);
        assert_eq!(usage["buckets"][0]["windows"][0]["usedPercent"], 95.0);
        assert!(usage.get("accountId").is_none());

        let legacy = normalize(
            &json!({"rateLimits":{"primary":{"usedPercent":1}},"rateLimitResetCredits":null}),
            false,
        );
        assert_eq!(legacy["available"], true);
        assert_eq!(legacy["canReset"], false);
        assert!(legacy.get("credits").is_none());
        assert!(legacy.get("rateLimitResetCredits").is_none());
        let zero = normalize(&json!({"rateLimitResetCredits":{"availableCount":0}}), true);
        assert_eq!(zero["available"], true);
        assert_eq!(zero["rateLimitResetCredits"]["availableCount"], 0);
    }

    #[cfg(feature = "official-plugins")]
    #[test]
    fn trusts_only_confirmed_outcomes_and_matching_attempt_ids() {
        let request = Uuid::new_v4();
        let tool_reply = |success: bool, text: String| json!({"success":success,"contentItems":[{"type":"inputText","text":text}]});
        let matched = |outcome: &str| {
            tool_reply(
                true,
                json!({
                    "idempotencyKey":request,
                    "outcome":outcome,
                    "usage":{"rateLimitResetCredits":{"availableCount":0}}
                })
                .to_string(),
            )
        };
        for (value, expected) in [
            ("reset", ResetOutcome::Reset),
            ("alreadyRedeemed", ResetOutcome::AlreadyRedeemed),
            ("noCredit", ResetOutcome::NoCredit),
            ("nothingToReset", ResetOutcome::NothingToReset),
        ] {
            let receipt = reset_result(&matched(value), request).unwrap();
            assert_eq!(receipt.outcome, expected);
            assert_eq!(
                receipt.usage.unwrap()["rateLimitResetCredits"]["availableCount"],
                0
            );
        }
        assert_eq!(
            reset_result(&matched("reset"), Uuid::new_v4()).unwrap_err(),
            ResetError::Uncertain
        );
        assert_eq!(
            reset_result(&matched("madeUp"), request).unwrap_err(),
            ResetError::Uncertain
        );
        let ineligible = tool_reply(
            false,
            json!({
                "idempotencyKey":request,
                "error":"More than 10% remains in every available core Codex usage window. This call did not attempt a reset."
            }).to_string(),
        );
        assert_eq!(
            reset_result(&ineligible, request).unwrap_err(),
            ResetError::WindowNotEligible
        );
        let ambiguous = tool_reply(
            false,
            json!({
                "idempotencyKey":request,
                "error":"Usage reset could not be confirmed. Retry this attempt only with the same idempotencyKey."
            }).to_string(),
        );
        assert_eq!(
            reset_result(&ambiguous, request).unwrap_err(),
            ResetError::Uncertain
        );
    }

    #[test]
    fn persists_only_the_confirmed_outcome_for_the_originating_device() -> anyhow::Result<()> {
        let state = tempfile::tempdir()?;
        let directory = state.path().join("state");
        let request = Uuid::new_v4();
        let backend = "codex-local";
        {
            let store = crate::state::Store::open(&directory)?;
            assert!(
                store
                    .usage_reset_receipt(backend, "one", request)?
                    .is_none()
            );
            store.record_usage_reset(
                backend,
                "one",
                request,
                &ResetResult {
                    outcome: ResetOutcome::Reset,
                    usage: Some(json!({"accountId":"private"})),
                },
            )?;
        }
        let store = crate::state::Store::open(&directory)?;
        let receipt = store.usage_reset_receipt(backend, "one", request)?.unwrap();
        assert_eq!(receipt.outcome, ResetOutcome::Reset);
        assert!(receipt.usage.is_none());
        assert!(
            store
                .usage_reset_receipt("different", "one", request)?
                .is_none()
        );
        let error = store
            .usage_reset_receipt(backend, "two", request)
            .unwrap_err();
        assert_eq!(error.downcast_ref(), Some(&ResetError::ConflictingRequest));
        Ok(())
    }
}
