use super::*;

#[test]
fn model_catalog_separates_display_names_public_ids_and_native_transport_enums() {
    let catalog = native_models(&json!({"clientModelConfigs":[
        {"modelId":"gemini-4-neon-high","label":"Gemini 4 Neon (High)","modelOrAlias":{"model":"MODEL_PLACEHOLDER_M532"}},
        {"modelId":"missing-label","modelOrAlias":{"model":"MODEL_HIDDEN"}},
        {"modelId":"internal-label","label":"MODEL_PLACEHOLDER_M999","modelOrAlias":{"model":"MODEL_HIDDEN"}},
        {"modelId":"gemini-4-neon-high","label":"Duplicate","modelOrAlias":{"model":"MODEL_OTHER"}}
    ]}));
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].id, "gemini-4-neon-high");
    assert_eq!(catalog[0].name, "Gemini 4 Neon (High)");
    assert_eq!(catalog[0].native, "MODEL_PLACEHOLDER_M532");
}

#[test]
fn current_model_uses_latest_native_generator_metadata_without_prompt_content() {
    let steps =
        vec![json!({"userInput":{"userConfig":{"plannerConfig":{"planModel":"MODEL_OLD"}}}})];
    let trajectory = json!({"generatorMetadata":[
        {"plannerConfig":{"planModel":"MODEL_OLDER"}},
        {"plannerConfig":{"planModel":"MODEL_PLACEHOLDER_M532"},"chatModel":{"systemPrompt":"private"}},
        {"unrelated":"private"}
    ]});
    assert_eq!(
        current_model(&trajectory, &steps),
        Some("MODEL_PLACEHOLDER_M532")
    );
    assert_eq!(current_model(&Value::Null, &steps), Some("MODEL_OLD"));
    assert_eq!(
        current_model(
            &json!({"generatorMetadata":[{"chatModel":{"model":"MODEL_CHAT"}}]}),
            &[]
        ),
        Some("MODEL_CHAT")
    );
    assert_eq!(
        current_model(
            &json!({"generatorMetadata":[{"plannerConfig":{"modelName":"public-id"}}]}),
            &[]
        ),
        Some("public-id")
    );
    assert_eq!(
        current_model(
            &Value::Null,
            &[json!({"metadata":{"generatorModel":"MODEL_STEP_META"}})]
        ),
        Some("MODEL_STEP_META")
    );
    assert_eq!(
        current_model(
            &Value::Null,
            &[json!({"metadata":{"requestedModel":{"model":"MODEL_STEP_REQ"}}})]
        ),
        Some("MODEL_STEP_REQ")
    );
    assert_eq!(current_model(&Value::Null, &[]), None);
}

fn quota_bucket(id: &str, window: &str, remaining: Value) -> Value {
    json!({"bucketId":id,"displayName":format!("{id} remaining"),"window":window,
        "remainingFraction":remaining,"resetTime":"2026-11-19T11:09:35Z",
        "description":"private reset description"})
}

fn quota_summary(groups: Value) -> Value {
    json!({"response":{"groups":groups,"description":"private account description"}})
}

#[test]
fn quotas_preserve_native_groups_windows_and_explicit_resets() {
    let summary = quota_summary(json!([
        {"displayName":"Gemini Models","description":"private group description","buckets":[
            quota_bucket("gemini-weekly", "weekly", json!(0.962743)),
            quota_bucket("gemini-5h", "5h", json!(0.89123)),
        ]},
        {"displayName":"Claude and GPT models","buckets":[
            quota_bucket("3p-weekly", "weekly", json!(1)),
            quota_bucket("3p-5h", "5h", json!(0)),
        ]},
        {"displayName":"Gemini 4 Argon","buckets":[
            {"bucketId":"argon-weekly","window":"weekly","remainingFraction":1,
                "resetTime":"2026-11-19T11:09:35Z"},
        ]},
    ]));
    let usage = quota_usage(&summary);
    assert_eq!(usage["available"], true);
    assert_eq!(usage["canReset"], false);
    let groups = usage["buckets"].as_array().unwrap();
    assert_eq!(groups.len(), 3);
    assert_eq!(groups[0]["name"], "Gemini Models");
    assert_eq!(groups[1]["name"], "Claude and GPT models");
    assert_eq!(groups[2]["name"], "Gemini 4 Argon");
    assert_eq!(groups[0]["windows"].as_array().unwrap().len(), 2);
    assert_eq!(groups[0]["windows"][0]["label"], "每周");
    assert_eq!(groups[0]["windows"][0]["usedPercent"], 3.7257);
    assert_eq!(groups[0]["windows"][0]["durationMinutes"], 10080);
    assert_eq!(groups[0]["windows"][1]["label"], "5 小时");
    assert_eq!(groups[0]["windows"][1]["usedPercent"], 10.877);
    assert_eq!(groups[0]["windows"][1]["durationMinutes"], 300);
    assert_eq!(groups[1]["windows"][1]["usedPercent"], 100.0);
    assert_eq!(
        groups[0]["windows"][0]["resetsAt"],
        timestamp_ms("2026-11-19T11:09:35Z")
    );
    assert!(groups[2]["windows"][0].get("resetsAt").is_none());
    assert!(usage.get("credits").is_none());
    assert!(!usage.to_string().contains("private"));
}

#[test]
fn quotas_require_the_explicit_fraction_oneof_and_skip_disabled_windows() {
    let summary = quota_summary(json!([{"displayName":"Fixture","buckets":[
        quota_bucket("zero", "5h", json!(0)),
        {"bucketId":"missing","window":"weekly","resetTime":"2026-11-19T11:09:35Z"},
        {"bucketId":"amount","remainingAmount":"50","window":"weekly"},
        {"bucketId":"disabled","remainingFraction":0.5,"disabled":true,"window":"weekly"},
        {"bucketId":"empty"},
    ]}]));
    let usage = quota_usage(&summary);
    let windows = usage["buckets"][0]["windows"].as_array().unwrap();
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0]["usedPercent"], 100.0);
    for missing in [
        Value::Null,
        json!({"response":{"groups":[]}}),
        quota_summary(json!([{"displayName":"None","buckets":[{"bucketId":"none"}]}])),
        // Per-model quotas are not the App's shared usage pools.
        json!({"userStatus":{"cascadeModelConfigData":{"clientModelConfigs":[{
            "modelId":"wrong-source","quotaInfo":{"remainingFraction":1}
        }]}}}),
    ] {
        assert_eq!(quota_usage(&missing)["available"], false);
        assert_eq!(quota_usage(&missing)["buckets"], json!([]));
    }
}

