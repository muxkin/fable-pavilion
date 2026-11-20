use super::*;

#[tokio::test]
async fn frame_limits_reject_oversized_headers_before_reading_a_body() {
    let frame_size = (MAX_FOLLOW_FRAME as u32 + 1).to_le_bytes();
    let error = follow_frame::read(&mut frame_size.as_slice(), MAX_FOLLOW_FRAME)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "Codex IPC 消息大小无效");

    let tools_size = (MAX_FRAME as u32 + 1).to_le_bytes();
    let error = read_frame(&mut tools_size.as_slice()).await.unwrap_err();
    assert_eq!(error.to_string(), "Codex IPC 消息大小无效");
}

#[test]
fn follows_compatible_streams_regardless_of_broadcast_version() -> Result<()> {
    let id = Uuid::new_v4();
    for version in [11, 13, 42] {
        let (updates, view) = watch::channel(None);
        let mut follower = Follower {
            id,
            owner: "desktop".into(),
            revision: None,
            state: Value::Null,
            updates: &updates,
            epoch: Uuid::new_v4(),
            queue: None,
            snapshot_deadline: Instant::now() + SNAPSHOT_TIMEOUT,
        };
        let turn = json!({"turnId":"turn","status":"completed","items":[
            {"id":"reply","type":"agentMessage","text":"上一轮回复"}
        ]});
        let mut state = json!({"id":id,"title":"原会话","turns":[turn]});
        if version != 11 {
            state["turns"] = json!([]);
            state["turnHistory"] = json!({"kind":"canonical","history":{
                "islands":[{"entries":[{"value":"turn:turn"}]}],
                "entitiesByKey":{"turn:turn":turn}
            }});
            state["threadRuntimeStatus"] = json!({"type":"idle"});
            state["requests"] = json!([]);
        }
        let mut event = json!({
            "type":"broadcast","sourceClientId":"desktop",
            "method":"thread-stream-state-changed","version":version,
            "params":{"hostId":"local","conversationId":id,"change":{
                "type":"snapshot","revision":5,"conversationState":state
            }}
        });
        follower.receive(event.clone())?;
        assert!(view.borrow().as_ref().unwrap().is_open());
        assert_eq!(
            view.borrow().as_ref().unwrap().messages[0]["text"],
            "上一轮回复"
        );
        event["params"]["change"] = json!({
            "type":"patches","baseRevision":5,"revision":6,
            "patches":[{"op":"replace","path":["title"],"value":"已同步"}]
        });
        follower.receive(event)?;
        let view = view.borrow();
        assert_eq!(view.as_ref().unwrap().thread["title"], "已同步");
        assert_eq!(view.as_ref().unwrap().thread["revision"], 6);
    }
    Ok(())
}

#[test]
fn incompatible_stream_data_cannot_publish_or_skip_revision_checks() -> Result<()> {
    let id = Uuid::new_v4();
    let (updates, view) = watch::channel(None);
    let mut follower = Follower {
        id,
        owner: "desktop".into(),
        revision: None,
        state: Value::Null,
        updates: &updates,
        epoch: Uuid::new_v4(),
        queue: None,
        snapshot_deadline: Instant::now() + SNAPSHOT_TIMEOUT,
    };
    let event = |change| {
        json!({
            "type":"broadcast","sourceClientId":"desktop",
            "method":"thread-stream-state-changed","version":42,
            "params":{"hostId":"local","conversationId":id,"change":change}
        })
    };
    let snapshot = |revision| {
        event(json!({"type":"snapshot","revision":revision,
            "conversationState":{"id":id,"title":"原会话","turns":[]}
        }))
    };
    let bad = event(json!({"type":"snapshot","revision":6,
        "conversationState":{"id":id,"turns":{"format":"unknown"}}
    }));
    assert!(matches!(follower.receive(bad.clone())?, Change::None));
    assert!(view.borrow().is_none());

    follower.receive(snapshot(5))?;
    assert!(matches!(follower.receive(bad.clone())?, Change::Follow));
    let deadline = follower.snapshot_deadline;
    assert!(matches!(follower.receive(bad)?, Change::None));
    assert_eq!(follower.snapshot_deadline, deadline);
    follower.receive(snapshot(4))?;
    assert!(view.borrow().is_none());
    follower.receive(snapshot(5))?;
    let shared_view = view.borrow().as_ref().unwrap().clone();

    let bad_patch = event(json!({"type":"patches","baseRevision":5,"revision":6,
        "patches":[{"op":"replace","path":["title"],"value":"不应显示"},
                   {"op":"replace","path":["turns"],"value":false}]
    }));
    assert!(matches!(follower.receive(bad_patch)?, Change::Follow));
    assert!(view.borrow().is_none());
    assert_eq!(shared_view.thread["title"], "原会话");
    assert_eq!(follower.revision, Some(5));
    follower.receive(snapshot(7))?;

    let wrong_base = event(json!({"type":"patches","baseRevision":6,"revision":8,
        "patches":[{"op":"replace","path":["title"],"value":"也不应显示"}]
    }));
    assert!(matches!(follower.receive(wrong_base)?, Change::Follow));
    assert!(view.borrow().is_none());
    follower.receive(snapshot(9))?;

    let missing_revision = event(json!({"type":"snapshot",
        "conversationState":{"id":id,"turns":[]}
    }));
    assert!(matches!(
        follower.receive(missing_revision)?,
        Change::Follow
    ));
    assert!(view.borrow().is_none());
    Ok(())
}

