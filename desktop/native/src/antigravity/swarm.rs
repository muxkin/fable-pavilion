use super::{Backend, steps::messages as project_steps, valid_id};
use anyhow::{Context, Result, ensure};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::OnceLock,
};

const MAX_BOARD_BYTES: u64 = 2 * 1024 * 1024;
const MAX_BOARD_MESSAGES: usize = 300;
const MAX_META_BYTES: u64 = 256 * 1024;
const MAX_TRANSCRIPT_TAIL_BYTES: u64 = 512 * 1024;
const MAX_MEMBER_MESSAGES: usize = 200;

fn swarm_dir(home: &Path, thread: &str) -> PathBuf {
    home.join("brain")
        .join(thread)
        .join(".system_generated")
        .join("swarm")
}

pub(super) fn has_swarm(home: &Path, thread: &str) -> bool {
    if valid_id(thread).is_err() {
        return false;
    }
    let dir = swarm_dir(home, thread);
    dir.join("members.json").is_file() || dir.join("board.jsonl").is_file()
}

fn read_bounded_utf8(path: &Path, max_bytes: u64) -> Option<String> {
    let file = File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > max_bytes {
        return None;
    }
    let mut buf = String::new();
    file.take(max_bytes + 1).read_to_string(&mut buf).ok()?;
    if buf.len() as u64 > max_bytes {
        return None;
    }
    Some(buf)
}

fn read_tail_utf8(path: &Path, max_bytes: u64) -> Option<(String, bool)> {
    let mut file = File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let len = meta.len();
    let truncated = len > max_bytes;
    if truncated {
        file.seek(SeekFrom::Start(len - max_bytes)).ok()?;
    }
    let mut raw = Vec::new();
    file.take(max_bytes + 1).read_to_end(&mut raw).ok()?;
    let mut text = String::from_utf8_lossy(&raw).into_owned();
    if truncated
        && let Some(pos) = text.find('\n')
    {
        text.drain(..=pos);
    }
    Some((text, truncated))
}

fn read_json_file(path: &Path, max_bytes: u64) -> Option<Value> {
    let text = read_bounded_utf8(path, max_bytes)?;
    serde_json::from_str(&text).ok()
}

fn valid_member_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn extract_mentions(text: &str) -> (Vec<String>, bool) {
    static MENTION: OnceLock<Regex> = OnceLock::new();
    let regex = MENTION.get_or_init(|| {
        Regex::new(r"(?:^|[^a-zA-Z0-9_@.-])@([a-zA-Z0-9][a-zA-Z0-9_-]{0,31})").unwrap()
    });
    let mut seen = HashSet::new();
    let mut mentions = Vec::new();
    let mut all = false;
    for cap in regex.captures_iter(text) {
        let target = cap[1].to_ascii_lowercase();
        if target == "all" {
            all = true;
        } else if seen.insert(target.clone()) {
            mentions.push(target);
        }
    }
    (mentions, all)
}

#[derive(Default)]
struct TranscriptSummary {
    steps: usize,
    stopped: Option<bool>,
    activity: Option<String>,
    failed: bool,
    last_activity_at: Option<String>,
}