#[test]
fn quotas_reject_invalid_fractions_and_reset_dates() {
    let invalid = quota_summary(json!([{"displayName":"Invalid","buckets":[
        quota_bucket("negative", "5h", json!(-0.1)),
        quota_bucket("over-one", "5h", json!(1.1)),
        quota_bucket("not-number", "5h", json!("NaN")),
        quota_bucket("null", "5h", Value::Null),
    ]}]));
    assert_eq!(quota_usage(&invalid)["available"], false);
    for reset in [
        "2026-02-30T11:09:35Z",
        "not a timestamp",
        "2026-11-19T24:00:00Z",
        "2026-11-19T12:00:00.badZ",
        "2026-11-19T12:00:00.Z",
        "2026-11-19X12:00:00Z",
    ] {
        assert!(quota_reset_time(&json!(reset)).is_none());
    }
    let usage = quota_usage(&quota_summary(json!([{"displayName":"Valid","buckets":[{
        "bucketId":"valid","remainingFraction":0.58,"window":"5h","resetTime":"invalid"
    }]}])));
    assert_eq!(usage["buckets"][0]["windows"][0]["usedPercent"], 42.0);
    assert!(usage["buckets"][0]["windows"][0].get("resetsAt").is_none());
}

#[test]
fn quotas_keep_native_order_and_stable_ids_without_guessing_unknown_durations() {
    let a = quota_bucket("a", "weekly", json!(0.5));
    let b = quota_bucket("b", "5h", json!(0.5));
    let one = quota_usage(&quota_summary(
        json!([{"displayName":"One","buckets":[a.clone(),b.clone()]}]),
    ));
    let two = quota_usage(&quota_summary(
        json!([{"displayName":"Renamed","buckets":[b,a]}]),
    ));
    assert_eq!(one["buckets"][0]["id"], two["buckets"][0]["id"]);
    assert_eq!(two["buckets"][0]["windows"][0]["durationMinutes"], 300);
    let unknown = quota_usage(&quota_summary(json!([{"displayName":"Unknown","buckets":[
        quota_bucket("special", "special", json!(1)), quota_bucket("normalized", " 5H ", json!(1))
    ]}])));
    assert_eq!(
        unknown["buckets"][0]["windows"][0]["label"],
        "special remaining"
    );
    assert!(
        unknown["buckets"][0]["windows"][0]
            .get("durationMinutes")
            .is_none()
    );
    assert_eq!(unknown["buckets"][0]["windows"][1]["durationMinutes"], 300);
    assert_eq!(
        quota_usage(
            &json!({"response":{"buckets":[quota_bucket("flat", "weekly", json!(1))]}})
        )["available"],
        false
    );
}

#[test]
fn quotas_deduplicate_native_ids_and_bound_groups_and_windows() {
    let windows: Vec<_> = (0..40)
        .map(|i| quota_bucket(&format!("w{i}"), "5h", json!(1)))
        .collect();
    let groups: Vec<_> = (0..150)
        .map(|i| {
            json!({"displayName":format!("G{i}"),"buckets":[
                quota_bucket(&format!("g{i}"), "weekly", json!(1))
            ]})
        })
        .collect();
    assert_eq!(
        quota_usage(&quota_summary(json!(groups)))["buckets"]
            .as_array()
            .unwrap()
            .len(),
        128
    );
    let usage = quota_usage(&quota_summary(
        json!([{"displayName":"Many","buckets":windows}]),
    ));
    assert_eq!(usage["buckets"][0]["windows"].as_array().unwrap().len(), 32);
    let group = json!({"displayName":"Duplicate","buckets":[
        quota_bucket("same", "5h", json!(0.5)),quota_bucket("same", "5h", json!(0.2))
    ]});
    let usage = quota_usage(&quota_summary(json!([group.clone(), group])));
    assert_eq!(usage["buckets"].as_array().unwrap().len(), 1);
    assert_eq!(usage["buckets"][0]["windows"].as_array().unwrap().len(), 1);
}

#[test]
fn maps_history_without_internal_reasoning_or_transport_secrets() {
    let steps = vec![
        json!({"userInput":{"items":[{"text":"hello"}],"clientMessageId":"m"}}),
        json!({"plannerResponse":{"response":"answer","thinking":"private","signature":"secret"}}),
        json!({"type":"CORTEX_STEP_TYPE_RUN_COMMAND","runCommand":{"commandLine":"pwd","combinedOutput":{"full":"/work"}}}),
    ];
    let result = messages(&steps, 0, false);
    assert_eq!(result[0]["text"], "hello");
    assert_eq!(result[1]["text"], "answer");
    assert_eq!(result[2]["output"], "/work");
    assert!(!json!(result).to_string().contains("private"));
    assert!(!json!(result).to_string().contains("secret"));
}
#[test]
fn timestamps_and_file_uris() {
    assert_eq!(timestamp_ms("1970-01-01T00:00:00Z"), 0);
    assert_eq!(timestamp_ms("2026-11-19T06:00:00.123456Z"), 1795068000123);
    let value = summary_value(
        "id",
        &json!({"summary":"title","workspaces":[{"workspaceFolderAbsoluteUri":"file:///tmp/a%20b"}],"lastModifiedTime":"1970-01-01T00:00:01Z"}),
    );
    assert_eq!(value["updatedAt"], 1000);
    if cfg!(unix) {
        assert_eq!(value["cwd"], "/tmp/a b");
    }
}

#[test]
fn enriches_native_project_identity_without_inferring_membership_from_folder_names() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Registered Project");
    let uri = url::Url::from_file_path(&path).unwrap().to_string();
    let projects = project_values(&json!({"projects":[{
        "id":"registered-project","name":"Registered Project",
        "projectResources":{"resources":[{"gitFolder":{"folderUri":uri}}]},
        "permissionGrants":{"private":"do-not-forward"},
        "sidecar":{"sidecarId":"do-not-forward"}
    }]}))
    .unwrap();
    assert_eq!(
        projects,
        json!([{
            "id":"registered-project","name":"Registered Project","path":path.to_string_lossy()
        }])
    );
    let mut summary = json!({"summary":"Existing conversation","trajectoryMetadata":{
        "projectId":"registered-project",
        "workspaces":[{"workspaceFolderAbsoluteUri":uri}]
    }});
    let value = summary_with_projects("thread", &summary, &projects);
    assert_eq!(value["projectId"], "registered-project");
    assert_eq!(value["projectName"], "Registered Project");
    assert_eq!(value["cwd"], json!(path.to_string_lossy()));

    summary["trajectoryMetadata"]["projectId"] = Value::Null;
    let unassigned = summary_with_projects("thread", &summary, &projects);
    assert!(unassigned["projectId"].is_null());
    assert!(unassigned["projectName"].is_null());
    assert!(project_values(&json!({})).unwrap() == json!([]));
    assert!(project_values(&json!({"projects":{}})).is_err());

    let encoded_uri = "file:///C:/Users/RUNNER%7E1/AppData/Local/Temp/project";
    let uris = project_workspace_uris(&json!({"projects":[{
        "id":"win-project","name":"Win",
        "projectResources":{"resources":[{"gitFolder":{"folderUri":encoded_uri}}]}
    }]}));
    assert_eq!(uris.get("win-project"), Some(&vec![json!(encoded_uri)]));
}

