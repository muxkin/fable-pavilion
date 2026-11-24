use super::*;

pub(super) fn compatible_state(id: Uuid, state: &Value) -> bool {
    let runtime = &state["threadRuntimeStatus"];
    let requests = &state["requests"];
    state["id"].as_str().and_then(|id| Uuid::parse_str(id).ok()) == Some(id)
        && (state["hostId"].is_null() || state["hostId"] == "local")
        && (runtime.is_null() || runtime["type"].is_string())
        && (requests.is_null()
            || requests
                .as_array()
                .is_some_and(|rows| rows.iter().all(Value::is_object))
            || requests
                .as_object()
                .is_some_and(|rows| rows.values().all(Value::is_object)))
        && compatible_ordered(turn_history(state), |turn| {
            turn["status"].is_string() && compatible_ordered(&turn["items"], Value::is_object)
        })
}

fn compatible_ordered(value: &Value, compatible: impl Fn(&Value) -> bool) -> bool {
    if let Some(array) = value.as_array() {
        return array.iter().all(compatible);
    }
    if value["kind"] == "canonical" {
        return compatible_ordered(&value["history"], compatible);
    }
    let (Some(islands), Some(entities)) = (
        value["islands"].as_array(),
        value["entitiesByKey"].as_object(),
    ) else {
        return false;
    };
    islands.iter().all(|island| {
        island["entries"].as_array().is_some_and(|entries| {
            entries.iter().all(|entry| {
                entry["value"]
                    .as_str()
                    .and_then(|key| entities.get(key))
                    .is_some_and(&compatible)
            })
        })
    })
}

pub(super) fn patch(root: &mut Value, patch: &mut Value) -> Result<()> {
    let patch = patch.as_object_mut().context("增量格式无效")?;
    let has_value = patch.contains_key("value");
    let mut value = patch.remove("value").unwrap_or(Value::Null);
    let path = patch
        .get("path")
        .and_then(Value::as_array)
        .context("增量路径无效")?;
    let op = patch.get("op").and_then(Value::as_str).unwrap_or_default();
    ensure!(!path.is_empty() && path.len() <= 64, "增量路径无效");
    ensure!(op == "remove" || has_value, "增量值缺失");
    let path_in_turns = matches!(path[0].as_str(), Some("turns" | "turnHistory"));
    let (last, parents) = path.split_last().unwrap();
    let mut current = root;
    for part in parents {
        current = if let Some(key) = part.as_str() {
            current.as_object_mut().and_then(|map| map.get_mut(key))
        } else {
            current
                .as_array_mut()
                .and_then(|list| list.get_mut(part.as_u64()? as usize))
        }
        .context("增量位置不存在")?;
    }
    if let Some(key) = last.as_str() {
        if path_in_turns
            && follow_frame::is_output_key(key.as_bytes())
            && let Some(text) = value.as_str()
            && text.len() > tool_activity::FIELD_LIMIT + 4
        {
            let limit = text.ceil_char_boundary(tool_activity::FIELD_LIMIT + 1);
            value = Value::String(text[..limit].to_owned());
        }
        let map = current.as_object_mut().context("增量对象无效")?;
        match op {
            "add" => {
                map.insert(key.into(), value);
            }
            "replace" => {
                *map.get_mut(key).context("增量字段不存在")? = value;
            }
            "remove" => {
                map.remove(key).context("增量字段不存在")?;
            }
            _ => bail!("增量操作无效"),
        }
    } else {
        let list = current.as_array_mut().context("增量数组无效")?;
        let index = last.as_u64().context("增量索引无效")? as usize;
        match op {
            "add" if index <= list.len() => list.insert(index, value),
            "replace" if index < list.len() => list[index] = value,
            "remove" if index < list.len() => {
                list.remove(index);
            }
            _ => bail!("增量索引或操作无效"),
        }
    }
    Ok(())
}

pub(crate) fn ordered(value: &Value) -> Vec<&Value> {
    if let Some(array) = value.as_array() {
        return array.iter().filter(|item| item.is_object()).collect();
    }
    if value["kind"] == "canonical" {
        return ordered(&value["history"]);
    }
    let mut seen = HashSet::new();
    value["islands"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|island| island["entries"].as_array().into_iter().flatten())
        .filter_map(|entry| entry["value"].as_str())
        .filter(|key| seen.insert(*key))
        .filter_map(|key| value["entitiesByKey"].get(key))
        .collect()
}

