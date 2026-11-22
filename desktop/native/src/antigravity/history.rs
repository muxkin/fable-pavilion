use super::{
    Backend, Daemon, MAX_RESPONSE, PAGE, ResponseTooLarge, stream, supports_append, valid_id,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{ops::Range, time::Duration};

const CURSOR_PREFIX: &str = "steps:";

pub(super) struct Cursor<'a> {
    trajectory: &'a str,
    minimum_total: usize,
    before: usize,
}

impl<'a> Cursor<'a> {
    pub(super) fn read(query: &'a Value) -> Result<Option<Self>> {
        let Some(encoded) = query["cursor"]
            .as_str()
            .and_then(|c| c.strip_prefix(CURSOR_PREFIX))
        else {
            return Ok(None);
        };
        let (trajectory, bounds) = encoded.split_once(':').context("历史游标无效")?;
        let (minimum_total, before) = bounds.split_once(':').context("历史游标无效")?;
        valid_id(trajectory)?;
        let minimum_total = minimum_total.parse::<u32>().context("历史游标无效")? as usize;
        let before = before.parse::<u32>().context("历史游标无效")? as usize;
        ensure!(before > 0 && before < minimum_total, "历史游标无效");
        Ok(Some(Self {
            trajectory,
            minimum_total,
            before,
        }))
    }
}

pub(super) struct Page {
    trajectory: String,
    total: usize,
    start: usize,
    steps: Vec<Value>,
    status: Value,
    running: bool,
    oversized_step: bool,
    executor_metadatas: Vec<Value>,
    generator_metadatas: Vec<Value>,
    queue: Option<super::queue::Snapshot>,
}

impl Page {
    pub(super) fn total_steps(&self) -> usize {
        self.total
    }

    pub(super) fn is_tail(&self) -> bool {
        !self.oversized_step && self.start + self.steps.len() == self.total
    }

    pub(super) fn status(&self) -> &Value {
        &self.status
    }

    pub(super) fn steps(&self) -> &[Value] {
        &self.steps
    }

    pub(super) fn start(&self) -> usize {
        self.start
    }

    pub(super) fn executor_metadatas(&self) -> &[Value] {
        &self.executor_metadatas
    }

    pub(super) fn generator_metadatas(&self) -> &[Value] {
        &self.generator_metadatas
    }

    pub(super) fn queue(&self) -> Option<&super::queue::Snapshot> {
        self.queue.as_ref()
    }

    pub(super) fn observations(&self) -> Vec<crate::plugins::Observation> {
        super::observations(&json!({
            "status": self.status,
            "trajectory": {
                "steps": self.steps,
                "executorMetadatas": self.executor_metadatas,
            },
        }))
    }

    pub(super) fn older_cursor(&self) -> Option<String> {
        (self.start > 0).then(|| {
            format!(
                "{CURSOR_PREFIX}{}:{}:{}",
                self.trajectory, self.total, self.start
            )
        })
    }

    pub(super) fn messages(&self) -> Vec<Value> {
        if self.oversized_step {
            return vec![json!({
                "id": format!("antigravity-step-{}", self.start),
                "role": "tool",
                "text": "这条历史记录过大，请在 Antigravity 本机 App 中查看。",
            })];
        }
        super::messages(&self.steps, self.start, false)
    }

    pub(super) fn waiting_step(&self, index: usize) -> Option<&Value> {
        if !self.running || !self.is_tail() || index < self.start {
            return None;
        }
        let step = self.steps.get(index - self.start)?;
        (step["status"] == "CORTEX_STEP_STATUS_WAITING" || super::pending_interaction(step))
            .then_some(step)
    }