#[tokio::test]
async fn creation_projects_reuse_registered_catalog_and_include_its_native_resource_path() {
    let root = tempfile::tempdir().unwrap();
    let backend = Backend::from_config(
        "project-fixture".into(),
        "Fixture".into(),
        &json!({"home":root.path()}),
        true,
        &Value::Null,
    )
    .unwrap();
    let projects = json!([{"id":"native-project","name":"Project","path":"/fixture/project"}]);
    *backend.project_catalog.lock().await = Some((std::time::Instant::now(), projects.clone()));
    let result = Adapter::read(
        &backend,
        "creation.projects",
        &json!({"id":"new"}),
        &json!({}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result, json!({"projects":projects}));
    assert!(!root.path().join("daemon").exists());
}

#[test]
fn rejects_unsupported_selections_and_invalid_ids() {
    let backend = Backend::from_config(
        "local".into(),
        "Test".into(),
        &json!({}),
        false,
        &Value::Null,
    )
    .unwrap();
    assert!(backend.validate_selection(&["skill".into()], &[]).is_err());
    assert!(backend.validate_selection(&[], &[]).is_ok());
    assert!(valid_id("../../bad").is_err());
    assert!(offset(&json!({"cursor":"11"}), 10).is_err());
}

#[test]
fn skills_use_native_scope_items_and_opaque_conversation_bound_ids() {
    let info = json!({"name":"fixture-skill","type":"SLASH_COMMAND_TYPE_SKILL",
        "definitionPath":"file:///fixture/skill/SKILL.md","modelFacingText":"private native instruction"});
    let data = json!({"commands":[{"info":{"name":"help","type":"SLASH_COMMAND_TYPE_SYSTEM"}},
        {"info":info,"title":"Fixture skill","description":"Fixture description"}]});
    let catalog = skill_catalog("thread-a", &json!(["file:///workspace-a"]), &data).unwrap();
    assert_eq!(catalog.len(), 1);
    let public = catalog[0].choice.to_string();
    assert!(!public.contains("private native instruction"));
    assert!(!public.contains("SKILL.md"));
    assert!(catalog[0].choice["sourceKind"].is_null());
    let selected = selected_skills(&catalog, &[catalog[0].id.clone()]).unwrap();
    assert_eq!(
        selected,
        vec![json!({"item":{"slashCommand":{"info":info,"argumentValues":{}}}})]
    );
    let other = skill_catalog("thread-b", &json!(["file:///workspace-a"]), &data).unwrap();
    assert!(selected_skills(&other, &[catalog[0].id.clone()]).is_err());
    assert!(selected_skills(&[], &[catalog[0].id.clone()]).is_err());
    let mut plugin = data.clone();
    plugin["commands"][1]["info"]["plugin"] =
        json!({"name":"fixture-plugin","displayName":"Fixture plugin"});
    let plugin = skill_catalog("thread-a", &json!([]), &plugin).unwrap();
    assert_eq!(plugin[0].choice["sourceKind"], "plugin");
    assert_eq!(plugin[0].choice["source"], "Fixture plugin");
}

#[test]
fn reconciles_only_correlated_requests_with_terminal_evidence() {
    let request = Uuid::new_v4();
    let mut data = json!({"status":"CASCADE_RUN_STATUS_IDLE","trajectory":{
        "steps":[{"metadata":{"executionId":"turn"},"userInput":{"clientMessageId":request}}]
    }});
    // An idle snapshot alone does not prove this particular request finished.
    let accepted = observations(&data);
    assert_eq!(accepted.len(), 1);
    assert_eq!(accepted[0].request, Some(request));
    assert_eq!(accepted[0].state, "accepted");
    data["trajectory"]["executorMetadatas"] = json!([{"executionId":"turn","terminationReason":"EXECUTOR_TERMINATION_REASON_USER_CANCELED"}]);
    let interrupted = observations(&data);
    assert!(
        interrupted.iter().any(|o| o.request == Some(request)
            && o.turn == "turn"
            && o.state == "interrupted")
    );
    assert!(
        interrupted
            .iter()
            .any(|o| o.request.is_none() && o.turn == "turn" && o.state == "interrupted")
    );
    data["trajectory"]["executorMetadatas"][0]["terminationReason"] =
        json!("EXECUTOR_TERMINATION_REASON_CHAINED");
    assert_eq!(observations(&data)[0].state, "accepted");
}

#[test]
fn subscription_fingerprint_ignores_only_revision() {
    let mut view = View {
        thread: json!({"id":"thread","revision":1,"canSend":true}),
        messages: vec![json!({"id":"message","text":"hello"})].into(),
        streamed: None,
        observations: Vec::new().into(),
        #[cfg(feature = "official-plugins")]
        image_limits: Value::Null,
        #[cfg(feature = "official-plugins")]
        continued_questions: Value::Null,
        plugin_epoch: None,
    };
    let first = view_fingerprint(&view);
    view.thread["revision"] = json!(99);
    assert_eq!(view_fingerprint(&view), first);
    view.thread["canSend"] = json!(false);
    assert_ne!(view_fingerprint(&view), first);
}

#[tokio::test]
async fn readonly_rejects_writes_before_dispatch() {
    let fixture = tempfile::tempdir().unwrap();
    let backend = Backend::from_config(
        "read".into(),
        "Read".into(),
        &json!({"home":fixture.path().join("missing-antigravity-home")}),
        true,
        &Value::Null,
    )
    .unwrap();
    let result = Adapter::write(
        &backend,
        "new",
        Uuid::new_v4(),
        Write::Create {
            title: None,
            prompt: "hello".into(),
            project: Some("project".into()),
            settings: Default::default(),
            files: Vec::new(),
            skills: Vec::new(),
            plugin_ids: Vec::new(),
        },
        None,
        &|_| panic!("read-only write must not create a thread"),
    )
    .await;
    assert!(matches!(result, Delivery::Rejected(_)));
    assert_eq!(backend.id(), "read");
    let info = backend.info().await;
    assert_eq!(info["presentation"]["creation"]["empty"], true);
    assert_eq!(info["id"], "read");
}

#[test]
fn observations_keep_newest_requests_in_long_histories() {
    let mut steps = Vec::new();
    let mut metadata = Vec::new();
    for i in 1..=1200 {
        let request = Uuid::from_u128(i);
        let turn = format!("turn-{i}");
        steps.push(
            json!({"metadata":{"executionId":turn},"userInput":{"clientMessageId":request}}),
        );
        metadata.push(json!({"executionId":turn,"terminationReason":"EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL"}));
    }
    let result =
        observations(&json!({"trajectory":{"steps":steps,"executorMetadatas":metadata}}));
    assert!(result.len() <= 1000);
    assert_eq!(result[0].request, Some(Uuid::from_u128(1200)));
    assert_eq!(result[0].state, "completed");
    assert!(
        result
            .iter()
            .any(|o| o.request.is_none() && o.turn == "turn-1200")
    );
}

#[test]
fn resolved_and_terminal_interactions_do_not_block_sending() {
    let request = json!({"askQuestion":{"questions":[{"question":"Choose"}]}});
    let mut step =
        json!({"status":"CORTEX_STEP_STATUS_WAITING","requestedInteraction":request});
    assert!(pending_interaction(&step));
    step["completedInteractions"] =
        json!([{"request":request,"response":{"askQuestion":{"responses":[]}}}]);
    assert!(!pending_interaction(&step));
    step["completedInteractions"] = json!([]);
    for terminal in ["CORTEX_STEP_STATUS_DONE", "CORTEX_STEP_STATUS_HALTED"] {
        step["status"] = json!(terminal);
        assert!(!pending_interaction(&step));
    }
}

#[test]
fn bounds_escaped_output_and_allows_single_message_expansion() {
    let steps = vec![json!({"type":"CORTEX_STEP_TYPE_RUN_COMMAND","runCommand":{
        "commandLine":"long output","combinedOutput":{"full":"\u{0000}".repeat(20_000)}
    }})];
    let normal = messages(&steps, 0, false);
    assert_eq!(normal[0]["truncated"], true);
    assert!(serde_json::to_vec(&normal[0]).unwrap().len() < 12_500);
    let full = messages(&steps, 0, true);
    assert_eq!(full[0]["output"].as_str().unwrap().len(), 20_000);
    assert_ne!(full[0]["truncated"], true);
}

#[tokio::test]
async fn handshake_availability_does_not_depend_on_reported_version() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let mut part = [0; 1024];
                let count = socket.read(&mut part).await.unwrap();
                assert!(count > 0 && request.len() < 8192);
                request.extend_from_slice(&part[..count]);
            }
            assert!(
                request.starts_with(format!("POST /{SERVICE}/GetCapabilities ").as_bytes())
            );
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
        }
    });
    let home = tempfile::tempdir().unwrap();
    fs::create_dir(home.path().join("daemon")).unwrap();
    fs::write(home.path().join(format!("daemon/hub_{port}.json")), json!({
        "pid":std::process::id(),"httpPort":port,"csrfToken":"synthetic-test-token","lsVersion":"test-next-release"
    }).to_string()).unwrap();
    let backend = Backend::from_config(
        "fixture".into(),
        "Fixture".into(),
        &json!({"home":home.path()}),
        false,
        &Value::Null,
    )
    .unwrap();
    let info = backend.info().await;
    assert_eq!(info["connected"], true);
    assert_eq!(info["capabilities"]["send"]["state"], "experimental");
    let status = backend.status().await;
    assert_eq!(status["connected"], true);
    assert_eq!(status["supportedVersion"], true);
    assert_eq!(status["writesEnabled"], true);
    assert_eq!(status["desktopVersion"], "test-next-release");
    server.await.unwrap();
}

