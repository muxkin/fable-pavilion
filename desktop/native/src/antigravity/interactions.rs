use super::{pending_interaction, valid_id};
use crate::requests::Response;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

mod approvals;
mod questions;

const WAITING: &str = "CORTEX_STEP_STATUS_WAITING";

struct Target<'a> {
    trajectory_id: &'a str,
    step_index: u32,
    turn_id: &'a str,
}

impl<'a> Target<'a> {
    fn read(
        thread: Option<&str>,
        trajectory_id: Option<&'a str>,
        index: usize,
        step: &'a Value,
    ) -> Option<Self> {
        let trajectory_id = trajectory_id.filter(|id| valid_id(id).is_ok())?;
        let step_index = u32::try_from(index).ok()?;
        let source = &step["metadata"]["sourceTrajectoryStepInfo"];
        // A copied trajectory can contain steps from another conversation.
        if source["trajectoryId"]
            .as_str()
            .is_some_and(|source| source != trajectory_id)
            || source["cascadeId"]
                .as_str()
                .is_some_and(|source| thread != Some(source))
            || source["stepIndex"]
                .as_u64()
                .is_some_and(|source| source != u64::from(step_index))
        {
            return None;
        }
        let turn_id = bounded_text(&step["metadata"]["executionId"], 200)?;
        Some(Self {
            trajectory_id,
            step_index,
            turn_id,
        })
    }

    fn id(&self) -> String {
        format!("antigravity-{}", self.step_index)
    }
}

fn bounded_text(value: &Value, limit: usize) -> Option<&str> {
    value
        .as_str()
        .filter(|text| !text.trim().is_empty() && text.encode_utf16().count() <= limit)
}

pub(super) fn views(trajectory: &Value, read_only: bool) -> Vec<Value> {
    let Some(steps) = trajectory["steps"].as_array() else {
        return Vec::new();
    };
    views_slice(
        trajectory["cascadeId"].as_str(),
        trajectory["trajectoryId"].as_str(),
        0,
        steps,
        read_only,
    )
}

pub(super) fn views_slice(
    thread: Option<&str>,
    trajectory_id: Option<&str>,
    offset: usize,
    steps: &[Value],
    read_only: bool,
) -> Vec<Value> {
    steps
        .iter()
        .enumerate()
        .filter_map(|(rel, step)| {
            let index = offset + rel;
            if !pending_interaction(step) && questions::asked(step).is_none() {
                return None;
            }
            if let Some(target) = Target::read(thread, trajectory_id, index, step) {
                if let Some(question) = questions::QuestionBatch::read(step) {
                    return Some(question.view(&target, !read_only));
                }
                if let Some(approval) = approvals::CommandApproval::read(step, &target) {
                    return Some(approval.view(&target, !read_only));
                }
                if let Some(file_approval) = approvals::FileApproval::read(step, &target) {
                    return Some(file_approval.view(&target, !read_only));
                }
            }
            Some(json!({
                "id":format!("antigravity-{index}"),
                "kind":"unsupported",
                "title":"请在 Antigravity 本机处理请求",
                "description":"此请求尚未提供远程响应支持",
                "turnId":step["metadata"]["executionId"].as_str(),
                "actionable":false,
            }))
        })
        .collect()
}

pub(super) fn response(trajectory: &Value, answer: &Response) -> Result<Value> {
    let index = request_index(answer)?;
    let step = trajectory["steps"]
        .as_array()
        .and_then(|steps| steps.get(index))
        .context("Antigravity 请求已处理或过期")?;
    step_response(
        trajectory["cascadeId"].as_str().context("Antigravity 请求已变化")?,
        trajectory["trajectoryId"].as_str().context("Antigravity 请求已变化")?,
        index,
        step,
        answer,
    )
}

pub(super) fn step_response(
    thread: &str,
    trajectory: &str,
    index: usize,
    step: &Value,
    answer: &Response,
) -> Result<Value> {
    let target = Target::read(Some(thread), Some(trajectory), index, step)
        .context("Antigravity 请求已变化")?;
    if let Some(question) = questions::QuestionBatch::read(step) {
        return reply_to_question(&question, &target, answer);
    }
    if let Some(approval) = approvals::CommandApproval::read(step, &target) {
        verify(&approval.view(&target, true), answer)?;
        return approval.reply(&target, answer);
    }
    let approval =
        approvals::FileApproval::read(step, &target).context("Antigravity 请求已处理或过期")?;
    verify(&approval.view(&target, true), answer)?;
    approval.reply(&target, answer)
}

pub(super) fn request_index(answer: &Response) -> Result<usize> {
    answer.validate()?;
    answer
        .target_request_id
        .strip_prefix("antigravity-")
        .and_then(|index| index.parse::<usize>().ok())
        .context("Antigravity 请求标识无效")
}

pub(super) fn question_recorded(
    thread: &str,
    trajectory: &str,
    index: usize,
    step: &Value,
    sent: &Value,
    answer: &Response,
) -> bool {
    if step["type"] != questions::ASK_QUESTION {
        return false;
    }
    let Some(target) = Target::read(Some(thread), Some(trajectory), index, step) else {
        return false;
    };
    let mut recorded = step["completedInteractions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["response"]["askQuestion"].is_object());
    let (Some(entry), None) = (recorded.next(), recorded.next()) else {
        return false;
    };
    let response = &entry["response"];
    let same_step = response["stepIndex"].as_u64().or_else(|| {
        // Protobuf JSON may omit a zero step index.
        response["stepIndex"].is_null().then_some(0)
    }) == Some(u64::from(target.step_index));
    same_step
        && response["trajectoryId"] == target.trajectory_id
        && questions::QuestionBatch::from_request(&entry["request"]["askQuestion"])
            .is_some_and(|request| verify(&request.view(&target, true), answer).is_ok())
        && questions::replies_match(
            &sent["askQuestion"]["responses"],
            &response["askQuestion"]["responses"],
        )
}

fn reply_to_question(
    question: &questions::QuestionBatch<'_>,
    target: &Target<'_>,
    answer: &Response,
) -> Result<Value> {
    let shown = question.view(target, true);
    verify(&shown, answer)?;
    let responses = question.reply(&shown, answer)?;
    Ok(
        json!({"trajectoryId":target.trajectory_id,"stepIndex":target.step_index,"askQuestion":{"responses":responses}}),
    )
}

fn verify(shown: &Value, answer: &Response) -> Result<()> {
    ensure!(
        shown["id"] == answer.target_request_id
            && shown["turnId"] == answer.expected_turn_id
            && shown["fingerprint"] == answer.expected_fingerprint,
        "Antigravity 请求内容已变化，请重新核对"
    );
    Ok(())
}
