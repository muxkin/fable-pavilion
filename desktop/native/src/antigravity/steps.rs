use super::media;
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path};

fn short_name(path: &str) -> &str {
    let trimmed = path.strip_prefix("file://").unwrap_or(path);
    Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(trimmed)
}

fn step_path<'a>(step: &'a Value, keys: &[(&str, &str)]) -> Option<&'a str> {
    for (section, field) in keys {
        if let Some(value) = step[*section][*field]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(value);
        }
    }
    None
}

fn step_status_label(status: &Value) -> Option<&'static str> {
    match status.as_str()? {
        "CORTEX_STEP_STATUS_RUNNING" | "CORTEX_STEP_STATUS_GENERATING" => Some("running"),
        "CORTEX_STEP_STATUS_WAITING" => Some("waiting"),
        "CORTEX_STEP_STATUS_DONE" => Some("completed"),
        "CORTEX_STEP_STATUS_ERROR" => Some("failed"),
        "CORTEX_STEP_STATUS_CANCELED" | "CORTEX_STEP_STATUS_INTERRUPTED" => Some("interrupted"),
        _ => None,
    }
}

fn format_edit_changes(path: &str, kind: &str, diff: &str) -> Value {
    json!([{
        "path": path,
        "kind": kind,
        "diff": diff,
    }])
}

fn build_replace_diff(step: &Value, section: &str) -> String {
    let body = &step[section];
    if let Some(chunks) = body["replacementChunks"].as_array() {
        let mut lines = Vec::new();
        for chunk in chunks.iter().take(12) {
            if let Some(target) = chunk["targetContent"].as_str() {
                for line in target.lines().take(24) {
                    lines.push(format!("-{line}"));
                }
            }
            if let Some(replacement) = chunk["replacementContent"].as_str() {
                for line in replacement.lines().take(24) {
                    lines.push(format!("+{line}"));
                }
            }
        }
        if !lines.is_empty() {
            return lines.join("\n");
        }
    }
    let mut lines = Vec::new();
    if let Some(target) = body["targetContent"].as_str() {
        for line in target.lines().take(32) {
            lines.push(format!("-{line}"));
        }
    }
    if let Some(replacement) = body["replacementContent"].as_str() {
        for line in replacement.lines().take(32) {
            lines.push(format!("+{line}"));
        }
    }
    lines.join("\n")
}

pub(super) fn activity_state(steps: &[Value], active: bool) -> Option<&'static str> {
    if !active {
        return None;
    }
    let last = steps.last()?;
    if last.get("plannerResponse").is_some() {
        let has_text = last["plannerResponse"]["modifiedResponse"]
            .as_str()
            .or(last["plannerResponse"]["response"].as_str())
            .is_some_and(|text| !text.is_empty());
        return Some(if has_text { "responding" } else { "thinking" });
    }
    if last.get("userInput").is_some() {
        return Some("thinking");
    }
    Some("tool")
}