#[test]
fn rich_step_projection_emits_diffs_tool_actions_turn_boundary_and_activity() {
    let steps = vec![
        json!({"metadata":{"executionId":"t1"},"userInput":{"items":[{"text":"fix bug"}]}}),
        json!({"metadata":{"executionId":"t1"},"type":"CORTEX_STEP_TYPE_VIEW_FILE","status":"CORTEX_STEP_STATUS_DONE","viewFile":{"absolutePathUri":"file:///work/src/app.rs"}}),
        json!({"metadata":{"executionId":"t1"},"type":"CORTEX_STEP_TYPE_GREP_SEARCH","status":"CORTEX_STEP_STATUS_DONE","grepSearch":{"query":"TODO","searchPath":"/work/src"}}),
        json!({"metadata":{"executionId":"t1"},"type":"CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT","status":"CORTEX_STEP_STATUS_DONE","replaceFileContent":{"targetFile":"/work/src/app.rs","targetContent":"old()","replacementContent":"new()"}}),
        json!({"metadata":{"executionId":"t1"},"type":"CORTEX_STEP_TYPE_RUN_COMMAND","status":"CORTEX_STEP_STATUS_DONE","runCommand":{"commandLine":"cargo test","cwd":"/work","exitCode":0,"combinedOutput":{"full":"ok"}}}),
        json!({"metadata":{"executionId":"t1"},"plannerResponse":{"response":"First draft"}}),
        json!({"metadata":{"executionId":"t1"},"plannerResponse":{"response":"Done fixing bug"}}),
    ];
    let rendered = messages(&steps, 0, false);
    assert_eq!(rendered.len(), 7);
    assert_eq!(rendered[1]["toolActions"], json!(["read-file"]));
    assert_eq!(rendered[1]["text"], "读取 app.rs");
    assert_eq!(rendered[2]["toolActions"], json!(["search-files"]));
    assert_eq!(rendered[3]["toolActions"], json!(["edit-file"]));
    assert_eq!(rendered[3]["changes"][0]["path"], "/work/src/app.rs");
    assert_eq!(rendered[3]["changes"][0]["diff"], "-old()\n+new()");
    assert_eq!(rendered[4]["toolActions"], json!(["run-command"]));
    assert!(rendered[4]["details"].as_str().unwrap().contains("退出码：0"));
    assert_ne!(rendered[5]["turnBoundary"], true);
    assert_eq!(rendered[6]["turnBoundary"], true);

    assert_eq!(activity_state(&steps, false), None);
    assert_eq!(activity_state(&steps, true), Some("responding"));
    assert_eq!(activity_state(&steps[..1], true), Some("thinking"));
    assert_eq!(activity_state(&steps[..5], true), Some("tool"));
}