#[test]
fn retained_rows_keep_the_last_duplicate_and_defer_unicode_text() {
    let duplicate_text = "测试".repeat(2_400);
    let mut items: Vec<_> = (0..100)
        .map(
            |index| json!({"type":"agentMessage","id":format!("row-{index}"),"text":"fixture"}),
        )
        .collect();
    items.push(json!({
        "type":"agentMessage","id":"row-5","phase":"final_answer",
        "content":[{"type":"text","text":duplicate_text}],
    }));
    let state = json!({"turns":[{"turnId":"recent","status":"completed","items":items}]});
    let view = project(Uuid::new_v4(), &state, 1, Uuid::new_v4());
    assert_eq!(view.messages.len(), 96);
    assert_eq!(view.messages[0]["id"], "row-4");
    let last = view.messages.last().unwrap();
    assert_eq!(last["id"], "row-5");
    assert_eq!(last["text"].as_str().unwrap().len(), 12_000);
    assert_eq!(last["truncated"], true);
    assert_eq!(last["turnBoundary"], true);
    assert_eq!(view.expanded["row-5"], duplicate_text);
    assert!(view.reply_turns.contains("recent"));
}

#[test]
fn evicted_media_cannot_displace_the_live_inline_attachment() {
    let older = format!("data:image/png;base64,{}", "A".repeat(17 * 1024 * 1024));
    let recent = format!("data:image/png;base64,{}", "B".repeat(17 * 1024 * 1024));
    let recent_len = recent.len();
    let mut items = vec![json!({
        "type":"agentMessage","id":"older-image","text":"older",
        "content":[{"type":"image_url","image_url":older}],
    })];
    items.extend((0..95).map(
        |index| json!({"type":"agentMessage","id":format!("row-{index}"),"text":"fixture"}),
    ));
    items.push(json!({
        "type":"agentMessage","id":"recent-image","text":"recent",
        "content":[{"type":"image_url","image_url":recent}],
    }));
    let state = json!({"turns":[{"turnId":"images","status":"completed","items":items}]});
    let view = project(Uuid::new_v4(), &state, 1, Uuid::new_v4());
    assert_eq!(view.messages.len(), 96);
    assert_eq!(view.inline.len(), 1);
    let latest = view.messages.last().unwrap();
    assert_eq!(latest["id"], "recent-image");
    let path = latest["attachments"][0]["path"].as_str().unwrap();
    assert_eq!(view.inline[path].len(), recent_len);
}

#[test]
fn keeps_completed_reply_authority_when_late_tools_evict_the_display_row() {
    let mut items = vec![
        json!({"type":"agentMessage","id":"forkable-reply","phase":"final_answer","text":"已完成"}),
    ];
    items.extend((0..100).map(|index| {
        json!({
            "type":"commandExecution","id":format!("tool-{index}"),"command":"printf fixture",
            "status":"completed","commandActions":[{"type":"read"}]
        })
    }));
    let view = project(
        Uuid::new_v4(),
        &json!({"turns":[
            {"turnId":"done","status":"completed","items":items},
            {"turnId":"not-done","status":"inProgress","items":[
                {"type":"agentMessage","id":"running-reply","phase":"final_answer","text":"未完成"}
            ]}
        ]}),
        1,
        Uuid::new_v4(),
    );
    assert!(view.reply_turns.contains("done"));
    assert!(!view.reply_turns.contains("not-done"));
    assert!(
        view.messages
            .iter()
            .all(|message| message["id"] != "forkable-reply")
    );
    assert!(
        view.messages
            .iter()
            .any(|message| message["toolActions"] == json!(["read-file"]))
    );
}

