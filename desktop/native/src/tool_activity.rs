use serde_json::{Value, json};

pub(crate) const FIELD_LIMIT: usize = 16 * 1024;

fn excerpt(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    format!("{}…", &text[..text.floor_char_boundary(limit)])
}

fn command(item: &Value, limit: usize) -> String {
    if let Some(text) = item["command"].as_str() {
        return excerpt(text, limit);
    }
    let mut command = String::new();
    for arg in item["command"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !command.is_empty() {
            command.push(' ');
        }
        command.push_str(&excerpt(arg, limit));
        if command.len() > limit {
            break;
        }
    }
    excerpt(&command, limit)
}

fn command_action_kinds(item: &Value) -> Vec<&'static str> {
    let parsed = [
        "commandActions",
        "command_actions",
        "parsed_cmd",
        "parsedCmd",
    ]
    .into_iter()
    .filter_map(|field| item[field].as_array())
    .find(|actions| !actions.is_empty());
    let mut kinds = Vec::new();
    for action in parsed.into_iter().flatten() {
        let kind = match action["type"].as_str() {
            Some("read") => "read-file",
            Some("listFiles" | "list_files") => "list-files",
            Some("search") => "search-files",
            _ => "run-command",
        };
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    if kinds.is_empty() {
        kinds.push("run-command");
    }
    kinds
}

pub(crate) fn named_tool_action_by_name(name: &str, arguments: &Value) -> Vec<&'static str> {
    let tool = name.rsplit("__").next().unwrap_or(name);
    let tool = tool.rsplit(['.', '/']).next().unwrap_or(tool);
    let kind = match tool {
        "exec_command" | "shell_command" | "shell" | "local_shell" | "bash" | "run_command" => {
            // Some tool versions preserve typed commands in arguments instead of
            // emitting a separate commandExecution item.
            return command_action_kinds(arguments);
        }
        "read_file"
        | "read_files"
        | "read_text_file"
        | "read_multiple_files"
        | "readFile"
        | "readFiles"
        | "view_file"
        | "view_file_outline"
        | "view_code_item" => "read-file",
        "list_directory" | "list_files" | "listFiles" | "list_dir" | "find_by_name" | "glob" => {
            "list-files"
        }
        "search_files" | "searchFiles" | "grep" | "grep_search" | "ripgrep" => "search-files",
        "apply_patch"
        | "edit_file"
        | "write_file"
        | "fileChange"
        | "write_to_file"
        | "replace_file_content"
        | "multi_replace_file_content"
        | "str_replace_editor" => "edit-file",
        "web_search" | "web_search_call" | "webSearch" | "search_query" | "search_web" => {
            "web-search"
        }
        "open_page" | "openPage" | "read_url_content" | "fetch_url" => "open-page",
        "find_in_page" | "findInPage" => "find-in-page",
        "load_tool" | "loadTool" => "load-tool",
        "tool_search" | "tool_search_call" | "toolSearch" | "find_tool" => "find-tool",
        _ => "call-tool",
    };
    vec![kind]
}

fn named_tool_action(item: &Value) -> Vec<&'static str> {
    let name = item["tool"]
        .as_str()
        .or_else(|| item["name"].as_str())
        .unwrap_or_default();
    named_tool_action_by_name(name, &item["arguments"])
}

pub fn action_kinds(item: &Value) -> Vec<&'static str> {
    let kind = match item["type"].as_str() {
        Some(
            "commandExecution" | "CommandExecution" | "command_execution" | "local_shell_call"
            | "shell_command_call",
        ) => return command_action_kinds(item),
        Some("fileChange" | "FileChange" | "file_change" | "apply_patch_call") => "edit-file",
        Some("webSearch" | "WebSearch" | "web_search" | "web_search_call") => {
            match item["action"]["type"]
                .as_str()
                .or_else(|| item["action"].as_str())
            {
                Some("openPage" | "open_page") => "open-page",
                Some("findInPage" | "find_in_page") => "find-in-page",
                Some("search") | None => "web-search",
                _ => "call-tool",
            }
        }
        Some(
            "mcpToolCall" | "McpToolCall" | "mcp_tool_call" | "dynamicToolCall" | "DynamicToolCall"
            | "dynamic_tool_call" | "function_call" | "custom_tool_call",
        ) => return named_tool_action(item),
        Some("toolSearch" | "ToolSearch" | "tool_search" | "tool_search_call") => "find-tool",
        Some("loadTool" | "LoadTool" | "load_tool") => "load-tool",
        _ => return vec![],
    };
    vec![kind]
}