#[test]
fn workspace_file_references_and_cited_downloads_allow_cited_siblings_and_block_secrets_and_uncited() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("antigravity-home");
    let workspace = dir.path().join("workspace");
    let brain = home.join("brain").join("thread-1");
    let other_brain = home.join("brain").join("thread-2");
    let daemon_dir = home.join("daemon");
    let sibling = dir.path().join("sibling-media");
    let sibling_figs = sibling.join("figs");
    let uploads = dir.path().join("native-uploads").join("u1");
    let ssh_dir = dir.path().join(".ssh");
    fs::create_dir_all(workspace.join("src")).unwrap();
    fs::create_dir_all(workspace.join(".git")).unwrap();
    fs::create_dir_all(&brain).unwrap();
    fs::create_dir_all(&other_brain).unwrap();
    fs::create_dir_all(&daemon_dir).unwrap();
    fs::create_dir_all(&sibling_figs).unwrap();
    fs::create_dir_all(&uploads).unwrap();
    fs::create_dir_all(&ssh_dir).unwrap();

    fs::write(workspace.join("src/main.rs"), "fn main() {}\n").unwrap();
    fs::write(workspace.join(".env"), "SECRET=1\n").unwrap();
    fs::write(workspace.join("private.key"), "KEY\n").unwrap();
    fs::write(workspace.join(".git/config"), "[core]\n").unwrap();
    let report = brain.join("report.md");
    fs::write(&report, "# Report\n").unwrap();
    let other_thread_note = other_brain.join("other.md");
    fs::write(&other_thread_note, "# Other thread\n").unwrap();
    let daemon_file = daemon_dir.join("hub_1234.json");
    fs::write(&daemon_file, "{}\n").unwrap();
    let sibling_html = sibling.join("ep00-demo.html");
    fs::write(&sibling_html, "<!doctype html><h1>Demo</h1>\n").unwrap();
    let sibling_md = sibling.join("script.md");
    let sibling_img = sibling_figs.join("chart.png");
    fs::write(
        &sibling_img,
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde",
    )
    .unwrap();
    fs::write(&sibling_md, "# Script\n\n![chart](./figs/chart.png)\n").unwrap();
    let uncited_sibling = sibling.join("uncited.txt");
    fs::write(&uncited_sibling, "do not serve\n").unwrap();
    let upload_file = uploads.join("attachment.txt");
    fs::write(&upload_file, "other device\n").unwrap();
    let ssh_key = ssh_dir.join("id_ed25519");
    fs::write(&ssh_key, "PRIVATE KEY\n").unwrap();

    let listed = export::list_workspace_files(std::slice::from_ref(&workspace), "");
    assert_eq!(listed, vec![json!({"name":"main.rs","path":"src/main.rs"})]);

    let report_uri = url::Url::from_file_path(&report).unwrap();
    let sibling_html_uri = url::Url::from_file_path(&sibling_html).unwrap();
    let sibling_md_uri = url::Url::from_file_path(&sibling_md).unwrap();
    let other_thread_uri = url::Url::from_file_path(&other_thread_note).unwrap();
    let daemon_uri = url::Url::from_file_path(&daemon_file).unwrap();
    let upload_uri = url::Url::from_file_path(&upload_file).unwrap();
    let ssh_uri = url::Url::from_file_path(&ssh_key).unwrap();
    let steps = vec![
        json!({"plannerResponse":{"response":format!(
            "See [report]({report_uri}), [demo]({sibling_html_uri}), [other]({other_thread_uri}), [daemon]({daemon_uri}), [upload]({upload_uri}), [ssh]({ssh_uri})"
        )}}),
        json!({"notifyUser":{"notificationContent":format!("Script at [script]({sibling_md_uri})")}}),
        json!({"type":"CORTEX_STEP_TYPE_VIEW_FILE","viewFile":{"absolutePath":workspace.join("src/main.rs")}}),
        json!({"type":"CORTEX_STEP_TYPE_VIEW_FILE","viewFile":{"absolutePath":workspace.join(".env")}}),
    ];
    let cited_report = media::download_cited(
        &home,
        "thread-1",
        std::slice::from_ref(&workspace),
        &steps,
        &report.to_string_lossy(),
    )
    .unwrap();
    assert_eq!(cited_report.name, "report.md");

    let cited_src = media::download_cited(
        &home,
        "thread-1",
        std::slice::from_ref(&workspace),
        &steps,
        "src/main.rs:12:4",
    )
    .unwrap();
    assert_eq!(cited_src.name, "main.rs");

    // Cited files created in a sibling directory outside workspace_roots succeed (matching Codex).
    let cited_sibling = media::download_cited(
        &home,
        "thread-1",
        std::slice::from_ref(&workspace),
        &steps,
        &format!("sandbox:{}", sibling_html.to_string_lossy()),
    )
    .unwrap();
    assert_eq!(cited_sibling.name, "ep00-demo.html");

    // 1-hop local image inside a cited sibling Markdown document succeeds.
    let sibling_nested = media::download_cited_with_document(
        &home,
        "thread-1",
        std::slice::from_ref(&workspace),
        &steps,
        "./figs/chart.png",
        Some(&sibling_md.to_string_lossy()),
    )
    .unwrap();
    assert_eq!(sibling_nested.name, "chart.png");

    // Uncited sibling file, secrets, native-uploads, other thread's brain, and daemon files stay blocked.
    for blocked in [
        ".env".to_owned(),
        uncited_sibling.to_string_lossy().into_owned(),
        other_thread_note.to_string_lossy().into_owned(),
        daemon_file.to_string_lossy().into_owned(),
        upload_file.to_string_lossy().into_owned(),
        ssh_key.to_string_lossy().into_owned(),
    ] {
        assert!(
            media::download_cited(
                &home,
                "thread-1",
                std::slice::from_ref(&workspace),
                &steps,
                &blocked,
            )
            .is_err(),
            "expected {blocked} to be rejected"
        );
    }

    // Local image referenced only inside report.md succeeds via 1-hop from_document authorization.
    let figs = brain.join("figs");
    std::fs::create_dir_all(&figs).unwrap();
    let plot = figs.join("loss.png");
    std::fs::write(
        &plot,
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde",
    )
    .unwrap();
    std::fs::write(&report, "# Report\n\n![loss](./figs/loss.png)\n").unwrap();
    assert!(
        media::download_cited(
            &home,
            "thread-1",
            std::slice::from_ref(&workspace),
            &steps,
            &plot.to_string_lossy(),
        )
        .is_err()
    );
    let nested = media::download_cited_with_document(
        &home,
        "thread-1",
        std::slice::from_ref(&workspace),
        &steps,
        &plot.to_string_lossy(),
        Some(&report.to_string_lossy()),
    )
    .unwrap();
    assert_eq!(nested.name, "loss.png");
}