pub(crate) fn native_text(value: &Value) -> String {
    value.as_str().map(str::to_owned).unwrap_or_else(|| {
        native_text_parts(value, None)
            .collect::<Vec<_>>()
            .join("\n")
    })
}

pub(crate) fn native_user_text(value: &Value, record: &Value) -> String {
    match value.as_str() {
        Some(text) if is_internal_user_text(text, native_user_kinds(record, 1), 0) => String::new(),
        Some(text) => text.to_owned(),
        None => native_text_parts(value, Some(record))
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn native_user_kinds(record: &Value, part_count: usize) -> Option<&[Value]> {
    let metadata = record
        .get("internal_chat_message_metadata_passthrough")
        .or_else(|| record.get("internalChatMessageMetadataPassthrough"))?;
    metadata
        .get("content_item_kinds")
        .or_else(|| metadata.get("contentItemKinds"))
        .and_then(Value::as_array)
        .filter(|kinds| kinds.len() == part_count)
        .map(Vec::as_slice)
}

fn is_internal_user_text(text: &str, kinds: Option<&[Value]>, index: usize) -> bool {
    matches!(
        kinds.and_then(|kinds| kinds[index].as_str()),
        Some(
            "agents_md.instructions" | "environments.environment_context" | "goal.internal_context"
        )
    ) || is_goal_context(text)
}

fn native_text_parts<'a>(
    value: &'a Value,
    user_record: Option<&'a Value>,
) -> impl Iterator<Item = &'a str> {
    let parts = value.as_array();
    let kinds = user_record.and_then(|record| native_user_kinds(record, parts?.len()));
    parts
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(move |(index, item)| {
            if !matches!(
                item["type"].as_str(),
                Some("text" | "input_text" | "output_text")
            ) {
                return None;
            }
            let text = item["text"].as_str()?;
            (!(user_record.is_some() && is_internal_user_text(text, kinds, index))).then_some(text)
        })
}

fn is_goal_context(text: &str) -> bool {
    // Some desktop projections omit the original content kind.
    const CLOSE: &str = "</codex_internal_context>";
    text.trim()
        .strip_prefix("<codex_internal_context source=\"goal\">")
        .and_then(|text| text.strip_suffix(CLOSE))
        .is_some_and(|body| !body.contains(CLOSE))
}

fn user_message_input(item: &Value) -> &Value {
    item.get("content")
        .or_else(|| item.get("input"))
        .unwrap_or(&item["text"])
}

fn is_environment_context(text: &str) -> bool {
    text.trim_start().starts_with("<environment_context>")
}

fn turn_history(state: &Value) -> &Value {
    if state["turnHistory"]["kind"] == "canonical" {
        &state["turnHistory"]["history"]
    } else {
        &state["turns"]
    }
}