pub fn turn_timing(turn_id: &str, started_at: Option<u64>, duration: Option<u64>) -> Option<Value> {
    let (text, metadata) = if let Some(duration) = duration {
        (
            "本轮用时",
            json!({"kind":"turn-timing","state":"completed","durationMs":duration}),
        )
    } else {
        let started_at = started_at.filter(|value| *value >= 1_000_000_000)?;
        let milliseconds = if started_at < 100_000_000_000 {
            started_at * 1000
        } else {
            started_at
        };
        (
            "正在工作",
            json!({"kind":"turn-timing","state":"running","startedAt":milliseconds}),
        )
    };
    Some(json!({
        "id":format!("{turn_id}:timing"),"role":"tool","text":text,
        "turnId":turn_id,"codex":metadata,
    }))
}

pub fn timeline_event(item: &Value, fallback_id: &str, turn_id: Option<&str>) -> Option<Value> {
    let (text, codex) = match item["type"].as_str()? {
        "contextCompaction" | "ContextCompaction" => {
            let (state, text) = match item["status"].as_str() {
                Some("inProgress" | "in_progress" | "running") => ("running", "正在压缩上下文"),
                Some("failed") => ("failed", "上下文压缩失败"),
                _ => ("completed", "已压缩上下文"),
            };
            let mut metadata = json!({"kind":"compaction","state":state});
            if item["trigger"] == "automatic" || item["trigger"] == "auto" {
                metadata["automatic"] = json!(true);
            }
            (text, metadata)
        }
        "subAgentActivity" | "SubAgentActivity" => {
            let (state, text) = match item["kind"].as_str()? {
                "started" => ("started", "子 Agent 开始工作"),
                "completed" => ("completed", "子 Agent 已完成"),
                "interrupted" => ("interrupted", "子 Agent 已中断"),
                "failed" => ("failed", "子 Agent 执行失败"),
                _ => return None,
            };
            let agent_path = item["agentPath"]
                .as_str()
                .or_else(|| item["agent_path"].as_str());
            let agent_id = item["agentThreadId"]
                .as_str()
                .or_else(|| item["agent_thread_id"].as_str())
                .or(agent_path)?;
            let name = item["agentNickname"]
                .as_str()
                .or_else(|| item["agent_nickname"].as_str())
                .or_else(|| {
                    agent_path.and_then(|path| path.trim_end_matches('/').rsplit('/').next())
                })
                .filter(|name| !name.trim().is_empty())
                .unwrap_or("子 Agent");
            (
                text,
                json!({"kind":"subagent","state":state,"agentId":excerpt(agent_id, 160),"name":excerpt(name, 160)}),
            )
        }
        _ => return None,
    };
    Some(json!({
        "id":item["id"].as_str().unwrap_or(fallback_id),"role":"tool","text":text,
        "turnId":turn_id,"codex":codex,
    }))
}

pub fn summary(item: &Value) -> Option<String> {
    let label = match item["type"].as_str()? {
        "commandExecution" | "CommandExecution" => {
            let command = command(item, 240);
            if command.is_empty() {
                "命令".into()
            } else {
                format!("命令 · {command}")
            }
        }
        "fileChange" | "FileChange" => "文件修改".into(),
        "mcpToolCall" | "McpToolCall" | "dynamicToolCall" | "DynamicToolCall" => {
            format!(
                "工具 · {}",
                excerpt(item["tool"].as_str().unwrap_or("调用"), 240)
            )
        }
        "webSearch" | "WebSearch" => "网页搜索".into(),
        _ => return None,
    };
    let status = excerpt(item["status"].as_str().unwrap_or("已记录"), 80);
    Some(format!("{label} · {status}"))
}