#[test]
fn projects_inline_images_together_with_file_and_video_attachments() {
    let base = std::env::temp_dir().join("native-uploads");
    let mp4_path = base
        .join("00000000-0000-0000-0000-000000000001")
        .join("attachment.mp4");
    let pdf_path = base
        .join("00000000-0000-0000-0000-000000000002")
        .join("attachment.pdf");
    let prompt = crate::files::attachment_prompt(
        "请分析这个视频和文档",
        &[
            crate::files::Attachment {
                name: "demo.mp4".into(),
                path: mp4_path.clone(),
            },
            crate::files::Attachment {
                name: "spec.pdf".into(),
                path: pdf_path,
            },
        ],
        false,
    )
    .unwrap();
    let image_path = std::env::temp_dir()
        .join("brain")
        .join("thread-1")
        .join(".user_uploaded")
        .join("shot.png");
    let step = json!({
        "metadata": {"executionId": "exec-1"},
        "userInput": {
            "clientMessageId": "msg-1",
            "items": [{"text": prompt}],
            "media": [{
                "uri": image_path.to_string_lossy().as_ref(),
                "mimeType": "image/png",
                "displayName": "shot.png"
            }]
        }
    });
    let projected = messages(std::slice::from_ref(&step), 4, false);
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0]["text"], "请分析这个视频和文档");
    let attachments = projected[0]["attachments"].as_array().unwrap();
    assert_eq!(attachments.len(), 3);
    assert_eq!(attachments[0]["name"], "shot.png");
    assert_eq!(attachments[0]["path"], "antigravity-image:4:0");
    assert_eq!(attachments[1]["name"], "demo.mp4");
    assert_eq!(attachments[1]["path"], mp4_path.to_string_lossy().as_ref());
    assert_eq!(attachments[2]["name"], "spec.pdf");
}

#[test]
fn projects_error_details_and_tool_image_attachments() {
    let view_path = std::env::temp_dir()
        .join("promo video")
        .join("01b-hook-codex-phone.png");
    let view_uri = url::Url::from_file_path(&view_path).unwrap().to_string();
    let steps = vec![
        json!({
            "type": "CORTEX_STEP_TYPE_ERROR_MESSAGE",
            "status": "CORTEX_STEP_STATUS_ERROR",
            "errorMessage": {
                "error": {
                    "userErrorMessage": "Error Unknown: Agent execution terminated due to error.",
                    "shortError": "Agent execution terminated",
                    "errorId": "err-574"
                }
            }
        }),
        json!({
            "type": "CORTEX_STEP_TYPE_VIEW_FILE",
            "status": "CORTEX_STEP_STATUS_DONE",
            "viewFile": {
                "absolutePathUri": view_uri
            }
        }),
        json!({
            "type": "CORTEX_STEP_TYPE_GENERATE_IMAGE",
            "status": "CORTEX_STEP_STATUS_DONE",
            "generateImage": {
                "imageName": "cover.png",
                "outputPath": "/work/promo/cover.png"
            }
        }),
        json!({
            "type": "CORTEX_STEP_TYPE_GENERIC",
            "status": "CORTEX_STEP_STATUS_DONE",
            "generic": {
                "toolName": "read_file",
                "args": { "Path": "/work/promo/frame.webp" }
            }
        }),
    ];
    let projected = messages(&steps, 0, false);
    assert_eq!(projected.len(), 4);
    assert_eq!(
        projected[0]["text"],
        "Error Unknown: Agent execution terminated due to error."
    );
    let details = projected[0]["details"].as_str().unwrap();
    assert!(details.contains("Error ID: err-574"));
    assert!(details.contains("Agent execution terminated"));

    assert_eq!(projected[1]["text"], "读取 01b-hook-codex-phone.png");
    assert_eq!(projected[1]["attachments"][0]["media"], "image");
    assert_eq!(projected[1]["attachments"][0]["name"], "01b-hook-codex-phone.png");
    assert_eq!(
        projected[1]["attachments"][0]["path"],
        view_path.to_string_lossy().as_ref()
    );

    assert_eq!(projected[2]["attachments"][0]["media"], "image");
    assert_eq!(projected[2]["attachments"][0]["path"], "/work/promo/cover.png");

    assert_eq!(projected[3]["text"], "读取 frame.webp");
    assert_eq!(projected[3]["attachments"][0]["media"], "image");
    assert_eq!(projected[3]["attachments"][0]["path"], "/work/promo/frame.webp");
}

#[test]
fn queue_snapshot_retains_paused_non_when_idle_user_messages() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    // Protobuf-encoded Step { user_input: UserInput { items: [TextItem { text: "怎么样了?" }] } }
    // field 19 (0x9a 0x01) -> UserInput { field 3 (0x1a) -> TextItem { field 1 (0x0a) -> bytes } }
    let text = "怎么样了?".as_bytes();
    let mut item = vec![0x0a, text.len() as u8];
    item.extend_from_slice(text);
    let mut user_input = vec![0x1a, item.len() as u8];
    user_input.extend_from_slice(&item);
    let mut step = vec![0x9a, 0x01, user_input.len() as u8];
    step.extend_from_slice(&user_input);
    let frame = json!({
        "update": {
            "conversationId": "thread-1",
            "status": "CASCADE_RUN_STATUS_IDLE",
            "mainTrajectoryUpdate": {},
            "pendingAgentMessagesUpdate": {
                "totalLength": 1,
                "indices": [0],
                "pendingAgentMessages": [{
                    "id": "pending-1",
                    "recipient": "thread-1",
                    "deliveryStrategy": "MESSAGE_DELIVERY_STRATEGY_UNSPECIFIED",
                    "stepPayload": STANDARD.encode(&step),
                }]
            }
        }
    });
    let snapshot = queue::Snapshot::from_frame(&frame, "thread-1").unwrap();
    let mut view = json!({});
    snapshot.display(&mut view);
    let queued = view["queuedMessages"].as_array().unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0]["id"], "pending-1");
    assert_eq!(queued[0]["text"], "怎么样了?");
    assert_eq!(queued[0]["status"], "paused");
    assert!(queued[0]["reason"].as_str().is_some());
}

#[test]
fn queue_snapshot_excludes_running_immediate_steer_messages() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let encode = |text: &str| {
        let b = text.as_bytes();
        let mut item = vec![0x0a, b.len() as u8];
        item.extend_from_slice(b);
        let mut user_input = vec![0x1a, item.len() as u8];
        user_input.extend_from_slice(&item);
        let mut step = vec![0x9a, 0x01, user_input.len() as u8];
        step.extend_from_slice(&user_input);
        STANDARD.encode(&step)
    };
    let frame = json!({
        "update": {
            "conversationId": "thread-1",
            "status": "CASCADE_RUN_STATUS_RUNNING",
            "mainTrajectoryUpdate": {},
            "pendingAgentMessagesUpdate": {
                "totalLength": 2,
                "indices": [0, 1],
                "pendingAgentMessages": [
                    {
                        "id": "steer-1",
                        "recipient": "thread-1",
                        "deliveryStrategy": "MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION",
                        "stepPayload": encode("立即追加"),
                    },
                    {
                        "id": "queue-1",
                        "recipient": "thread-1",
                        "deliveryStrategy": "MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE",
                        "stepPayload": encode("排队消息"),
                    }
                ]
            }
        }
    });
    let snapshot = queue::Snapshot::from_frame(&frame, "thread-1").unwrap();
    let mut view = json!({});
    snapshot.display(&mut view);
    let queued = view["queuedMessages"].as_array().unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0]["id"], "queue-1");
    assert_eq!(queued[0]["text"], "排队消息");
    assert_eq!(queued[0]["status"], "queued");
}

