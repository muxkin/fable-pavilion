use super::*;

pub(super) fn delivery(result: Result<Value>, accepted: Delivery) -> Delivery {
    match result {
        Ok(_) => accepted,
        Err(error) if error.is::<DownstreamUncertain>() => Delivery::Uncertain,
        Err(_) => Delivery::Rejected("Antigravity 本地服务不可用"),
    }
}

pub(super) fn valid_text(text: &str) -> bool {
    !text.trim().is_empty() && text.encode_utf16().count() <= 16_000
}

pub(super) fn valid_selection(ids: &[String]) -> bool {
    ids.len() <= 10
        && ids
            .iter()
            .all(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        && ids.iter().collect::<HashSet<_>>().len() == ids.len()
}

pub(super) fn supports_append(status: &Value) -> bool {
    matches!(
        status.as_str(),
        Some("CASCADE_RUN_STATUS_RUNNING" | "CASCADE_RUN_STATUS_BUSY")
    )
}

pub(super) fn active_execution(steps: &[Value]) -> Option<&str> {
    steps
        .iter()
        .rev()
        .find_map(|step| step["metadata"]["executionId"].as_str())
        .filter(|id| !id.is_empty())
}

pub(super) fn execution_finished(trajectory: &Value, execution: &str) -> bool {
    trajectory["executorMetadatas"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|metadata| {
            metadata["executionId"] == execution
                && metadata["terminationReason"]
                    .as_str()
                    .and_then(terminal)
                    .is_some()
        })
}

pub(super) fn valid_title(title: &str) -> bool {
    title.encode_utf16().count() <= 160 && !title.chars().any(char::is_control)
}

pub(super) fn native_models(data: &Value) -> Vec<NativeModel> {
    fn text(value: &Value) -> Option<&str> {
        value.as_str().map(str::trim).filter(|value| {
            !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
        })
    }
    let mut seen = HashSet::new();
    data["clientModelConfigs"]
        .as_array()
        .into_iter()
        .flatten()
        .take(256)
        .filter_map(|row| {
            let native = text(&row["modelOrAlias"]["model"])?;
            let id = text(&row["modelId"]).unwrap_or(native);
            let name = text(&row["label"])?;
            if name.starts_with("MODEL_") || !seen.insert(id.to_owned()) {
                return None;
            }
            Some(NativeModel {
                id: id.to_owned(),
                name: name.to_owned(),
                native: native.to_owned(),
            })
        })
        .collect()
}

pub(super) fn current_model<'a>(trajectory: &'a Value, steps: &'a [Value]) -> Option<&'a str> {
    fn selected(config: &Value) -> Option<&str> {
        let planner = &config["plannerConfig"];
        [
            &planner["planModel"],
            &config["chatModel"]["model"],
            &planner["requestedModel"]["model"],
            &planner["modelName"],
            &config["generatorModel"],
            &config["requestedModel"]["model"],
            &config["modelOrAlias"]["model"],
            &config["model"],
        ]
        .into_iter()
        .filter_map(Value::as_str)
        .find(|id| !id.is_empty() && *id != "MODEL_UNSPECIFIED")
    }
    // The App resolves the latest generator metadata against its catalog.
    // Only inspect these explicit model fields; generator prompts and other
    // internal metadata must never become part of the remote thread view.
    trajectory["generatorMetadata"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find_map(selected)
        .or_else(|| {
            steps.iter().rev().find_map(|step| {
                selected(&step["userInput"]["userConfig"])
                    .or_else(|| selected(&step["metadata"]))
                    .or_else(|| selected(&step["plannerResponse"]))
            })
        })
}

/// Preserve the groups and windows from the App's View Usage source. Only the
/// percentage oneof can describe a percentage; missing values or absolute
/// amounts do not imply an exhausted allowance.
pub(super) fn quota_usage(summary: &Value) -> Value {
    fn label(value: &Value) -> Option<&str> {
        value.as_str().map(str::trim).filter(|text| {
            !text.is_empty() && text.len() <= 512 && !text.chars().any(char::is_control)
        })
    }
    let Some(groups) = summary["response"]["groups"].as_array() else {
        return crate::usage::unavailable("Antigravity 当前账户暂未提供可用的分组额度");
    };
    let mut seen = std::collections::HashSet::new();
    let buckets: Vec<_> = groups.iter().take(128).filter_map(|group| {
            let native = group["buckets"].as_array()?;
            let mut ids: Vec<_> = native.iter().take(32).filter_map(|bucket| label(&bucket["bucketId"])).collect();
            ids.sort_unstable();
            ids.dedup();
            if ids.is_empty() {
                return None;
            }
            let id = format!("antigravity-{:x}", Sha256::digest(serde_json::to_vec(&ids).ok()?));
            let mut windows_seen = std::collections::HashSet::new();
            let windows: Vec<_> = native.iter().take(32).filter_map(|bucket| {
                let native_id = label(&bucket["bucketId"])?;
                if bucket["disabled"] == true || bucket.get("remainingAmount").is_some() {
                    return None;
                }
                // remaining_fraction is a proto oneof: explicit zero is
                // preserved in ProtoJSON and absence carries no percentage.
                let remaining = bucket["remainingFraction"].as_f64()?;
                if !remaining.is_finite() || !(0.0..=1.0).contains(&remaining) || !windows_seen.insert(native_id) {
                    return None;
                }
                let used = ((1.0 - remaining) * 100_000_000.0).round() / 1_000_000.0;
                let native_window = bucket["window"].as_str().unwrap_or("").trim().to_ascii_lowercase();
                let (name, duration) = match native_window.as_str() {
                    "weekly" => ("每周", Some(10080)),
                    "5h" => ("5 小时", Some(300)),
                    _ => (label(&bucket["displayName"]).or_else(|| label(&bucket["window"])).unwrap_or("当前额度"), None),
                };
                let mut window = json!({"label":name,"usedPercent":used});
                if let Some(duration) = duration {
                    window["durationMinutes"] = json!(duration);
                }
                // The app shows a reset countdown only for buckets whose
                // upstream description marks the reset as relevant.
                if bucket["description"].as_str().is_some_and(|text| !text.is_empty())
                    && let Some(time) = quota_reset_time(&bucket["resetTime"])
                {
                    window["resetsAt"] = json!(time);
                }
                Some(window)
            }).collect();
            if windows.is_empty() || !seen.insert(id.clone()) {
                return None;
            }
            Some(json!({"id":id,"name":label(&group["displayName"]).unwrap_or("Antigravity"),"windows":windows}))
        })
        .collect();
    if buckets.is_empty() {
        return crate::usage::unavailable("Antigravity 当前账户暂未提供可用的模型额度");
    }
    json!({"available":true,"updatedAt":crate::state::now(),"canReset":false,"buckets":buckets})
}

pub(super) fn quota_reset_time(value: &Value) -> Option<i64> {
    let text = value.as_str()?;
    let bytes = text.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || !text.ends_with('Z')
    {
        return None;
    }
    let year: i32 = text.get(0..4)?.parse().ok()?;
    let month: u8 = text.get(5..7)?.parse().ok()?;
    let day: u8 = text.get(8..10)?.parse().ok()?;
    time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, day).ok()?;
    if text.get(11..13)?.parse::<u8>().ok()? > 23
        || text.get(14..16)?.parse::<u8>().ok()? > 59
        || text.get(17..19)?.parse::<u8>().ok()? > 59
    {
        return None;
    }
    let tail = text.get(19..text.len() - 1)?;
    if !tail.is_empty() {
        let digits = tail.strip_prefix('.')?;
        if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    let millis = timestamp_ms(text);
    (millis > 0).then_some(millis)
}

pub(super) fn terminal(reason: &str) -> Option<&'static str> {
    match reason {
        "EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL"
        | "EXECUTOR_TERMINATION_REASON_TERMINAL_STEP_TYPE"
        | "EXECUTOR_TERMINATION_REASON_TERMINAL_CUSTOM_HOOK" => Some("completed"),
        "EXECUTOR_TERMINATION_REASON_USER_CANCELED" => Some("interrupted"),
        "EXECUTOR_TERMINATION_REASON_ERROR"
        | "EXECUTOR_TERMINATION_REASON_MAX_TOKEN_BUDGET_EXCEEDED" => Some("failed"),
        _ => None,
    }
}

pub(super) fn observations(data: &Value) -> Vec<Observation> {
    let metadata: &[Value] = data["trajectory"]["executorMetadatas"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let terminal: BTreeMap<_, _> = metadata
        .iter()
        .filter_map(|m| {
            Some((
                m["executionId"].as_str()?,
                terminal(m["terminationReason"].as_str()?)?,
            ))
        })
        .collect();
    let mut result = Vec::new();
    let mut requests = HashSet::new();
    let mut turns = Vec::new();
    // The host transports at most 1000 observations. Reserve half for the newest
    // request correlations so long local histories cannot evict a recent send.
    for step in data["trajectory"]["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
    {
        let Some(request) = step["userInput"]["clientMessageId"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok())
        else {
            continue;
        };
        let Some(turn) = step["metadata"]["executionId"]
            .as_str()
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if !requests.insert(request) {
            continue;
        }
        result.push(Observation {
            request: Some(request),
            turn: turn.to_owned(),
            state: terminal.get(turn).copied().unwrap_or("accepted"),
        });
        turns.push(turn);
        if result.len() == 500 {
            break;
        }
    }
    let mut seen = HashSet::new();
    let mut terminal_count = 0;
    for turn in turns.into_iter().chain(
        metadata
            .iter()
            .rev()
            .filter_map(|m| m["executionId"].as_str()),
    ) {
        let Some(state) = terminal.get(turn).copied() else {
            continue;
        };
        if !seen.insert(turn) {
            continue;
        }
        result.push(Observation {
            request: None,
            turn: turn.to_owned(),
            state,
        });
        terminal_count += 1;
        if terminal_count == 500 {
            break;
        }
    }
    result
}

pub(super) fn pending_interaction(step: &Value) -> bool {
    let interaction = &step["requestedInteraction"];
    if !interaction.as_object().is_some_and(|i| !i.is_empty()) {
        return false;
    }
    if matches!(
        step["status"].as_str(),
        Some(
            "CORTEX_STEP_STATUS_DONE"
                | "CORTEX_STEP_STATUS_ERROR"
                | "CORTEX_STEP_STATUS_CANCELED"
                | "CORTEX_STEP_STATUS_HALTED"
                | "CORTEX_STEP_STATUS_INTERRUPTED"
                | "CORTEX_STEP_STATUS_CLEARED"
                | "CORTEX_STEP_STATUS_INVALID"
        )
    ) {
        return false;
    }
    !step["completedInteractions"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|done| done["request"] == *interaction)
}

pub(super) fn view_fingerprint(view: &View) -> u64 {
    let observations: Vec<_> = view
        .observations
        .iter()
        .map(|o| json!([o.request, o.turn, o.state]))
        .collect();
    let mut thread = view.thread.clone();
    thread["revision"] = Value::Null;
    revision(&json!([
        thread,
        view.messages.as_ref(),
        view.streamed,
        observations
    ]))
}

pub(super) fn skill_catalog(thread: &str, workspaces: &Value, data: &Value) -> Result<Vec<NativeSkill>> {
    let empty = Vec::new();
    let commands = if data["commands"].is_null() {
        &empty
    } else {
        data["commands"]
            .as_array()
            .context("Antigravity 技能目录格式不兼容")?
    };
    ensure!(commands.len() <= 2048, "Antigravity 技能目录过大");
    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    for command in commands {
        let info = &command["info"];
        if info["type"] != "SLASH_COMMAND_TYPE_SKILL" && info["type"] != 2 {
            continue;
        }
        let Some(name) = info["name"].as_str().filter(|s| {
            !s.is_empty() && s.encode_utf16().count() <= 200 && !s.chars().any(char::is_control)
        }) else {
            continue;
        };
        ensure!(
            serde_json::to_vec(info)?.len() <= 64 * 1024,
            "Antigravity 技能定义过大"
        );
        // Scope opaque identities to the native conversation and its workspaces.
        // The browser never supplies native command definitions or file paths.
        let id = crate::state::hash(
            &json!([
                "antigravity-skill",
                thread,
                workspaces,
                name,
                info["definitionPath"],
                info["plugin"]
            ])
            .to_string(),
        );
        if !seen.insert(id.clone()) {
            continue;
        }
        let display = info["displayName"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or(command["title"].as_str().filter(|s| !s.is_empty()))
            .unwrap_or(name);
        let description: String = command["description"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(512)
            .collect();
        let mut choice = json!({"id":id,"name":name,"displayName":display.chars().take(200).collect::<String>(),"description":description,"source":"Antigravity"});
        if let Some(plugin) = info["plugin"]["displayName"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or(info["plugin"]["name"].as_str().filter(|s| !s.is_empty()))
        {
            choice["sourceKind"] = json!("plugin");
            choice["source"] = json!(plugin.chars().take(200).collect::<String>());
        }
        skills.push(NativeSkill {
            choice,
            id,
            info: info.clone(),
        });
    }
    Ok(skills)
}

pub(super) fn selected_skills(catalog: &[NativeSkill], ids: &[String]) -> Result<Vec<Value>> {
    ids.iter()
        .map(|id| {
            let skill = catalog
                .iter()
                .find(|skill| skill.id == *id)
                .context("所选技能已失效")?;
            Ok(json!({"item":{"slashCommand":{"info":skill.info,"argumentValues":{}}}}))
        })
        .collect()
}

pub(super) fn valid_id(id: &str) -> Result<()> {
    Uuid::parse_str(id).context("Antigravity 会话 ID 无效")?;
    Ok(())
}
pub(super) fn thread_id(params: &Value) -> Result<&str> {
    let id = params["id"].as_str().context("Antigravity 会话 ID 无效")?;
    valid_id(id)?;
    Ok(id)
}
pub(super) fn offset(query: &Value, length: usize) -> Result<usize> {
    let value = query["cursor"]
        .as_str()
        .map(str::parse::<usize>)
        .transpose()
        .context("历史游标无效")?
        .unwrap_or(0);
    ensure!(value <= length, "历史游标已失效");
    Ok(value)
}

pub(super) fn file_uri_path(uri: &str) -> Option<String> {
    url::Url::parse(uri)
        .ok()?
        .to_file_path()
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

/// Only public project descriptors cross the plugin boundary. Resource roots
/// come from the registered project rather than a conversation's folder name.
pub(super) fn project_values(data: &Value) -> Result<Value> {
    if data["projects"].is_null() {
        return Ok(json!([]));
    }
    let rows = data["projects"]
        .as_array()
        .context("Antigravity 项目列表格式不兼容")?;
    let mut seen = HashSet::new();
    let values: Vec<_> = rows
        .iter()
        .filter_map(|project| {
            let id = project["id"].as_str().filter(|id| {
                !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
            })?;
            if !seen.insert(id) {
                return None;
            }
            let name = project["name"]
                .as_str()
                .map(str::trim)
                .filter(|name| {
                    !name.is_empty() && name.len() <= 512 && !name.chars().any(char::is_control)
                })
                .unwrap_or(id);
            let path = project["projectResources"]["resources"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|resource| resource["gitFolder"]["folderUri"].as_str())
                .find_map(file_uri_path)
                .unwrap_or_default();
            Some(json!({"id":id,"name":name,"path":path}))
        })
        .collect();
    Ok(json!(values))
}

pub(super) fn project_workspace_uris(data: &Value) -> HashMap<String, Vec<Value>> {
    let mut map = HashMap::new();
    let Some(rows) = data["projects"].as_array() else {
        return map;
    };
    for project in rows {
        let Some(id) = project["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control))
        else {
            continue;
        };
        let uris: Vec<Value> = project["projectResources"]["resources"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|resource| resource["gitFolder"]["folderUri"].as_str())
            .filter(|uri| !uri.is_empty() && !uri.chars().any(char::is_control))
            .map(|uri| json!(uri))
            .collect();
        if !uris.is_empty() {
            map.insert(id.to_owned(), uris);
        }
    }
    map
}

pub(super) fn summary_with_projects(id: &str, summary: &Value, projects: &Value) -> Value {
    let mut value = summary_value(id, summary);
    if let Some(project) = projects
        .as_array()
        .into_iter()
        .flatten()
        .find(|project| project["id"] == value["projectId"])
    {
        value["projectName"] = project["name"].clone();
    }
    value
}

pub(super) fn summary_value(id: &str, s: &Value) -> Value {
    let uri = s["workspaces"][0]["workspaceFolderAbsoluteUri"]
        .as_str()
        .or(s["trajectoryMetadata"]["workspaces"][0]["workspaceFolderAbsoluteUri"].as_str())
        .or(s["trajectoryMetadata"]["workspaceUris"][0].as_str())
        .unwrap_or("");
    let cwd = file_uri_path(uri).unwrap_or_default();
    let project = s["trajectoryMetadata"]["projectId"]
        .as_str()
        .filter(|s| !s.is_empty());
    json!({"id":id,"title":s["annotations"]["title"].as_str().filter(|s| !s.is_empty()).or(s["summary"].as_str()).unwrap_or("Antigravity 会话"),
        "cwd":cwd,"updatedAt":timestamp_ms(s["lastModifiedTime"].as_str().unwrap_or("")),
        "projectId":project,"projectName":null})
}
pub(super) fn revision(value: &Value) -> u64 {
    let digest = Sha256::digest(value.to_string().as_bytes());
    u64::from_le_bytes(digest[..8].try_into().unwrap()) & ((1 << 53) - 1)
}

// Antigravity sends UTC RFC3339 protobuf timestamps. Civil date arithmetic avoids
// platform locale/timezone differences and an extra desktop runtime dependency.
pub(super) fn timestamp_ms(s: &str) -> i64 {
    crate::state::rfc3339_ms(s)
}