pub fn details(item: &Value) -> Option<Value> {
    let mut result = json!({});
    match item["type"].as_str()? {
        "commandExecution" | "CommandExecution" => {
            let command = command(item, FIELD_LIMIT);
            if !command.is_empty() {
                let exit = item["exitCode"]
                    .as_i64()
                    .or_else(|| item["exit_code"].as_i64());
                result["details"] = json!(match exit {
                    Some(code) => format!("{command}\n退出码：{code}"),
                    None => command,
                });
            }
            if let Some(output) = item["aggregatedOutput"]
                .as_str()
                .or_else(|| item["aggregated_output"].as_str())
                .or_else(|| item["output"].as_str())
                .filter(|output| !output.is_empty())
            {
                result["output"] = json!(excerpt(output, FIELD_LIMIT));
            }
        }
        "fileChange" | "FileChange" => {
            let changes: Vec<_> = item["changes"].as_array().into_iter().flatten().take(16)
                .filter_map(|change| Some(json!({
                    "path": excerpt(change["path"].as_str()?, 1024),
                    "kind": excerpt(change["kind"]["type"].as_str().or_else(|| change["kind"].as_str()).unwrap_or("update"), 80),
                    "diff": excerpt(change["diff"].as_str().unwrap_or_default(), 2048),
                })))
                .collect();
            if !changes.is_empty() {
                result["changes"] = json!(changes);
            }
        }
        "mcpToolCall" | "McpToolCall" | "dynamicToolCall" | "DynamicToolCall" => {
            let text = item["result"]["content"]
                .as_array()
                .or_else(|| item["contentItems"].as_array())
                .map_or_else(String::new, |content| {
                    content
                        .iter()
                        .take(8)
                        .filter_map(|item| item["text"].as_str())
                        .map(|text| excerpt(text, 2048))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
            if !text.is_empty() {
                result["output"] = json!(text);
            }
            if let Some(error) = item["error"]["message"].as_str() {
                result["details"] = json!(excerpt(error, FIELD_LIMIT));
            }
        }
        "webSearch" | "WebSearch" => {
            if let Some(query) = item["query"].as_str().filter(|query| !query.is_empty()) {
                result["details"] = json!(excerpt(query, FIELD_LIMIT));
            }
        }
        _ => return None,
    }
    (!result.as_object()?.is_empty()).then_some(result)
}

pub fn apply_details(message: &mut Value, details: &Value) {
    if let Some(fields) = details.as_object() {
        for (key, value) in fields {
            message[key] = value.clone();
        }
        message["deferred"] = json!(false);
    }
}

#[cfg(test)]
mod tests {
    use super::action_kinds;
    use serde_json::json;

    #[test]
    fn preserves_unique_typed_command_actions_in_order() {
        assert_eq!(
            action_kinds(&json!({
                "type":"commandExecution",
                "commandActions":[
                  {"type":"search","query":"fixture"},
                  {"type":"read","path":"example.txt"},
                  {"type":"search"},
                  {"type":"unknown"},
                  {"type":"listFiles"}
                ]
            })),
            ["search-files", "read-file", "run-command", "list-files"]
        );
        assert_eq!(
            action_kinds(&json!({
                "type":"CommandExecution",
                "commandActions":[],
                "parsed_cmd":[{"type":"list_files"},{"type":"read"}]
            })),
            ["list-files", "read-file"]
        );
    }

    #[test]
    fn keeps_unparsed_and_platform_commands_generic() {
        for item in [
            json!({"type":"commandExecution","command":"cat example.txt"}),
            json!({"type":"CommandExecution","source":"user_shell","parsed_cmd":[{"type":"unknown"}]}),
            json!({"type":"CommandExecution","parsed_cmd":[{"type":"future_action"}]}),
            json!({"type":"mcpToolCall","tool":"functions.exec_command"}),
        ] {
            assert_eq!(action_kinds(&item), ["run-command"]);
        }
        assert_eq!(
            action_kinds(&json!({
                "type":"dynamicToolCall",
                "tool":"shell_command",
                "arguments":{"commandActions":[{"type":"read"}]}
            })),
            ["read-file"]
        );
    }

    #[test]
    fn distinguishes_search_open_and_find_actions() {
        for (action, expected) in [
            ("search", "web-search"),
            ("openPage", "open-page"),
            ("findInPage", "find-in-page"),
            ("open_page", "open-page"),
            ("find_in_page", "find-in-page"),
            ("other", "call-tool"),
        ] {
            assert_eq!(
                action_kinds(&json!({"type":"WebSearch","action":{"type":action}})),
                [expected]
            );
        }
        assert_eq!(
            action_kinds(&json!({"type":"webSearch","query":"example"})),
            ["web-search"]
        );
    }

    #[test]
    fn categorizes_file_updates_and_known_tools_only_by_typed_names() {
        for (tool, expected) in [
            ("mcp__filesystem__read_text_file", "read-file"),
            ("filesystem/list_directory", "list-files"),
            ("filesystem.search_files", "search-files"),
            ("apply_patch", "edit-file"),
            ("tool_search", "find-tool"),
            ("load_tool", "load-tool"),
            ("unknown_example", "call-tool"),
        ] {
            assert_eq!(
                action_kinds(&json!({"type":"McpToolCall","tool":tool})),
                [expected]
            );
        }
        assert_eq!(action_kinds(&json!({"type":"fileChange"})), ["edit-file"]);
        assert!(action_kinds(&json!({"type":"agentMessage"})).is_empty());
    }
}