#[test]
fn disk_summaries_include_unloaded_top_level_conversations_and_filter_subagents_and_archived() {
    let dir = tempfile::tempdir().unwrap();
    let conversations = dir.path().join("conversations");
    let annotations = dir.path().join("annotations");
    fs::create_dir_all(&conversations).unwrap();
    fs::create_dir_all(&annotations).unwrap();

    let keep_id = Uuid::new_v4().to_string();
    let sub_id = Uuid::new_v4().to_string();
    let killed_id = Uuid::new_v4().to_string();
    let archived_id = Uuid::new_v4().to_string();
    let missing_db_id = Uuid::new_v4().to_string();
    for id in [&keep_id, &sub_id, &killed_id, &archived_id] {
        fs::write(conversations.join(format!("{id}.db")), b"").unwrap();
    }
    fs::write(
        annotations.join(format!("{archived_id}.pbtxt")),
        "title:\"Old\" archived:true\n",
    )
    .unwrap();

    let conn = rusqlite::Connection::open(dir.path().join("conversation_summaries.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE conversation_summaries (
            conversation_id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            last_modified_time TEXT NOT NULL,
            workspace_uris TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT '',
            parent_conversation_id TEXT NOT NULL DEFAULT '',
            nesting_depth INTEGER NOT NULL DEFAULT 0,
            killed INTEGER NOT NULL DEFAULT 0
        );",
    )
    .unwrap();
    let insert = "INSERT INTO conversation_summaries VALUES (?1,?2,?3,?4,?5,?6,?7,?8)";
    conn.execute(
        insert,
        rusqlite::params![
            keep_id,
            "Saved Thread",
            "2026-11-22 12:32:52.170593586+00:00",
            r#"["file:///tmp/demo"]"#,
            "proj-1",
            "",
            0,
            0
        ],
    )
    .unwrap();
    conn.execute(
        insert,
        rusqlite::params![
            sub_id,
            "Subagent",
            "2026-11-22 12:32:52+00:00",
            "[]",
            "proj-1",
            keep_id,
            1,
            0
        ],
    )
    .unwrap();
    conn.execute(
        insert,
        rusqlite::params![
            killed_id,
            "Killed",
            "2026-11-22 12:32:52+00:00",
            "[]",
            "proj-1",
            "",
            0,
            1
        ],
    )
    .unwrap();
    conn.execute(
        insert,
        rusqlite::params![
            archived_id,
            "Archived",
            "2026-11-22 12:32:52+00:00",
            "[]",
            "proj-1",
            "",
            0,
            0
        ],
    )
    .unwrap();
    conn.execute(
        insert,
        rusqlite::params![
            missing_db_id,
            "Deleted",
            "2026-11-22 12:32:52+00:00",
            "[]",
            "proj-1",
            "",
            0,
            0
        ],
    )
    .unwrap();
    drop(conn);

    let disk = read_disk_summaries(dir.path());
    assert_eq!(disk.len(), 1);
    let saved = disk.get(&keep_id).unwrap();
    assert_eq!(saved["summary"], "Saved Thread");
    assert_eq!(saved["trajectoryMetadata"]["projectId"], "proj-1");
    assert_eq!(
        saved["trajectoryMetadata"]["workspaceUris"],
        json!(["file:///tmp/demo"])
    );
    assert_eq!(
        timestamp_ms(saved["lastModifiedTime"].as_str().unwrap()),
        timestamp_ms("2026-11-22T12:32:52.170Z")
    );
    assert_eq!(
        timestamp_ms(&normalize_sqlite_timestamp("2026-11-22 20:32:52+08:00")),
        timestamp_ms("2026-11-22T12:32:52.000Z")
    );
}

#[test]
fn subagent_url_permission_view_and_reply_preserve_subagent_target() {
    let sub_id = "63e097b5-d5d1-4290-ad0e-59d798c8d092";
    let traj_id = "f0a94efa-9471-40ea-8ca4-6c95828a700b";
    let parent_steps = vec![json!({
        "type": "CORTEX_STEP_TYPE_INVOKE_SUBAGENT",
        "invokeSubagent": {
            "subagents": [{"typeName": "browser", "role": "Visual Verifier"}],
            "results": [{"conversationId": sub_id}]
        }
    })];
    let children = child_subagents(&parent_steps);
    assert_eq!(children, vec![(sub_id.to_owned(), Some("Visual Verifier".to_owned()))]);

    let sub_trajectory = json!({
        "cascadeId": sub_id,
        "trajectoryId": traj_id,
        "steps": [
            {"type": "CORTEX_STEP_TYPE_SYSTEM_MESSAGE", "status": "CORTEX_STEP_STATUS_DONE"},
            {
                "type": "CORTEX_STEP_TYPE_GENERIC",
                "status": "CORTEX_STEP_STATUS_WAITING",
                "metadata": {
                    "executionId": "exec-sub-1",
                    "sourceTrajectoryStepInfo": {
                        "trajectoryId": traj_id,
                        "cascadeId": sub_id,
                        "stepIndex": 1
                    }
                },
                "requestedInteraction": {
                    "permission": {
                        "resource": {"action": "execute_url", "target": "127.0.0.1:8799"},
                        "reason": "Open http://127.0.0.1:8799/"
                    }
                }
            }
        ]
    });
    let views = interactions::subagent_views(sub_id, Some("Visual Verifier"), &sub_trajectory, false);
    assert_eq!(views.len(), 1);
    let shown = &views[0];
    assert_eq!(shown["id"], format!("antigravity-sub:{sub_id}:1"));
    assert_eq!(shown["title"], "Visual Verifier · 允许在网页执行操作");
    assert_eq!(shown["actionable"], true);
    assert_eq!(shown["decisions"], json!(["accept", "decline"]));

    let answer: crate::requests::Response = serde_json::from_value(json!({
        "requestId": Uuid::new_v4(),
        "targetRequestId": shown["id"],
        "expectedTurnId": shown["turnId"],
        "expectedFingerprint": shown["fingerprint"],
        "decision": "accept"
    }))
    .unwrap();
    match interactions::request_target(&answer).unwrap() {
        interactions::RequestTarget::Subagent(parsed_id, index) => {
            assert_eq!(parsed_id, sub_id);
            assert_eq!(index, 1);
        }
        _ => panic!("expected subagent target"),
    }
    let reply = interactions::subagent_response(sub_id, 1, &sub_trajectory, &answer).unwrap();
    assert_eq!(
        reply,
        json!({
            "trajectoryId": traj_id,
            "stepIndex": 1,
            "permission": {"allow": true, "scope": "PERMISSION_SCOPE_ONCE"}
        })
    );
}