pub(super) fn messages(steps: &[Value], offset: usize, full: bool) -> Vec<Value> {
    let mut messages = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let index = index + offset;
        let id = format!("antigravity-step-{index}");
        let turn = &step["metadata"]["executionId"];
        let created_at = step["metadata"]["createdAt"]
            .as_str()
            .or(step["createdAt"].as_str())
            .map(crate::state::rfc3339_ms)
            .filter(|&ts| ts > 0);
        if let Some(user) = step.get("userInput") {
            let text = user["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|i| i["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let text = if text.is_empty() {
                user["userResponse"].as_str().unwrap_or("").to_owned()
            } else {
                text
            };
            let (text, file_attachments) = crate::files::message_attachment_text(&text);
            let mut message = json!({
                "id": id,
                "role": "user",
                "text": text,
                "turnId": turn,
                "clientMessageId": user["clientMessageId"],
            });
            if let Some(ts) = created_at {
                message["createdAt"] = json!(ts);
            }
            let mut attachments = media::attachments(user, index);
            attachments.extend(file_attachments);
            if !attachments.is_empty() {
                message["attachments"] = json!(attachments);
            }
            messages.push(message);
        } else if let Some(response) = step.get("plannerResponse") {
            let text = response["modifiedResponse"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or(response["response"].as_str())
                .unwrap_or("");
            if !text.is_empty() {
                let mut message =
                    json!({"id": id, "role": "assistant", "text": text, "turnId": turn});
                if let Some(ts) = created_at {
                    message["createdAt"] = json!(ts);
                }
                messages.push(message);
            }
        } else {
            let mut message = project_tool_step(step, &id, turn);
            if let Some(ts) = created_at {
                message["createdAt"] = json!(ts);
            }
            messages.push(message);
        }
    }
    let mut last_assistant_by_turn: HashMap<String, usize> = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        if message["role"] == "assistant"
            && message["text"].as_str().is_some_and(|t| !t.is_empty())
        {
            let key = message["turnId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("msg-{index}"));
            last_assistant_by_turn.insert(key, index);
        }
    }
    for index in last_assistant_by_turn.into_values() {
        messages[index]["turnBoundary"] = json!(true);
    }
    for message in &mut messages {
        bound_message(message, if full { 512 * 1024 } else { 12_000 });
    }
    messages
}

fn project_tool_step(step: &Value, id: &str, turn: &Value) -> Value {
    let kind = step["type"]
        .as_str()
        .unwrap_or("CORTEX_STEP_TYPE_UNKNOWN")
        .trim_start_matches("CORTEX_STEP_TYPE_");
    let status = step_status_label(&step["status"]);
    let mut message = json!({
        "id": id,
        "role": "tool",
        "text": "",
        "turnId": turn,
        "phase": step["status"],
    });
    match kind {
        "RUN_COMMAND" => {
            let cmd = step["runCommand"]["commandLine"]
                .as_str()
                .or(step["runCommand"]["proposedCommandLine"].as_str())
                .unwrap_or("运行命令");
            message["text"] = json!(match status {
                Some(state) => format!("命令 · {cmd} · {state}"),
                None => cmd.to_owned(),
            });
            message["toolActions"] = json!(["run-command"]);
            let mut detail_lines = Vec::new();
            if let Some(cwd) = step["runCommand"]["cwd"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                detail_lines.push(format!("工作目录：{cwd}"));
            }
            if let Some(exit) = step["runCommand"]["exitCode"].as_i64() {
                detail_lines.push(format!("退出码：{exit}"));
            }
            if !detail_lines.is_empty() {
                message["details"] = json!(detail_lines.join("\n"));
            }
            if let Some(output) = step["runCommand"]["combinedOutput"]["full"].as_str() {
                message["output"] = json!(output);
            }
        }
        "VIEW_FILE" | "VIEW_FILE_OUTLINE" | "VIEW_CODE_ITEM" => {
            let path = step_path(
                step,
                &[
                    ("viewFile", "absolutePathUri"),
                    ("viewFile", "absolutePath"),
                    ("viewFileOutline", "absolutePathUri"),
                    ("viewFileOutline", "absolutePath"),
                    ("viewCodeItem", "file"),
                ],
            )
            .unwrap_or("文件");
            message["text"] = json!(format!("读取 {}", short_name(path)));
            message["toolActions"] = json!(["read-file"]);
            if path != "文件" {
                message["details"] = json!(path);
            }
        }
        "LIST_DIR" | "FIND_BY_NAME" => {
            let target = step_path(
                step,
                &[
                    ("listDir", "directoryPath"),
                    ("listDir", "directoryPathUri"),
                    ("findByName", "searchDirectory"),
                    ("findByName", "pattern"),
                ],
            )
            .unwrap_or("目录");
            message["text"] = json!(format!("查找文件 · {}", short_name(target)));
            message["toolActions"] = json!(["list-files"]);
            if target != "目录" {
                message["details"] = json!(target);
            }
        }
        "GREP_SEARCH" => {
            let query = step["grepSearch"]["query"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("代码");
            message["text"] = json!(format!("搜索文件 · {query}"));
            message["toolActions"] = json!(["search-files"]);
            if let Some(path) = step["grepSearch"]["searchPath"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                message["details"] = json!(format!("路径：{path}"));
            }
        }
        "WRITE_TO_FILE" | "REPLACE_FILE_CONTENT" | "MULTI_REPLACE_FILE_CONTENT" => {
            let section = match kind {
                "WRITE_TO_FILE" => "writeToFile",
                "REPLACE_FILE_CONTENT" => "replaceFileContent",
                _ => "multiReplaceFileContent",
            };
            let path = step_path(
                step,
                &[
                    (section, "targetFile"),
                    (section, "targetFileUri"),
                    (section, "path"),
                ],
            )
            .unwrap_or("文件");
            let change_kind = if kind == "WRITE_TO_FILE" {
                "create"
            } else {
                "update"
            };
            message["text"] = json!(format!("修改文件 · {}", short_name(path)));
            message["toolActions"] = json!(["edit-file"]);
            let diff = if kind == "WRITE_TO_FILE" {
                step[section]["codeContent"]
                    .as_str()
                    .map(|content| {
                        content
                            .lines()
                            .take(40)
                            .map(|line| format!("+{line}"))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default()
            } else {
                build_replace_diff(step, section)
            };
            if path != "文件" {
                message["changes"] = format_edit_changes(path, change_kind, &diff);
            }
        }
        "SEARCH_WEB" => {
            let query = step["searchWeb"]["query"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("网页");
            message["text"] = json!(format!("搜索网页 · {query}"));
            message["toolActions"] = json!(["web-search"]);
        }
        "READ_URL_CONTENT" => {
            let url = step["readUrlContent"]["url"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("网页");
            message["text"] = json!(format!("浏览网页 · {url}"));
            message["toolActions"] = json!(["open-page"]);
        }
        "BROWSER_SUBAGENT" | "SUBAGENT" | "INVOKE_SUBAGENT" => {
            let label = step["browserSubagent"]["taskName"]
                .as_str()
                .or(step["subagent"]["role"].as_str())
                .or(step["invokeSubagent"]["role"].as_str())
                .unwrap_or("子任务");
            message["text"] = json!(format!("子 Agent · {label}"));
            message["toolActions"] = json!(["call-tool"]);
        }
        "GENERATE_IMAGE" => {
            let name = step["generateImage"]["imageName"]
                .as_str()
                .or(step["generateImage"]["prompt"].as_str())
                .unwrap_or("图片");
            message["text"] = json!(format!("生成图片 · {name}"));
            message["toolActions"] = json!(["call-tool"]);
        }
        "TASK_BOUNDARY" => {
            let task = step["taskBoundary"]["taskName"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("任务阶段");
            let mode = step["taskBoundary"]["mode"].as_str().unwrap_or_default();
            message["text"] = json!(if mode.is_empty() {
                format!("任务阶段 · {task}")
            } else {
                format!("任务阶段 · {task} ({mode})")
            });
            if let Some(summary) = step["taskBoundary"]["taskStatus"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                message["details"] = json!(summary);
            }
        }
        "COMMAND_STATUS" | "SEND_COMMAND_INPUT" => {
            message["text"] = json!(if kind == "COMMAND_STATUS" {
                "检查命令状态"
            } else {
                "向命令发送输入"
            });
            message["toolActions"] = json!(["run-command"]);
        }
        "GENERIC" => {
            let name = step["generic"]["toolName"]
                .as_str()
                .or(step["generic"]["name"].as_str())
                .or_else(|| {
                    step["generic"]["args"]["CommandLine"]
                        .as_str()
                        .map(|_| "run_command")
                })
                .unwrap_or("generic");
            let actions =
                crate::tool_activity::named_tool_action_by_name(name, &step["generic"]["args"]);
            message["toolActions"] = json!(actions);
            if let Some(cmd) = step["generic"]["args"]["CommandLine"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                message["text"] = json!(format!("命令 · {cmd}"));
            } else {
                message["text"] = json!(format!("工具 · {name}"));
            }
        }
        "ERROR_MESSAGE" => {
            message["text"] = json!(
                step["errorMessage"]["message"]
                    .as_str()
                    .unwrap_or("Antigravity 操作错误")
            );
        }
        "NOTIFY_USER" => {
            message["text"] = json!(
                step["notifyUser"]["notificationContent"]
                    .as_str()
                    .unwrap_or("Antigravity 通知")
            );
        }
        "ASK_QUESTION" => {
            message["text"] = json!(
                step["askQuestion"]["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|q| q["question"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            );
        }
        _ => {
            message["text"] = json!(kind.to_lowercase().replace('_', " "));
            message["toolActions"] = json!(["call-tool"]);
        }
    }
    message
}

pub(super) fn bound_message(message: &mut Value, mut budget: usize) {
    let mut truncated = false;
    for field in ["text", "details", "output"] {
        let Some(text) = message[field].as_str() else {
            continue;
        };
        let mut end = 0;
        for (index, ch) in text.char_indices() {
            // Bound the serialized JSON size, including escaped terminal output.
            let cost = match ch {
                '"' | '\\' | '\n' | '\r' | '\t' => 2,
                '\u{0000}'..='\u{001f}' => 6,
                _ => ch.len_utf8(),
            };
            if cost > budget {
                break;
            }
            budget -= cost;
            end = index + ch.len_utf8();
        }
        if end < text.len() {
            truncated = true;
            message[field] = json!(&text[..end]);
        }
    }
    if truncated {
        message["truncated"] = json!(true);
    }
}