    fn parse(mut frame: Value, thread: &str, requested: Range<usize>) -> Result<Self> {
        let queue = super::queue::Snapshot::from_frame(&frame, thread).ok();
        let update = &mut frame["update"];
        ensure!(update["conversationId"] == thread, "Antigravity 会话已变化");
        let trajectory = update["trajectoryId"]
            .as_str()
            .context("Antigravity 会话版本不可用")?
            .to_owned();
        valid_id(&trajectory)?;
        let status = update["status"].clone();
        let running = supports_append(&status);
        let executor_metadatas = update["mainTrajectoryUpdate"]["executorMetadatasUpdate"]
            ["executorMetadatas"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let generator_metadatas = update["mainTrajectoryUpdate"]["generatorMetadataUpdate"]
            ["generatorMetadatas"]
            .as_array()
            .or_else(|| {
                update["mainTrajectoryUpdate"]["generatorMetadataUpdate"]["generatorMetadata"]
                    .as_array()
            })
            .cloned()
            .unwrap_or_default();
        let ranged = &mut update["mainTrajectoryUpdate"]["stepsUpdate"];
        ensure!(
            ranged["pageBounds"].is_object(),
            "Antigravity 历史分页格式不兼容"
        );
        let bounds = &ranged["pageBounds"];
        ensure!(
            coordinate(&bounds["startIndex"])? == requested.start
                && coordinate(&bounds["endIndexExclusive"])? == requested.end,
            "Antigravity 历史分页范围已变化"
        );
        let total = coordinate(&ranged["totalLength"])?;
        let start = requested.start.min(total);
        let end = requested.end.min(total);
        let indices = array_or_empty(ranged["indices"].take())?;
        let steps = array_or_empty(ranged["steps"].take())?;
        ensure!(
            indices.len() == end - start
                && steps.len() == indices.len()
                && indices
                    .iter()
                    .zip(start..end)
                    .all(|(actual, index)| { actual.as_u64() == Some(index as u64) })
                && steps.iter().all(Value::is_object),
            "Antigravity 返回了不完整的历史分页"
        );
        Ok(Self {
            trajectory,
            total,
            start,
            steps,
            status,
            running,
            oversized_step: false,
            executor_metadatas,
            generator_metadatas,
            queue,
        })
    }

    fn check_revision(&self, trajectory: &str, minimum_total: usize) -> Result<()> {
        ensure!(
            self.trajectory == trajectory && self.total >= minimum_total,
            "Antigravity 会话历史已变化，请重新打开此会话"
        );
        Ok(())
    }
}

fn coordinate(value: &Value) -> Result<usize> {
    // Protobuf JSON omits unsigned zero fields unless presence is tracked.
    if value.is_null() {
        return Ok(0);
    }
    Ok(value
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .context("Antigravity 历史分页索引无效")? as usize)
}

fn array_or_empty(value: Value) -> Result<Vec<Value>> {
    match value {
        Value::Null => Ok(Vec::new()),
        Value::Array(items) => Ok(items),
        _ => anyhow::bail!("Antigravity 历史分页格式不兼容"),
    }
}

async fn read_page(
    backend: &Backend,
    daemon: &Daemon,
    thread: &str,
    requested: Range<usize>,
) -> Result<Page> {
    let frame = stream::first_update(
        backend,
        daemon,
        thread,
        requested.clone(),
        MAX_RESPONSE,
        Duration::from_secs(15),
    )
    .await?;
    Page::parse(frame, thread, requested)
}

pub(super) async fn browse(
    backend: &Backend,
    daemon: &Daemon,
    thread: &str,
    expected_trajectory: &str,
    cursor: Option<Cursor<'_>>,
) -> Result<Page> {
    let (minimum_total, before) = if let Some(cursor) = cursor {
        ensure!(
            cursor.trajectory == expected_trajectory,
            "Antigravity 会话历史已变化，请重新打开此会话"
        );
        (cursor.minimum_total, cursor.before)
    } else {
        let metadata = read_page(backend, daemon, thread, 0..0).await?;
        metadata.check_revision(expected_trajectory, 0)?;
        if metadata.total == 0 {
            return Ok(metadata);
        }
        (metadata.total, metadata.total)
    };
    let mut width = PAGE.min(before);
    loop {
        match read_page(backend, daemon, thread, before - width..before).await {
            Err(error) if error.is::<ResponseTooLarge>() && width > 1 => width = width.div_ceil(2),
            Err(error) if error.is::<ResponseTooLarge>() => {
                let mut metadata = read_page(backend, daemon, thread, 0..0).await?;
                metadata.check_revision(expected_trajectory, minimum_total)?;
                metadata.start = before - 1;
                metadata.oversized_step = true;
                return Ok(metadata);
            }
            result => {
                let page = result?;
                page.check_revision(expected_trajectory, minimum_total)?;
                return Ok(page);
            }
        }
    }
}

pub(super) async fn step(
    backend: &Backend,
    daemon: &Daemon,
    thread: &str,
    expected_trajectory: &str,
    index: usize,
) -> Result<Option<Value>> {
    Ok(
        step_page(backend, daemon, thread, expected_trajectory, index)
            .await?
            .and_then(|mut page| page.steps.pop()),
    )
}

pub(super) async fn step_page(
    backend: &Backend,
    daemon: &Daemon,
    thread: &str,
    expected_trajectory: &str,
    index: usize,
) -> Result<Option<Page>> {
    let Some(end) = index.checked_add(1).filter(|end| *end <= u32::MAX as usize) else {
        return Ok(None);
    };
    let page = read_page(backend, daemon, thread, index..end).await?;
    page.check_revision(expected_trajectory, 0)?;
    Ok(Some(page))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::{Adapter, Delivery, Media, Write};
    use base64::{Engine, engine::general_purpose::STANDARD};
    use bytes::Bytes;
    use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
    use hyper::{
        Request, Response,
        body::{Frame, Incoming},
        server::conn::http1,
        service::service_fn,
    };
    use hyper_util::rt::TokioIo;
    use serde_json::json;
    use std::{
        convert::Infallible,
        fs,
        io::Read,
        path::{Path, PathBuf},
        sync::{Arc, Mutex},
        time::Duration,
    };
    use tokio::net::TcpListener;
    use uuid::Uuid;

    const THREAD: &str = "11111111-1111-4111-8111-111111111111";
    const TRAJECTORY: &str = "22222222-2222-4222-8222-222222222222";
    const REPLACEMENT: &str = "33333333-3333-4333-8333-333333333333";
    const TOTAL: usize = 147;
    const QUESTION_INDEX: usize = TOTAL - 1;

    struct Fixture {
        full_reads: usize,
        windows: Vec<Range<usize>>,
        trajectory: &'static str,
        total: usize,
        oversized: bool,
        oversized_step: Option<usize>,
        invalid_indices: bool,
        running: bool,
        question: bool,
        answer: Option<Value>,
        drop_answer_receipt: bool,
        image: PathBuf,
    }

    fn message(index: usize, fixture: &Fixture) -> Value {
        if fixture.question && index == QUESTION_INDEX {
            let question = json!({"questions":[{
                "question":"Choose a color",
                "options":[{"id":"blue-id","text":"Blue"}],
            }]});
            let mut step = json!({
                "type":"CORTEX_STEP_TYPE_ASK_QUESTION",
                "status":"CORTEX_STEP_STATUS_WAITING",
                "metadata":{
                    "executionId":"fixture-execution",
                    "sourceTrajectoryStepInfo":{
                        "cascadeId":THREAD,"trajectoryId":fixture.trajectory,"stepIndex":index,
                    },
                },
                "requestedInteraction":{"askQuestion":question},
            });
            if let Some(answer) = &fixture.answer {
                step["completedInteractions"] = json!([{
                    "request":{"askQuestion":question},"response":answer["interaction"],
                }]);
            }
            return step;
        }
        if index == TOTAL && fixture.answer.is_some() {
            return json!({
                "type":"CORTEX_STEP_TYPE_PLANNER_RESPONSE",
                "plannerResponse":{"response":"Continued after the answer"},
            });
        }
        if index == 17 {
            return json!({
                "type":"CORTEX_STEP_TYPE_RUN_COMMAND",
                "runCommand":{"commandLine":"fixture","combinedOutput":{"full":"x".repeat(20_000)}},
            });
        }
        let mut message = json!({"userInput":{"items":[{"text":format!("message {index}")}]}});
        if index == 99 {
            message["userInput"]["media"] =
                json!([{"uri":fixture.image,"mimeType":"image/png","displayName":"fixture.png"}]);
        }
        message
    }

    type TestBody = UnsyncBoxBody<Bytes, Infallible>;

    fn bytes(data: impl Into<Bytes>) -> TestBody {
        Full::new(data.into()).boxed_unsync()
    }

    fn data(value: Value) -> TestBody {
        bytes(serde_json::to_vec(&value).unwrap())
    }

    fn framed(value: Value) -> TestBody {
        let body = serde_json::to_vec(&value).unwrap();
        let mut frame = vec![0];
        frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
        frame.extend_from_slice(&body);
        bytes(frame)
    }

    async fn fixture_reply(
        request: Request<Incoming>,
        fixture: Arc<Mutex<Fixture>>,
    ) -> Response<TestBody> {
        let method = request.uri().path().rsplit('/').next().unwrap().to_owned();
        let body = request.into_body().collect().await.unwrap().to_bytes();
        let mut fixture = fixture.lock().unwrap();
        let response = match method.as_str() {
            "GetCapabilities" | "ListProjects" | "ReadProjects" => data(json!({})),
            "GetAllCascadeTrajectories" => data(json!({"trajectorySummaries": {
                THREAD:{"summary":"Synthetic large conversation","trajectoryId":fixture.trajectory,"stepCount":fixture.total},
            }})),
            "GetCascadeTrajectory" => {
                assert_eq!(
                    serde_json::from_slice::<Value>(&body).unwrap()["cascadeId"],
                    THREAD
                );
                fixture.full_reads += 1;
                if fixture.oversized {
                    // Send an actual chunked response larger than 32 MiB. Reuse the
                    // same one-MiB buffer without allocating another full history.
                    let chunk = Bytes::from(vec![b'x'; 1024 * 1024]);
                    let chunks = std::iter::repeat_n(chunk, 33).map(|chunk| Ok(Frame::data(chunk)));
                    StreamBody::new(futures::stream::iter(chunks)).boxed_unsync()
                } else {
                    data(json!({"status":"CASCADE_RUN_STATUS_IDLE","trajectory":{
                        "cascadeId":THREAD,"trajectoryId":TRAJECTORY,"steps":[message(0, &fixture)]
                    }}))
                }
            }
            "StreamAgentStateUpdates" => {
                assert_eq!(body[0], 0);
                assert_eq!(
                    u32::from_be_bytes(body[1..5].try_into().unwrap()) as usize,
                    body.len() - 5
                );
                let body: Value = serde_json::from_slice(&body[5..]).unwrap();
                assert_eq!(body["conversationId"], THREAD);
                let bounds = &body["initialStepsPageBounds"];
                let start = bounds["startIndex"].as_u64().unwrap() as usize;
                let end = bounds["endIndexExclusive"].as_u64().unwrap() as usize;
                fixture.windows.push(start..end);
                if (start == TOTAL - PAGE && end == TOTAL)
                    || fixture
                        .oversized_step
                        .is_some_and(|index| (start..end).contains(&index))
                {
                    let mut header = vec![0];
                    header.extend_from_slice(&((MAX_RESPONSE + 1) as u32).to_be_bytes());
                    bytes(header)
                } else {
                    let range = start.min(fixture.total)..end.min(fixture.total);
                    let mut indices: Vec<_> = range.clone().collect();
                    if fixture.invalid_indices
                        && let Some(first) = indices.first_mut()
                    {
                        *first += 1;
                    }
                    framed(json!({"update":{
                        "conversationId":THREAD,"trajectoryId":fixture.trajectory,
                        "status":if fixture.running { "CASCADE_RUN_STATUS_RUNNING" } else { "CASCADE_RUN_STATUS_IDLE" },
                        "mainTrajectoryUpdate":{"stepsUpdate":{
                            "pageBounds":bounds,"totalLength":fixture.total,"indices":indices,
                            "steps":range.map(|index| message(index, &fixture)).collect::<Vec<_>>(),
                        }},
                    }}))
                }
            }
            "HandleCascadeUserInteraction" => {
                assert!(fixture.answer.is_none());
                fixture.answer = Some(serde_json::from_slice(&body).unwrap());
                fixture.total += 1;
                fixture.running = false;
                if fixture.drop_answer_receipt {
                    // The native service saved the answer, but the HTTP read fails.
                    return Response::builder().status(502).body(bytes("")).unwrap();
                }
                data(json!({}))
            }
            "SendUserCascadeMessage" => {
                let sent: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(sent["cascadeId"], THREAD);
                data(json!({}))
            }
            other => panic!("Unexpected native RPC: {other}"),
        };
        Response::new(response)
    }

    async fn serve(
        home: &Path,
        image: PathBuf,
    ) -> (Arc<Mutex<Fixture>>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        fs::create_dir(home.join("daemon")).unwrap();
        fs::write(
            home.join(format!("daemon/hub_{port}.json")),
            json!({
                "pid":std::process::id(),"httpPort":port,"csrfToken":"synthetic-test-token",
            })
            .to_string(),
        )
        .unwrap();
        let fixture = Arc::new(Mutex::new(Fixture {
            full_reads: 0,
            windows: Vec::new(),
            trajectory: TRAJECTORY,
            total: TOTAL,
            oversized: true,
            oversized_step: None,
            invalid_indices: false,
            running: false,
            question: false,
            answer: None,
            drop_answer_receipt: false,
            image,
        }));
        let state = fixture.clone();
        let server = tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let state = state.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |request| {
                        let state = state.clone();
                        async move { Ok::<_, Infallible>(fixture_reply(request, state).await) }
                    });
                    // The adapter can stop reading as soon as it detects the size limit.
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(socket), service)
                        .await;
                });
            }
        });
        (fixture, server)
    }

    #[tokio::test]
    async fn a_single_oversized_step_does_not_block_earlier_history() -> Result<()> {
        let home = tempfile::tempdir()?;
        let (fixture, server) = serve(home.path(), home.path().join("fixture.png")).await;
        fixture.lock().unwrap().oversized_step = Some(TOTAL - 1);
        let backend = Backend::from_config(
            "fixture".to_owned(),
            "Fixture".to_owned(),
            &json!({"home": home.path()}),
            false,
            &Value::Null,
        )?;
        let params = json!({"id": THREAD});
        let latest = backend
            .read("history.read", &params, &Value::Null)
            .await?
            .context("Missing latest history")?;
        assert_eq!(latest["messages"][0]["id"], "antigravity-step-146");
        assert_eq!(
            latest["messages"][0]["text"],
            "这条历史记录过大，请在 Antigravity 本机 App 中查看。"
        );
        assert_eq!(latest["messages"].as_array().unwrap().len(), 1);
        assert_eq!(latest["thread"]["canSend"], false);

        let previous = backend
            .read(
                "history.read",
                &params,
                &json!({"cursor": latest["nextCursor"]}),
            )
            .await?
            .context("Missing earlier history")?;
        assert_eq!(previous["messages"][0]["id"], "antigravity-step-46");
        assert_eq!(previous["messages"][99]["id"], "antigravity-step-145");

        {
            let mut fixture = fixture.lock().unwrap();
            fixture.oversized_step = Some(45);
            fixture.total = TOTAL - 1;
        }
        let older_query = json!({"cursor": previous["nextCursor"]});
        assert!(
            backend
                .read("history.read", &params, &older_query)
                .await
                .is_err()
        );
        fixture.lock().unwrap().total = TOTAL;
        let skipped = backend
            .read("history.read", &params, &older_query)
            .await?
            .context("Missing oversized step placeholder")?;
        assert_eq!(skipped["messages"][0]["id"], "antigravity-step-45");
        let earlier = backend
            .read(
                "history.read",
                &params,
                &json!({"cursor": skipped["nextCursor"]}),
            )
            .await?
            .context("Missing history before the oversized step")?;
        assert_eq!(earlier["messages"][44]["id"], "antigravity-step-44");
        assert!(earlier["nextCursor"].is_null());
        server.abort();
        Ok(())
    }

    async fn answer_question(backend: &Backend, answer: &crate::requests::Response) -> Delivery {
        backend
            .write(
                THREAD,
                answer.request_id,
                Write::Respond(answer.clone()),
                None,
                &|_| panic!("Answering a question must not create a conversation"),
            )
            .await
    }

    #[tokio::test]
    async fn oversized_history_answers_only_the_current_tail_question() -> Result<()> {
        let home = tempfile::tempdir()?;
        let (fixture, server) = serve(home.path(), home.path().join("fixture.png")).await;
        {
            let mut fixture = fixture.lock().unwrap();
            fixture.running = true;
            fixture.question = true;
        }
        let config = json!({"home": home.path()});
        let capabilities = json!({"boundedQuestionResponses":true,"writeInQuestionIds":true});
        let backend = Backend::from_config(
            "fixture".into(),
            "Fixture".into(),
            &config,
            false,
            &capabilities,
        )?;
        let params = json!({"id":THREAD});
        let initial = backend
            .read("history.read", &params, &Value::Null)
            .await?
            .context("Missing current history")?;
        let thread = &initial["thread"];
        assert_eq!(thread["owner"], true);
        assert_eq!(thread["synchronized"], true);
        assert_eq!(thread["pendingRequests"], 1);
        for field in ["canSend", "canSteer"] {
            assert_eq!(thread[field], false);
        }
        assert_eq!(thread["canInterrupt"], true);
        let question = &thread["requests"][0];
        assert_eq!(question["id"], format!("antigravity-{QUESTION_INDEX}"));
        assert_eq!(question["turnId"], "fixture-execution");
        assert_eq!(question["actionable"], true);
        assert_eq!(question["acceptsWriteInQuestionIds"], true);
        let answer = serde_json::from_value::<crate::requests::Response>(json!({
            "requestId":Uuid::new_v4(),"targetRequestId":question["id"],
            "expectedTurnId":question["turnId"],"expectedFingerprint":question["fingerprint"],
            "answers":{"question-0":["Blue"]},"writeInQuestionIds":[],
        }))?;

        let read_only = Backend::from_config(
            "reader".into(),
            "Reader".into(),
            &config,
            true,
            &capabilities,
        )?;
        let reader_view = read_only
            .read("thread.read", &params, &Value::Null)
            .await?
            .context("Missing read-only history")?;
        assert_eq!(reader_view["thread"]["owner"], false);
        assert_eq!(reader_view["thread"]["requests"][0]["actionable"], false);
        assert!(matches!(
            answer_question(&read_only, &answer).await,
            Delivery::Rejected(_)
        ));
        let full_reads = fixture.lock().unwrap().full_reads;
        assert_eq!(full_reads, 2);

        let mut stale = answer.clone();
        stale.expected_fingerprint = "0".repeat(64);
        assert!(matches!(
            answer_question(&backend, &stale).await,
            Delivery::Rejected(_)
        ));
        for (trajectory, total, running) in [
            (REPLACEMENT, TOTAL, true),
            (TRAJECTORY, TOTAL - 1, true),
            (TRAJECTORY, TOTAL, false),
            (TRAJECTORY, TOTAL + 1, true),
        ] {
            {
                let mut fixture = fixture.lock().unwrap();
                fixture.trajectory = trajectory;
                fixture.total = total;
                fixture.running = running;
            }
            assert!(matches!(
                answer_question(&backend, &answer).await,
                Delivery::Rejected(_)
            ));
        }
        let cursor = format!("steps:{TRAJECTORY}:{}:{TOTAL}", TOTAL + 1);
        let older = backend
            .read("history.read", &params, &json!({"cursor":cursor}))
            .await?
            .context("Missing older history")?;
        assert_eq!(older["thread"]["requests"], json!([]));

        {
            let mut fixture = fixture.lock().unwrap();
            assert!(fixture.answer.is_none());
            fixture.total = TOTAL;
            fixture.windows.clear();
            fixture.drop_answer_receipt = true;
        }
        assert!(matches!(
            answer_question(&backend, &answer).await,
            Delivery::Completed(None)
        ));
        {
            let fixture = fixture.lock().unwrap();
            assert_eq!(
                fixture.windows,
                [QUESTION_INDEX..TOTAL, QUESTION_INDEX..TOTAL]
            );
            assert_eq!(fixture.full_reads, full_reads);
            assert_eq!(
                fixture.answer,
                Some(json!({
                    "cascadeId":THREAD,"interaction":{
                        "trajectoryId":TRAJECTORY,"stepIndex":QUESTION_INDEX,
                        "askQuestion":{"responses":[{
                            "question":"Choose a color","options":[{"id":"blue-id","text":"Blue"}],
                            "isMultiSelect":false,"selectedOptionIds":["blue-id"],
                        }]},
                    },
                }))
            );
        }
        let continued = backend
            .read("thread.read", &params, &Value::Null)
            .await?
            .context("Missing continuation")?;
        assert_eq!(continued["thread"]["pendingRequests"], 0);
        assert_eq!(
            continued["messages"].as_array().unwrap().last().unwrap()["text"],
            "Continued after the answer"
        );
        {
            let mut fixture = fixture.lock().unwrap();
            // A completed native interaction must win even if its step still says WAITING.
            fixture.running = true;
            fixture.total = TOTAL;
        }
        assert!(matches!(
            answer_question(&backend, &answer).await,
            Delivery::Rejected(_)
        ));
        assert_eq!(fixture.lock().unwrap().full_reads, full_reads);
        server.abort();
        Ok(())
    }

    #[tokio::test]
    async fn bounded_question_becomes_inactive_when_live_paging_fails() -> Result<()> {
        let home = tempfile::tempdir()?;
        let (fixture, server) = serve(home.path(), home.path().join("fixture.png")).await;
        {
            let mut fixture = fixture.lock().unwrap();
            fixture.running = true;
            fixture.question = true;
        }
        let backend = Arc::new(Backend::from_config(
            "fixture".into(),
            "Fixture".into(),
            &json!({"home":home.path()}),
            false,
            &json!({"boundedQuestionResponses":true}),
        )?);
        let live = backend.subscribe(THREAD)?;
        let mut watcher = live.0.clone();
        tokio::time::timeout(Duration::from_secs(5), watcher.changed()).await??;
        let initial = watcher
            .borrow_and_update()
            .clone()
            .context("Missing live question")?;
        assert_eq!(initial.thread["synchronized"], true);
        assert_eq!(initial.thread["requests"][0]["actionable"], true);
        fixture.lock().unwrap().invalid_indices = true;
        tokio::time::timeout(Duration::from_secs(5), watcher.changed()).await??;
        let stale = watcher
            .borrow_and_update()
            .clone()
            .context("Missing stale live view")?;
        assert_eq!(stale.thread["synchronized"], false);
        assert_eq!(stale.thread["requests"][0]["actionable"], false);
        fixture.lock().unwrap().invalid_indices = false;
        tokio::time::timeout(Duration::from_secs(5), watcher.changed()).await??;
        let recovered = watcher
            .borrow()
            .clone()
            .context("Missing recovered live view")?;
        assert_eq!(recovered.thread["synchronized"], true);
        assert_eq!(recovered.thread["requests"][0]["actionable"], true);
        assert_eq!(fixture.lock().unwrap().full_reads, 1);
        server.abort();
        Ok(())
    }

    #[tokio::test]
    async fn oversized_history_browses_absolute_step_ranges_and_supports_live_tail_writes()
    -> Result<()> {
        let home = tempfile::tempdir()?;
        let directory = home
            .path()
            .join("brain")
            .join(THREAD)
            .join(".user_uploaded");
        fs::create_dir_all(&directory)?;
        let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC")?;
        let image = directory.join("fixture.png");
        fs::write(&image, &png)?;
        let (fixture, server) = serve(home.path(), image).await;
        let backend = Arc::new(Backend::from_config(
            "fixture".to_owned(),
            "Fixture".to_owned(),
            &json!({"home":home.path()}),
            false,
            &Value::Null,
        )?);
        let live = backend.clone().subscribe(THREAD)?;
        let mut watcher = live.0.clone();
        tokio::time::timeout(Duration::from_secs(5), watcher.changed()).await??;
        let view = watcher.borrow().clone().context("Missing cold view")?;
        drop(watcher);
        drop(live);
        assert_eq!(view.thread["id"], THREAD);
        assert_eq!(view.thread["historyTrajectoryId"], TRAJECTORY);
        assert_eq!(view.thread["historyStepCount"], TOTAL);
        assert_eq!(view.thread["synchronized"], true);
        assert_eq!(view.thread["owner"], true);
        assert_eq!(view.thread["canSend"], true);
        assert_eq!(view.thread["canSteer"], false);
        assert_eq!(view.thread["canInterrupt"], false);
        assert_eq!(view.thread["requests"], json!([]));
        assert!(view.observations.is_empty());
        assert_eq!(view.messages.len(), 50);
        assert_eq!(view.messages[0]["id"], "antigravity-step-97");
        assert_eq!(view.messages[49]["id"], "antigravity-step-146");
        assert_eq!(
            view.messages[2]["attachments"][0]["path"],
            "antigravity-image:99:0"
        );
        assert_eq!(fixture.lock().unwrap().full_reads, 1);

        let params = json!({"id":THREAD});
        let latest = backend
            .read("history.read", &params, &Value::Null)
            .await?
            .unwrap();
        let cursor = latest["nextCursor"].clone();
        assert_eq!(cursor, format!("steps:{TRAJECTORY}:147:97"));
        let older = backend
            .read("history.read", &params, &json!({"cursor":cursor}))
            .await?
            .unwrap();
        assert_eq!(older["nextCursor"], Value::Null);
        assert_eq!(older["thread"]["synchronized"], false);
        assert_eq!(older["thread"]["canSend"], false);
        assert_eq!(older["messages"][0]["id"], "antigravity-step-0");
        assert_eq!(older["messages"][96]["id"], "antigravity-step-96");
        assert_eq!(older["messages"][17]["truncated"], true);
        let detail = backend
            .read(
                "content.read",
                &params,
                &json!({"messageId":"antigravity-step-17"}),
            )
            .await?
            .unwrap();
        assert_eq!(detail["message"]["id"], "antigravity-step-17");
        assert_eq!(detail["message"]["output"].as_str().unwrap().len(), 20_000);
        let Media::Download(mut source) = backend.media(THREAD, "antigravity-image:99:0").await?
        else {
            panic!("Expected local photo download");
        };
        let mut downloaded = Vec::new();
        source.file.read_to_end(&mut downloaded)?;
        assert_eq!(downloaded, png);
        assert_eq!(fixture.lock().unwrap().full_reads, 1);
        assert_eq!(
            fixture.lock().unwrap().windows,
            [
                0..0,
                47..147,
                97..147,
                0..0,
                47..147,
                97..147,
                0..97,
                17..18,
                99..100,
            ]
        );

        // A replaced trajectory, rewind, or invalid row order cannot satisfy an older cursor.
        for (trajectory, total, invalid_indices) in [
            (REPLACEMENT, TOTAL, false),
            (TRAJECTORY, TOTAL - 1, false),
            (TRAJECTORY, TOTAL, true),
        ] {
            {
                let mut fixture = fixture.lock().unwrap();
                fixture.trajectory = trajectory;
                fixture.total = total;
                fixture.invalid_indices = invalid_indices;
            }
            assert!(
                backend
                    .read("history.read", &params, &json!({"cursor":cursor}))
                    .await
                    .is_err()
            );
        }
        {
            let mut fixture = fixture.lock().unwrap();
            fixture.trajectory = TRAJECTORY;
            fixture.total = TOTAL;
            fixture.invalid_indices = false;
        }
        let sent = backend
            .write(
                THREAD,
                Uuid::new_v4(),
                Write::Send {
                    text: "fixture live tail send".to_owned(),
                    files: Vec::new(),
                    skills: Vec::new(),
                    plugin_ids: Vec::new(),
                    model: None,
                },
                None,
                &|_| panic!("Sending must not create"),
            )
            .await;
        assert!(matches!(sent, Delivery::Accepted(None)));
        assert_eq!(fixture.lock().unwrap().full_reads, 1);

        {
            let mut fixture = fixture.lock().unwrap();
            fixture.oversized = false;
        }
        backend.oversized_history.lock().unwrap().clear();
        let normal = backend
            .read("thread.read", &params, &Value::Null)
            .await?
            .unwrap();
        assert_eq!(normal["thread"]["synchronized"], true);
        assert_eq!(normal["thread"]["historyTrajectoryId"], TRAJECTORY);
        assert_eq!(normal["thread"]["historyStepCount"], 1);
        assert_eq!(normal["thread"]["canSend"], true);
        assert_eq!(normal["messages"][0]["id"], "antigravity-step-0");
        server.abort();
        Ok(())
    }
}