#[test]
fn swarm_reads_board_members_plan_and_projects_worker_trajectories() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("antigravity-home");
    let coord_id = "356b9efd-de22-4e3c-82e5-2324e19f3eff";
    let worker_id = "2be52ae3-3689-455d-bb19-448a338cb959";
    let swarm_dir = home
        .join("brain")
        .join(coord_id)
        .join(".system_generated")
        .join("swarm");
    let worker_logs = home
        .join("brain")
        .join(worker_id)
        .join(".system_generated")
        .join("logs");
    let sibling = dir.path().join("sibling");
    fs::create_dir_all(&swarm_dir).unwrap();
    fs::create_dir_all(&worker_logs).unwrap();
    fs::create_dir_all(&sibling).unwrap();

    let board_file = sibling.join("script.md");
    fs::write(&board_file, "# Script\n").unwrap();

    fs::write(
        swarm_dir.join("swarm.json"),
        json!({"version":1,"backend":"local","swarm_id":coord_id,"created_at":"2026-11-28T00:36:35Z"})
            .to_string(),
    )
    .unwrap();
    fs::write(
        swarm_dir.join("members.json"),
        json!({
            "title": "EP01 导演审查",
            "members": {
                "coordinator": {
                    "conversation_id": coord_id,
                    "role": "coordinator",
                    "applied_model": "gemini-4-neon-high",
                    "wake_mode": "working",
                    "last_read_seq": 2,
                    "killed": false
                },
                "opus-director": {
                    "conversation_id": worker_id,
                    "role": "worker",
                    "applied_model": "claude-opus-5-5-medium",
                    "wake_mode": "mentions",
                    "last_read_seq": 1,
                    "killed": false
                },
                "retired-worker": {
                    "conversation_id": "11111111-1111-4111-8111-111111111111",
                    "role": "worker",
                    "applied_model": "gemini-4-flash",
                    "killed": true
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        swarm_dir.join("plan.json"),
        json!({
            "goal": {"title": "EP01 重构", "line": "产出可执行分镜方案"},
            "tasks": {"opus-director": "审查脚本与画面"},
            "threads": [{"id": "t1", "title": "视觉重构", "goal": "统一色板与镜头", "tasks": ["opus-director"]}]
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        swarm_dir.join("board.jsonl"),
        format!(
            "{}\n{}\n",
            json!({"seq":1,"agent":"coordinator","text":format!("@opus-director 请审阅 `{}`", board_file.display()),"time":"2026-11-28 08:36:37","kind":"brief"}),
            json!({"seq":2,"agent":"opus-director","text":"@coordinator [done] 审阅完成，建议统一色板。","time":"2026-11-28 08:38:52"})
        ),
    )
    .unwrap();
    fs::write(
        worker_logs.join("transcript.jsonl"),
        format!(
            "{}\n{}\n{}\n",
            json!({"step_index":0,"type":"SYSTEM_MESSAGE","status":"DONE","created_at":"2026-11-28T00:36:37Z","content":"<SYSTEM_MESSAGE>content=You have just started. Brief #1</SYSTEM_MESSAGE>"}),
            json!({"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-28T00:38:50Z","tool_calls":[{"name":"post_message","args":{"text":"\"@coordinator [done] 审阅完成\""}},{"name":"swarm_wait","args":{"since":"1"}}]}),
            json!({"step_index":2,"type":"GENERIC","status":"DONE","created_at":"2026-11-28T00:38:52Z","content":"Waiting for a message that calls on you by name."})
        ),
    )
    .unwrap();

    assert!(swarm::has_swarm(&home, coord_id));
    let snapshot = swarm::read_swarm_sync(&home, coord_id).unwrap();
    let s = &snapshot["swarm"];
    assert_eq!(s["title"], "EP01 导演审查");
    assert_eq!(s["head"], 2);
    assert_eq!(s["counts"]["working"], 1);
    assert_eq!(s["counts"]["waiting"], 1);
    assert_eq!(s["counts"]["killed"], 1);
    assert_eq!(s["messages"].as_array().unwrap().len(), 2);
    assert_eq!(s["messages"][0]["mentions"], json!(["opus-director"]));
    let members = s["members"].as_array().unwrap();
    assert_eq!(members[0]["name"], "coordinator");
    assert_eq!(members[0]["status"], "working");
    assert_eq!(members[1]["name"], "opus-director");
    assert_eq!(members[1]["status"], "waiting");
    assert_eq!(members[1]["unread"], 1);
    assert_eq!(members[1]["task"], "审查脚本与画面");
    assert_eq!(members[2]["name"], "retired-worker");
    assert_eq!(members[2]["status"], "killed");

    // Board-cited file is downloadable via media::download_cited with empty main steps.
    let downloaded = media::download_cited(
        &home,
        coord_id,
        &[],
        &[],
        &board_file.to_string_lossy(),
    )
    .unwrap();
    assert_eq!(downloaded.name, "script.md");

    // Worker transcript fallback projects assignment + posted message + swarm_wait cleanly.
    let tx_messages = swarm::project_worker_transcript_jsonl(&home, worker_id);
    assert_eq!(tx_messages.len(), 3);
    assert_eq!(tx_messages[0]["role"], "user");
    assert_eq!(tx_messages[1]["role"], "assistant");
    assert_eq!(tx_messages[1]["text"], "@coordinator [done] 审阅完成");
    assert_eq!(tx_messages[2]["role"], "tool");

    // Worker daemon steps project post_message tool calls as assistant messages.
    let daemon_steps = vec![
        json!({"type":"CORTEX_STEP_TYPE_SYSTEM_MESSAGE","status":"CORTEX_STEP_STATUS_DONE","systemMessage":{"content":"<SYSTEM_MESSAGE>content=[swarm] new board message #1</SYSTEM_MESSAGE>"}}),
        json!({"type":"CORTEX_STEP_TYPE_PLANNER_RESPONSE","status":"CORTEX_STEP_STATUS_DONE","plannerResponse":{"toolCalls":[{"name":"post_message","argumentsJson":"{\"text\":\"@coordinator 已完成诊断\"}"}]}}),
        json!({"type":"CORTEX_STEP_TYPE_GENERIC","status":"CORTEX_STEP_STATUS_DONE","metadata":{"toolCall":{"name":"swarm_wait"}}}),
    ];
    let projected = swarm::project_worker_daemon_steps(&daemon_steps);
    assert_eq!(projected.len(), 2);
    assert_eq!(projected[0]["role"], "assistant");
    assert_eq!(projected[0]["text"], "@coordinator 已完成诊断");
    assert_eq!(projected[1]["role"], "tool");
    assert_eq!(projected[1]["text"], "等待公告板新消息");
}