fn summarize_transcript(home: &Path, conversation_id: &str) -> TranscriptSummary {
    let path = home
        .join("brain")
        .join(conversation_id)
        .join(".system_generated")
        .join("logs")
        .join("transcript.jsonl");
    let Some((text, _)) = read_tail_utf8(&path, MAX_TRANSCRIPT_TAIL_BYTES) else {
        return TranscriptSummary::default();
    };
    let entries: Vec<Value> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect();
    if entries.is_empty() {
        return TranscriptSummary::default();
    }
    let last = entries.last().unwrap();
    let steps = last["step_index"]
        .as_u64()
        .map(|i| i as usize + 1)
        .unwrap_or(entries.len());
    let last_activity_at = last["created_at"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let last_type = last["type"].as_str().unwrap_or_default();
    let last_status = last["status"].as_str().unwrap_or_default();
    let failed = last_type == "ERROR_MESSAGE" || last_status == "ERROR";

    // Determine whether the member's turn has stopped (matching swarm_board README).
    let mut stopped = None;
    let mut activity = None;
    if last_type == "PLANNER_RESPONSE" {
        let calls = last["tool_calls"].as_array();
        if last_status == "DONE" && calls.is_none_or(|c| c.is_empty()) {
            stopped = Some(true);
        } else if let Some(calls) = calls
            && !calls.is_empty()
        {
            stopped = Some(false);
            if let Some(last_call) = calls.last()
                && let Some(name) = last_call["name"].as_str()
            {
                activity = Some(format_tool_activity(name));
            }
        }
    } else if last_type == "GENERIC" {
        // Check if this step belongs to a tool batch containing swarm_wait with DONE status.
        if let Some(planner) = entries
            .iter()
            .rev()
            .find(|e| e["type"].as_str() == Some("PLANNER_RESPONSE"))
        {
            let calls = planner["tool_calls"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default();
            let has_swarm_wait = calls
                .iter()
                .any(|c| c["name"].as_str() == Some("swarm_wait"));
            let content = last["content"].as_str().unwrap_or_default();
            if has_swarm_wait
                && last_status == "DONE"
                && (content.contains("Waiting for a message") || content.contains("swarm_wait"))
            {
                stopped = Some(true);
            } else if last_status == "RUNNING" {
                stopped = Some(false);
                if let Some(name) = calls.last().and_then(|c| c["name"].as_str()) {
                    activity = Some(format_tool_activity(name));
                }
            }
        }
    } else if last_type == "SYSTEM_MESSAGE" {
        stopped = Some(false);
        activity = Some("正在响应新消息".to_owned());
    }

    if failed && activity.is_none() {
        activity = Some("最近一步执行出错".to_owned());
    } else if stopped == Some(false) && activity.is_none() {
        // Look back at the most recent planner step for a short activity hint.
        if let Some(planner) = entries
            .iter()
            .rev()
            .find(|e| e["type"].as_str() == Some("PLANNER_RESPONSE"))
        {
            if let Some(name) = planner["tool_calls"]
                .as_array()
                .and_then(|c| c.last())
                .and_then(|c| c["name"].as_str())
            {
                activity = Some(format_tool_activity(name));
            } else {
                activity = Some("正在思考".to_owned());
            }
        }
    }

    TranscriptSummary {
        steps,
        stopped,
        activity,
        failed,
        last_activity_at,
    }
}

fn format_tool_activity(name: &str) -> String {
    match name {
        "read_file" | "view_file" => "读取文件".to_owned(),
        "write_file" | "edit_file" | "replace_file_content" | "multi_replace_file_content" => {
            "编辑文件".to_owned()
        }
        "run_command" => "执行命令".to_owned(),
        "search_web" => "搜索网页".to_owned(),
        "read_board" => "读取公告板".to_owned(),
        "post_message" => "发布公告板消息".to_owned(),
        "swarm_wait" => "等待公告板消息".to_owned(),
        "swarm" => "管理 Swarm 成员".to_owned(),
        "invoke_subagent" => "调用子 Agent".to_owned(),
        other => format!("调用 {other}"),
    }
}

pub(super) fn board_cited_paths(home: &Path, thread: &str) -> Vec<String> {
    if valid_id(thread).is_err() {
        return Vec::new();
    }
    let board_path = swarm_dir(home, thread).join("board.jsonl");
    let Some((text, _)) = read_tail_utf8(&board_path, MAX_BOARD_BYTES) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<Value>(trimmed)
            && let Some(body) = entry["text"].as_str()
        {
            out.extend(crate::history_media::links(body));
            // Also pick up backtick-quoted absolute paths commonly posted on Swarm boards.
            for segment in body.split('`').skip(1).step_by(2) {
                let candidate = segment.trim();
                if (candidate.starts_with('/') && !candidate.starts_with("//"))
                    || candidate.starts_with("file:///")
                {
                    out.push(candidate.to_owned());
                }
            }
        }
    }
    out
}

pub(super) fn read_swarm_sync(home: &Path, thread: &str) -> Result<Value> {
    valid_id(thread)?;
    let dir = swarm_dir(home, thread);
    let members_doc = read_json_file(&dir.join("members.json"), MAX_META_BYTES);
    let board_raw = read_tail_utf8(&dir.join("board.jsonl"), MAX_BOARD_BYTES);
    if members_doc.is_none() && board_raw.is_none() {
        return Ok(json!({"swarm": Value::Null}));
    }

    let swarm_meta = read_json_file(&dir.join("swarm.json"), MAX_META_BYTES);
    let plan_doc = read_json_file(&dir.join("plan.json"), MAX_META_BYTES);
    let view_doc = read_json_file(&dir.join("view.json"), 128 * 1024);

    let mut all_messages = Vec::new();
    let mut board_truncated = false;
    let mut head: u64 = 0;
    let mut posts_by_agent: HashMap<String, (usize, u64, String)> = HashMap::new();
    if let Some((text, truncated)) = board_raw {
        board_truncated = truncated;
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(item) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            let seq = item["seq"].as_u64().unwrap_or(0);
            let agent = item["agent"].as_str().unwrap_or("unknown").to_owned();
            let body = item["text"].as_str().unwrap_or("").to_owned();
            let time = item["time"].as_str().unwrap_or("").to_owned();
            let kind = item["kind"]
                .as_str()
                .filter(|k| !k.is_empty())
                .map(str::to_owned);
            if seq > head {
                head = seq;
            }
            let entry = posts_by_agent
                .entry(agent.to_ascii_lowercase())
                .or_insert((0, 0, String::new()));
            entry.0 += 1;
            if seq >= entry.1 {
                entry.1 = seq;
                entry.2 = time.clone();
            }
            let (mentions, all) = extract_mentions(&body);
            all_messages.push(json!({
                "seq": seq,
                "agent": agent,
                "text": body,
                "time": time,
                "kind": kind,
                "mentions": mentions,
                "all": all,
            }));
        }
    }
    if all_messages.len() > MAX_BOARD_MESSAGES {
        board_truncated = true;
        let drain_count = all_messages.len() - MAX_BOARD_MESSAGES;
        all_messages.drain(..drain_count);
    }

    let plan_tasks = plan_doc
        .as_ref()
        .and_then(|p| p["tasks"].as_object());

    let mut members = Vec::new();
    let mut working = 0usize;
    let mut waiting = 0usize;
    let mut killed_count = 0usize;
    if let Some(map) = members_doc
        .as_ref()
        .and_then(|doc| doc["members"].as_object())
    {
        for (name, info) in map {
            let conv_id = info["conversation_id"].as_str().unwrap_or("");
            let has_conv = valid_id(conv_id).is_ok();
            let killed = info["killed"] == true
                || info["phase"].as_str() == Some("KILLED")
                || info["desired_state"].as_str() == Some("KILLED");
            let role = info["role"].as_str().unwrap_or("worker");
            let model = info["applied_model"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| info["model"].as_str().filter(|s| !s.is_empty()))
                .or_else(|| info["desired_model"].as_str().filter(|s| !s.is_empty()))
                .unwrap_or("");
            let wake_mode = info["wake_mode"].as_str().unwrap_or("");
            let workspace_mode = info["workspace_mode"].as_str().unwrap_or("inherit");
            let last_read_seq = info["last_read_seq"].as_u64().unwrap_or(0);
            let unread = head.saturating_sub(last_read_seq);
            let transcript = if has_conv {
                summarize_transcript(home, conv_id)
            } else {
                TranscriptSummary::default()
            };
            let status = if killed {
                killed_count += 1;
                "killed"
            } else if transcript.stopped == Some(true)
                || (transcript.stopped.is_none()
                    && matches!(wake_mode, "mentions" | "any" | "waiting"))
            {
                waiting += 1;
                "waiting"
            } else {
                working += 1;
                "working"
            };
            let (posts, last_post_seq, last_post_time) = posts_by_agent
                .get(&name.to_ascii_lowercase())
                .cloned()
                .unwrap_or((0, 0, String::new()));
            let task = plan_tasks
                .and_then(|tasks| tasks.get(name))
                .and_then(Value::as_str)
                .map(str::to_owned);
            members.push(json!({
                "name": name,
                "role": role,
                "model": model,
                "workspaceMode": workspace_mode,
                "wakeMode": wake_mode,
                "status": status,
                "killed": killed,
                "posts": posts,
                "unread": unread,
                "steps": transcript.steps,
                "activity": if status == "working" || transcript.failed { transcript.activity } else { None },
                "failed": transcript.failed,
                "lastPostSeq": if last_post_seq > 0 { Some(last_post_seq) } else { None },
                "lastPostTime": if !last_post_time.is_empty() { Some(last_post_time) } else { None },
                "lastActivityAt": transcript.last_activity_at,
                "task": task,
                "hasConversation": has_conv,
            }));
        }
    }

    // Sort: working -> waiting -> killed; coordinator first, then alphabetical.
    members.sort_by(|a, b| {
        let rank = |v: &Value| match v["status"].as_str() {
            Some("working") => 0,
            Some("waiting") => 1,
            _ => 2,
        };
        let role_rank = |v: &Value| if v["role"] == "coordinator" { 0 } else { 1 };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| role_rank(a).cmp(&role_rank(b)))
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });

    let title = members_doc
        .as_ref()
        .and_then(|d| d["title"].as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            plan_doc
                .as_ref()
                .and_then(|p| p["goal"]["title"].as_str())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("Swarm 协作面板")
        .to_owned();

    let sanitized_plan = plan_doc.map(|p| {
        let goal = p.get("goal").and_then(Value::as_object).map(|g| {
            json!({
                "title": g.get("title").and_then(Value::as_str).unwrap_or(""),
                "line": g.get("line").and_then(Value::as_str).unwrap_or(""),
            })
        });
        let threads: Vec<Value> = p["threads"]
            .as_array()
            .into_iter()
            .flatten()
            .take(16)
            .map(|t| {
                json!({
                    "id": t["id"].as_str().unwrap_or(""),
                    "title": t["title"].as_str().unwrap_or(""),
                    "goal": t["goal"].as_str().unwrap_or(""),
                    "tasks": t["tasks"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>(),
                })
            })
            .collect();
        let tasks: BTreeMap<String, String> = p["tasks"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
            .collect();
        json!({
            "goal": goal,
            "tasks": tasks,
            "threads": threads,
        })
    });

    let sanitized_overview = view_doc.map(|v| {
        json!({
            "headline": v["headline"].as_str().unwrap_or(""),
            "asOfSeq": v["as_of_seq"].as_u64(),
            "updatedAt": v["updated_at"].as_str(),
            "phase": v.get("phase").filter(|p| p.is_object()),
            "attention": v["attention"].as_array().cloned().unwrap_or_default().into_iter().take(24).collect::<Vec<_>>(),
            "workstreams": v["workstreams"].as_array().cloned().unwrap_or_default().into_iter().take(24).collect::<Vec<_>>(),
            "milestones": v["milestones"].as_array().cloned().unwrap_or_default().into_iter().take(24).collect::<Vec<_>>(),
            "risks": v["risks"].as_array().cloned().unwrap_or_default().into_iter().take(24).collect::<Vec<_>>(),
        })
    });

    Ok(json!({
        "swarm": {
            "id": thread,
            "title": title,
            "createdAt": swarm_meta.as_ref().and_then(|m| m["created_at"].as_str()),
            "head": head,
            "truncated": board_truncated,
            "counts": {
                "working": working,
                "waiting": waiting,
                "killed": killed_count,
                "total": members.len(),
            },
            "plan": sanitized_plan,
            "overview": sanitized_overview,
            "members": members,
            "messages": all_messages,
        }
    }))
}

pub(super) async fn read_swarm(backend: &Backend, thread: &str) -> Result<Value> {
    valid_id(thread)?;
    let home = backend.home.clone();
    let thread = thread.to_owned();
    tokio::task::spawn_blocking(move || read_swarm_sync(&home, &thread)).await?
}

fn strip_system_message_wrapper(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let inner = if let Some((_, rest)) = trimmed.split_once("<SYSTEM_MESSAGE>") {
        rest.split_once("</SYSTEM_MESSAGE>")
            .map(|(body, _)| body.trim())
            .unwrap_or(rest.trim())
    } else {
        trimmed
    };
    let content = if let Some((_, after)) = inner.split_once("content=") {
        after.trim()
    } else {
        inner
    };
    // Skip noisy 1-line swarm wakeup ping notifications when they carry no real brief.
    if content.starts_with("[swarm] new board message #") && !content.contains('\n') {
        return None;
    }
    if content.starts_with("[board] the latest message is #") && !content.contains('\n') {
        return None;
    }
    if content.is_empty() {
        return None;
    }
    Some(content.to_owned())
}

fn parse_tool_arg_str(args: &Value, key: &str) -> Option<String> {
    let raw = args.get(key)?.as_str()?;
    // Transcript tool args are sometimes JSON-encoded strings (wrapped in quotes).
    if raw.starts_with('"')
        && raw.ends_with('"')
        && let Ok(decoded) = serde_json::from_str::<String>(raw)
    {
        return Some(decoded);
    }
    Some(raw.to_owned())
}

pub(super) fn project_worker_daemon_steps(steps: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for (idx, step) in steps.iter().enumerate() {
        let id = format!("swarm-step-{idx}");
        let turn = &step["metadata"]["executionId"];
        let created_at = step["metadata"]["createdAt"]
            .as_str()
            .or(step["createdAt"].as_str())
            .map(crate::state::rfc3339_ms)
            .filter(|&ts| ts > 0);
        let kind = step["type"].as_str().unwrap_or("");
        if let Some(sys) = step.get("systemMessage") {
            let text = sys["message"]
                .as_str()
                .or(sys["text"].as_str())
                .or(sys["content"].as_str())
                .unwrap_or("");
            if let Some(clean) = strip_system_message_wrapper(text) {
                let mut msg = json!({
                    "id": id,
                    "role": "user",
                    "text": clean,
                    "turnId": turn,
                });
                if let Some(ts) = created_at {
                    msg["createdAt"] = json!(ts);
                }
                out.push(msg);
            }
            continue;
        }
        if let Some(response) = step.get("plannerResponse") {
            let text = response["modifiedResponse"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or(response["response"].as_str())
                .unwrap_or("");
            if !text.is_empty() {
                let mut msg = json!({
                    "id": id,
                    "role": "assistant",
                    "text": text,
                    "turnId": turn,
                });
                if let Some(ts) = created_at {
                    msg["createdAt"] = json!(ts);
                }
                out.push(msg);
                continue;
            }
            // Swarm workers usually communicate via `post_message` tool calls rather than final response text.
            if let Some(calls) = response["toolCalls"].as_array() {
                for (call_idx, call) in calls.iter().enumerate() {
                    if call["name"].as_str() == Some("post_message") {
                        let args: Value = call["argumentsJson"]
                            .as_str()
                            .and_then(|s| serde_json::from_str(s).ok())
                            .unwrap_or_else(|| call["args"].clone());
                        if let Some(posted) = args["text"].as_str().filter(|s| !s.is_empty()) {
                            let mut msg = json!({
                                "id": format!("swarm-post-{idx}-{call_idx}"),
                                "role": "assistant",
                                "text": posted,
                                "turnId": turn,
                            });
                            if let Some(ts) = created_at {
                                msg["createdAt"] = json!(ts);
                            }
                            out.push(msg);
                        }
                    }
                }
            }
            continue;
        }
        if kind == "CORTEX_STEP_TYPE_GENERIC" {
            let tool_name = step["metadata"]["toolCall"]["name"]
                .as_str()
                .or(step["generic"]["toolName"].as_str())
                .unwrap_or("");
            let label = match tool_name {
                "post_message" => "已发布到公告板",
                "read_board" => "读取公告板消息",
                "swarm_wait" => "等待公告板新消息",
                "" => "执行工具",
                other => other,
            };
            let mut msg = json!({
                "id": id,
                "role": "tool",
                "text": label,
                "turnId": turn,
                "toolActions": ["call-tool"],
            });
            if let Some(ts) = created_at {
                msg["createdAt"] = json!(ts);
            }
            out.push(msg);
            continue;
        }
        // Delegate standard userInput / viewFile / writeToFile / runCommand steps to shared projection.
        out.extend(project_steps(std::slice::from_ref(step), idx, false));
    }
    if out.len() > MAX_MEMBER_MESSAGES {
        let drop = out.len() - MAX_MEMBER_MESSAGES;
        out.drain(..drop);
    }
    out
}

pub(super) fn project_worker_transcript_jsonl(home: &Path, conversation_id: &str) -> Vec<Value> {
    let path = home
        .join("brain")
        .join(conversation_id)
        .join(".system_generated")
        .join("logs")
        .join("transcript.jsonl");
    let Some((text, _)) = read_tail_utf8(&path, MAX_BOARD_BYTES) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (idx, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let step_idx = entry["step_index"].as_u64().unwrap_or(idx as u64);
        let created_at = entry["created_at"]
            .as_str()
            .map(crate::state::rfc3339_ms)
            .filter(|&ts| ts > 0);
        let kind = entry["type"].as_str().unwrap_or("");
        match kind {
            "SYSTEM_MESSAGE" | "USER_INPUT" => {
                if let Some(raw) = entry["content"].as_str()
                    && let Some(clean) = strip_system_message_wrapper(raw)
                {
                    let mut msg = json!({
                        "id": format!("swarm-tx-{step_idx}"),
                        "role": "user",
                        "text": clean,
                    });
                    if let Some(ts) = created_at {
                        msg["createdAt"] = json!(ts);
                    }
                    out.push(msg);
                }
            }
            "PLANNER_RESPONSE" => {
                if let Some(content) = entry["content"].as_str().filter(|s| !s.is_empty()) {
                    let mut msg = json!({
                        "id": format!("swarm-tx-{step_idx}"),
                        "role": "assistant",
                        "text": content,
                    });
                    if let Some(ts) = created_at {
                        msg["createdAt"] = json!(ts);
                    }
                    out.push(msg);
                }
                if let Some(calls) = entry["tool_calls"].as_array() {
                    for (call_idx, call) in calls.iter().enumerate() {
                        let name = call["name"].as_str().unwrap_or("tool");
                        let args = &call["args"];
                        if name == "post_message"
                            && let Some(posted) = parse_tool_arg_str(args, "text")
                        {
                            let mut msg = json!({
                                "id": format!("swarm-tx-post-{step_idx}-{call_idx}"),
                                "role": "assistant",
                                "text": posted,
                            });
                            if let Some(ts) = created_at {
                                msg["createdAt"] = json!(ts);
                            }
                            out.push(msg);
                        } else {
                            let target = parse_tool_arg_str(args, "Path")
                                .or_else(|| parse_tool_arg_str(args, "CommandLine"))
                                .or_else(|| parse_tool_arg_str(args, "query"));
                            let label = match target {
                                Some(t) => {
                                    let short = Path::new(&t)
                                        .file_name()
                                        .and_then(|n| n.to_str())
                                        .filter(|n| !n.is_empty())
                                        .unwrap_or(&t);
                                    format!("{} · {short}", format_tool_activity(name))
                                }
                                None => format_tool_activity(name),
                            };
                            let mut msg = json!({
                                "id": format!("swarm-tx-tool-{step_idx}-{call_idx}"),
                                "role": "tool",
                                "text": label,
                                "toolActions": ["call-tool"],
                            });
                            if let Some(ts) = created_at {
                                msg["createdAt"] = json!(ts);
                            }
                            out.push(msg);
                        }
                    }
                }
            }
            "ERROR_MESSAGE" => {
                let err = entry["content"].as_str().unwrap_or("执行出错");
                let mut msg = json!({
                    "id": format!("swarm-tx-{step_idx}"),
                    "role": "tool",
                    "text": format!("错误 · {err}"),
                });
                if let Some(ts) = created_at {
                    msg["createdAt"] = json!(ts);
                }
                out.push(msg);
            }
            _ => {}
        }
    }
    if out.len() > MAX_MEMBER_MESSAGES {
        let drop = out.len() - MAX_MEMBER_MESSAGES;
        out.drain(..drop);
    }
    out
}

pub(super) async fn read_member(
    backend: &Backend,
    thread: &str,
    member_name: &str,
) -> Result<Value> {
    valid_id(thread)?;
    ensure!(valid_member_name(member_name), "Swarm 成员名无效");
    let home = backend.home.clone();
    let thread_owned = thread.to_owned();
    let member_owned = member_name.to_owned();
    let (member_meta, conv_id) = tokio::task::spawn_blocking(move || -> Result<(Value, String)> {
        let dir = swarm_dir(&home, &thread_owned);
        let members_doc =
            read_json_file(&dir.join("members.json"), MAX_META_BYTES).context("当前会话没有 Swarm")?;
        let plan_doc = read_json_file(&dir.join("plan.json"), MAX_META_BYTES);
        let info = members_doc["members"]
            .get(&member_owned)
            .context("未找到该 Swarm 成员")?;
        let conv_id = info["conversation_id"]
            .as_str()
            .context("该成员暂无独立会话")?;
        valid_id(conv_id)?;
        let role = info["role"].as_str().unwrap_or("worker");
        let model = info["applied_model"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| info["model"].as_str().filter(|s| !s.is_empty()))
            .or_else(|| info["desired_model"].as_str().filter(|s| !s.is_empty()))
            .unwrap_or("");
        let killed = info["killed"] == true
            || info["phase"].as_str() == Some("KILLED")
            || info["desired_state"].as_str() == Some("KILLED");
        let wake_mode = info["wake_mode"].as_str().unwrap_or("");
        let transcript = summarize_transcript(&home, conv_id);
        let status = if killed {
            "killed"
        } else if transcript.stopped == Some(true)
            || (transcript.stopped.is_none() && matches!(wake_mode, "mentions" | "any" | "waiting"))
        {
            "waiting"
        } else {
            "working"
        };
        let task = plan_doc
            .as_ref()
            .and_then(|p| p["tasks"].get(&member_owned))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let meta = json!({
            "name": member_owned,
            "role": role,
            "model": model,
            "status": status,
            "steps": transcript.steps,
            "activity": transcript.activity,
            "failed": transcript.failed,
            "task": task,
        });
        Ok((meta, conv_id.to_owned()))
    })
    .await??;

    let is_coordinator = member_meta["role"] == "coordinator" || conv_id == thread;
    let mut runtime_status = "unknown".to_owned();
    let mut messages = Vec::new();
    let mut source = "transcript";

    if let Ok(daemon) = backend.daemon().await
        && let Ok(Some(data)) = backend.readable_trajectory(&daemon, &conv_id).await
    {
        runtime_status = match data["status"].as_str() {
            Some(
                "CASCADE_RUN_STATUS_RUNNING"
                | "CASCADE_RUN_STATUS_BUSY"
                | "CASCADE_RUN_STATUS_CANCELING",
            ) => "running".to_owned(),
            Some("CASCADE_RUN_STATUS_IDLE") => "idle".to_owned(),
            _ => "unknown".to_owned(),
        };
        if let Some(steps) = data["trajectory"]["steps"].as_array() {
            messages = if is_coordinator {
                let mut projected = project_steps(steps, 0, false);
                if projected.len() > MAX_MEMBER_MESSAGES {
                    let drop = projected.len() - MAX_MEMBER_MESSAGES;
                    projected.drain(..drop);
                }
                projected
            } else {
                project_worker_daemon_steps(steps)
            };
            source = "daemon";
        }
    }

    if messages.is_empty() {
        let home = backend.home.clone();
        let conv_clone = conv_id.clone();
        messages =
            tokio::task::spawn_blocking(move || project_worker_transcript_jsonl(&home, &conv_clone))
                .await?;
        source = "transcript";
    }

    // Never expose raw local filesystem paths from internal swarm directory structure beyond safe messages.
    let _ = fs::metadata(swarm_dir(&backend.home, thread));
    Ok(json!({
        "member": member_meta,
        "runtimeStatus": runtime_status,
        "source": source,
        "messages": messages,
    }))
}