#[test]
fn projects_delegated_opening_as_user_and_keeps_its_identity() {
    let id = Uuid::new_v4();
    let epoch = Uuid::new_v4();
    let output = "<codex_delegation>\n  <source_thread_id>source</source_thread_id>\n  <input>检查 &lt;fixture&gt; &amp; 继续</input>\n</codex_delegation>";
    let mut state = json!({"turns":[{
        "turnId":"turn",
        "status":"inProgress",
        "params":{
            "turnTrigger":"app_tool_create_thread","clientUserMessageId":"request","input":[],
            "toolOutput":{"namespace":"codex_app","name":"create_thread","output":output}
        },
        "items":[{"type":"agentMessage","id":"reply","text":"处理中","phase":"commentary"}]
    }]});
    let early = project(id, &state, 1, epoch);
    assert_eq!(early.messages[0]["role"], "user");
    assert_eq!(early.messages[0]["text"], "检查 <fixture> & 继续");
    assert_eq!(early.messages[0]["clientMessageId"], "request");
    assert!(early.messages[0]["nativeItemId"].is_null());
    assert_eq!(early.messages[1]["nativeItemId"], "reply");

    state["turns"][0]["items"].as_array_mut().unwrap().insert(
        0,
        json!({"type":"functionCallOutput","id":"delegated-item","namespace":"codex_app",
            "name":"create_thread","output":output}),
    );
    let updated = project(id, &state, 2, epoch);
    assert_eq!(updated.messages[0]["id"], early.messages[0]["id"]);
    assert_eq!(updated.messages[0]["nativeItemId"], "delegated-item");
    assert_eq!(
        updated
            .messages
            .iter()
            .filter(|message| message["role"] == "user")
            .count(),
        1
    );

    state["turns"][0]["params"]["toolOutput"] = Value::Null;
    state["turns"][0]["params"]["turnTrigger"] = Value::Null;
    let replayed = project(id, &state, 3, epoch);
    assert_eq!(replayed.messages[0]["nativeItemId"], "delegated-item");
    state["turns"][0]["params"]["turnTrigger"] = json!("other_trigger");
    let unrelated = project(id, &state, 4, epoch);
    assert!(
        unrelated
            .messages
            .iter()
            .all(|message| message["role"] != "user")
    );
    state["turns"][0]["params"]["turnTrigger"] = Value::Null;
    state["turns"][0]["items"][0]["namespace"] = json!("other_tools");
    let untrusted = project(id, &state, 5, epoch);
    assert!(
        untrusted
            .messages
            .iter()
            .all(|message| message["role"] != "user")
    );
}

#[test]
fn input_fallback_is_retained_when_user_item_is_only_environment_context() {
    let state = json!({"turns":[{
        "turnId":"turn",
        "status":"inProgress",
        "params":{"input":[{"type":"text","text":"首条消息"}]},
        "items":[
            {"type":"userMessage","id":"context","content":[{"type":"text","text":"<environment_context>context</environment_context>"}]},
            {"type":"agentMessage","id":"reply","text":"收到"}
        ]
    }]});
    let view = project(Uuid::new_v4(), &state, 1, Uuid::new_v4());
    assert_eq!(view.messages.len(), 2);
    assert_eq!(view.messages[0]["role"], "user");
    assert_eq!(view.messages[0]["text"], "首条消息");
}

#[test]
fn goal_context_is_removed_from_live_user_items_and_opening_input() {
    let goal =
        "<codex_internal_context source=\"goal\">Fixture context</codex_internal_context>";
    let state = json!({"turns":[
        {"turnId":"first","params":{"input":[{"type":"text","text":"Original user input."}]},
         "items":[
            {"type":"userMessage","id":"hidden-text","content":goal},
            {"type":"userMessage","id":"hidden-kind","content":"Typed context.",
             "internalChatMessageMetadataPassthrough":{"contentItemKinds":["goal.internal_context"]}},
            {"type":"agentMessage","id":"answer","text":"Visible answer."}
         ]},
        {"turnId":"second","params":{"input":[{"type":"text","text":goal}]},
         "items":[
            {"type":"steeringUserMessage","id":"steer","content":[
                {"type":"text","text":goal},{"type":"text","text":"Visible follow-up."}]}
         ]}
    ]});
    let view = project(Uuid::new_v4(), &state, 1, Uuid::new_v4());
    let messages: Vec<_> = view
        .messages
        .iter()
        .map(|message| &message["text"])
        .collect();
    assert_eq!(
        messages,
        [
            "Original user input.",
            "Visible answer.",
            "Visible follow-up."
        ]
    );
}