pub(super) fn project<'a>(id: Uuid, state: &'a Value, revision: u64, epoch: Uuid) -> View {
    use std::{borrow::Cow, collections::VecDeque};

    const MAX_ROWS: usize = 96;

    // Hold metadata and references until a row is known to be visible. An evicted
    // row should never consume the attachment budget or copy its expanded content.
    enum Text<'a> {
        Native(&'a Value),
        User(&'a Value, &'a Value),
        Owned(String),
    }
    impl<'a> Text<'a> {
        fn properties(&self) -> (bool, bool) {
            let (value, user_record) = match self {
                Self::Owned(text) => return (!text.is_empty(), is_environment_context(text)),
                Self::Native(value) => (*value, None),
                Self::User(value, record) => (*value, Some(*record)),
            };
            if let Some(text) = value.as_str() {
                return (
                    !text.is_empty(),
                    is_environment_context(text)
                        || user_record.is_some_and(|record| {
                            is_internal_user_text(text, native_user_kinds(record, 1), 0)
                        }),
                );
            }
            let mut count = 0;
            let mut present = false;
            let mut first = None;
            for text in native_text_parts(value, user_record) {
                count += 1;
                present |= !text.is_empty();
                if first.is_none() && !text.trim_start().is_empty() {
                    first = Some(text);
                }
            }
            // native_text separates parts with a newline, even empty parts.
            (
                present || count > 1,
                first.is_some_and(is_environment_context)
                    || (count == 0
                        && user_record.is_some()
                        && native_text_parts(value, None).next().is_some()),
            )
        }

        fn materialize(self) -> Cow<'a, str> {
            match self {
                Self::Owned(text) => Cow::Owned(text),
                Self::User(value, record) => value.as_str().map_or_else(
                    || Cow::Owned(native_user_text(value, record)),
                    Cow::Borrowed,
                ),
                Self::Native(value) => value
                    .as_str()
                    .map_or_else(|| Cow::Owned(native_text(value)), Cow::Borrowed),
            }
        }
    }

    struct Row<'a> {
        message: Value,
        text: Option<Text<'a>>,
        media: Option<&'a Value>,
        activity: Option<&'a Value>,
    }
    impl<'a> Row<'a> {
        fn event(message: Value) -> Self {
            Self {
                message,
                text: None,
                media: None,
                activity: None,
            }
        }
    }
    fn retain<'a>(
        rows: &mut VecDeque<(usize, Row<'a>)>,
        sequence: &mut usize,
        row: Row<'a>,
    ) -> usize {
        if let Some(index) = rows
            .iter()
            .position(|(_, old)| old.message["id"] == row.message["id"])
        {
            rows.remove(index);
        }
        if rows.len() == MAX_ROWS {
            rows.pop_front();
        }
        *sequence += 1;
        rows.push_back((*sequence, row));
        *sequence
    }

    let native_turns = ordered(turn_history(state));
    let active_turn = native_turns
        .iter()
        .rev()
        .copied()
        .find(|turn| turn["status"] == "inProgress");
    let active =
        active_turn.and_then(|turn| turn["turnId"].as_str().or_else(|| turn["id"].as_str()));
    let codex_activity = active_turn.map(|turn| {
        let items = ordered(&turn["items"]);
        let item = items.last().copied().unwrap_or(&Value::Null);
        let running = matches!(
            item["status"].as_str(),
            Some("inProgress" | "in_progress" | "running")
        );
        match item["type"].as_str() {
            Some("contextCompaction" | "ContextCompaction") if running => "compacting",
            Some("agentMessage") if item["phase"] == "final_answer" => "responding",
            _ if running && tool_activity::summary(item).is_some() => "tool",
            _ => "thinking",
        }
    });
    let pending = requests::pending(state);
    let items: Vec<_> = if pending.is_empty() {
        Vec::new()
    } else {
        native_turns
            .iter()
            .flat_map(|turn| ordered(&turn["items"]))
            .collect()
    };
    let mut budget = 2 * 1024 * 1024;
    let requests: Vec<_> = pending
        .iter()
        .map(|request| requests::normalize(request, &items))
        .chain(requests::asynchronous(&native_turns))
        .take(50)
        .take_while(|request| {
            let size = request.to_string().len();
            if size > budget {
                return false;
            }
            budget -= size;
            true
        })
        .collect();
    let runtime =
        state["threadRuntimeStatus"]["type"]
            .as_str()
            .unwrap_or(if active_turn.is_some() {
                "active"
            } else {
                "idle"
            });
    let mut rows = VecDeque::with_capacity(MAX_ROWS);
    let mut sequence = 0;
    let mut turns = Vec::new();
    let mut reply_turns = HashSet::new();
    for turn in native_turns
        .iter()
        .copied()
        .skip(native_turns.len().saturating_sub(128))
    {
        let Some(turn_id) = turn["turnId"].as_str().or_else(|| turn["id"].as_str()) else {
            continue;
        };
        let items = ordered(&turn["items"]);
        let request = turn["params"]["clientUserMessageId"].as_str();
        turns.push(Turn {
            id: turn_id.into(),
            request: request.map(str::to_owned),
            state: match turn["status"].as_str() {
                Some("completed") => "completed",
                Some("failed") => "failed",
                Some("interrupted" | "cancelled") => "interrupted",
                _ => "accepted",
            }
            .to_owned(),
        });
        let running = active == Some(turn_id);
        let started = running.then(|| turn["startedAt"].as_u64()).flatten();
        let duration = (!running).then(|| turn["durationMs"].as_u64()).flatten();
        let mut timing = tool_activity::turn_timing(turn_id, started, duration);
        let mut final_reply = None;
        {
            let mut push = |row: Row<'a>| {
                if row.message["role"] != "user"
                    && let Some(timing) = timing.take()
                {
                    retain(&mut rows, &mut sequence, Row::event(timing));
                }
                retain(&mut rows, &mut sequence, row)
            };
            let has_user_message = items.iter().any(|item| {
                if item["type"] != "userMessage" {
                    return false;
                }
                let (present, internal) = Text::User(user_message_input(item), item).properties();
                !internal && (present || !history_media::media(item).is_empty())
            });
            if !has_user_message {
                let params = &turn["params"];
                let input = &params["input"];
                let mut content = Text::User(input, params);
                let mut native_id = None;
                let trigger = &params["turnTrigger"];
                let app_continuation = matches!(
                    trigger.as_str(),
                    Some("app_tool_create_thread" | "app_tool_send_message")
                );
                let (present, internal) = content.properties();
                if (!present || internal) && (trigger.is_null() || app_continuation) {
                    let thread = id.to_string();
                    let delegated = items
                        .iter()
                        .filter(|item| item["type"] == "functionCallOutput")
                        .find_map(|item| {
                            delegated_input(item, &thread).map(|text| (text, item["id"].as_str()))
                        })
                        .or_else(|| {
                            app_continuation
                                .then(|| {
                                    delegated_input(&params["toolOutput"], &thread).map(|text| (text, None))
                                })
                                .flatten()
                        });
                    if let Some((input, item_id)) = delegated {
                        content = Text::Owned(input);
                        native_id = item_id;
                    }
                }
                let (present, internal) = content.properties();
                if !internal && (present || !history_media::media(input).is_empty()) {
                    push(Row {
                        message: json!({"id":format!("{turn_id}:input"),"role":"user","turnId":turn_id,
                            "clientMessageId":request,"nativeItemId":native_id}),
                        text: Some(content),
                        media: Some(input),
                        activity: None,
                    });
                }
            }
            for (index, item) in items.into_iter().enumerate() {
                let kind = item["type"].as_str().unwrap_or_default();
                if let Some(mut event) = tool_activity::timeline_event(
                    item,
                    &format!("{turn_id}:{index}"),
                    Some(turn_id),
                ) {
                    event["nativeItemId"] = item["id"].clone();
                    push(Row::event(event));
                    continue;
                }
                let summary = tool_activity::summary(item);
                let is_activity = summary.is_some();
                let (role, content) = match kind {
                    "userMessage" | "steeringUserMessage" => {
                        ("user", Text::User(user_message_input(item), item))
                    }
                    "agentMessage" => (
                        "assistant",
                        Text::Native(item.get("text").unwrap_or(&item["content"])),
                    ),
                    _ if is_activity => ("tool", Text::Owned(summary.unwrap())),
                    "imageView" => ("tool", Text::Native(&Value::Null)),
                    _ => ("assistant", Text::Native(&Value::Null)),
                };
                let (present, internal) = content.properties();
                if (role == "user" && internal)
                    || (!present && history_media::media(item).is_empty())
                {
                    continue;
                }
                let item_id = item["id"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{turn_id}:{index}"));
                let sequence = push(Row {
                    message: json!({
                        "id": item_id,"nativeItemId":item["id"],"role":role,"turnId":turn_id,
                        "phase":item["phase"],"clientMessageId":item["clientUserMessageId"].as_str()
                            .or_else(|| item["clientId"].as_str()).or_else(|| (kind == "userMessage").then_some(request).flatten()),
                    }),
                    text: Some(content),
                    media: Some(item),
                    activity: is_activity.then_some(item),
                });
                if role == "user" {
                    final_reply = None;
                } else if kind == "agentMessage"
                    && (item["phase"].is_null() || item["phase"] == "final_answer")
                {
                    final_reply = Some(sequence);
                }
            }
        }
        if let Some(timing) = timing {
            retain(&mut rows, &mut sequence, Row::event(timing));
        }
        if let Some(sequence) = final_reply
            && turn["status"] == "completed"
            && active != Some(turn_id)
        {
            if let Some((_, row)) = rows.iter_mut().find(|(index, _)| *index == sequence) {
                row.message["turnBoundary"] = json!(true);
            }
            reply_turns.insert(turn_id.to_owned());
        }
    }
    let mut expanded = HashMap::new();
    let mut activities = HashMap::new();
    let mut inline = HashMap::new();
    let mut inline_budget = 32 * 1024 * 1024;
    let mut messages: Vec<_> = rows
        .into_iter()
        .rev()
        .map(
            |(
                _,
                Row {
                    mut message,
                    text,
                    media,
                    activity,
                },
            )| {
                if let Some(content) = text {
                    let content = content.materialize();
                    let (content, explicit) = if message["role"] == "user" {
                        let (content, attachments) = message_attachment_text(&content);
                        (Cow::Owned(requests::display_reply(content)), attachments)
                    } else {
                        (content, Vec::new())
                    };
                    message["attachments"] = json!(history_media::attachments_from(
                        explicit,
                        media.map_or_else(Vec::new, history_media::media),
                        &mut inline,
                        &mut inline_budget,
                    ));
                    message["text"] = if content.len() > 12_000 {
                        let excerpt = json!(&content[..content.floor_char_boundary(12_000)]);
                        if content.len() <= 2 * 1024 * 1024 {
                            expanded.insert(
                                message["id"].as_str().unwrap_or_default().to_owned(),
                                content.into_owned(),
                            );
                            message["truncated"] = json!(true);
                        }
                        excerpt
                    } else {
                        json!(content)
                    };
                }
                if let Some(item) = activity {
                    let actions = tool_activity::action_kinds(item);
                    if !actions.is_empty() {
                        message["toolActions"] = json!(actions);
                    }
                    if let Some(details) = tool_activity::details(item) {
                        activities.insert(
                            message["id"].as_str().unwrap_or_default().to_owned(),
                            details,
                        );
                        message["deferred"] = json!(true);
                    }
                }
                message
            },
        )
        .collect();
    messages.reverse();
    let reason = if pending.is_empty() {
        None
    } else if requests.iter().any(|request| request["actionable"] == true) {
        Some("请先处理当前桌面请求")
    } else {
        Some("桌面正在等待交互，请在 Codex 中处理")
    };
    let native_goal = state.get("threadGoal");
    let mut controls = settings::permission(&state["latestThreadSettings"]);
    if let Some(revision) = native_goal.and_then(|goal| crate::codex_goal::snapshot_revision(goal, id)) {
        controls["goalRevision"] = json!(revision);
    }
    View {
        thread: json!({
            "id": id, "title": state["title"].as_str().unwrap_or("未命名会话"), "cwd": state["cwd"].as_str().unwrap_or(""),
            "updatedAt": state["updatedAt"].as_i64().unwrap_or(0), "revision": revision,
            "owner": true, "synchronized": true, "runtimeStatus": runtime, "activeTurnId": active, "codexActivity": codex_activity,
            "model": state["latestModel"], "reasoningEffort": state["latestReasoningEffort"],
            "serviceTier": state["latestThreadSettings"]["serviceTier"], "mode": state["latestCollaborationMode"]["mode"].as_str().unwrap_or("default"),
            "pendingRequests": pending.len(), "requests": requests,
            "controls":controls,
            "canSend": runtime == "idle" && active_turn.is_none() && pending.is_empty(), "canInterrupt": active.is_some(),
            "reason": reason,
        }),
        messages,
        app_tools: false,
        app_server: false,
        native_goal: native_goal.cloned(),
        expanded,
        activities,
        pending,
        inline: Arc::new(inline),
        reply_turns,
        turns,
        epoch,
        disabled_plugins: state["latestThreadSettings"]["disabledPluginIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|id| id.as_str().map(str::to_owned))
            .collect(),
    }
}

