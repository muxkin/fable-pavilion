use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use uuid::Uuid;

const PAGE_SIZE: usize = 30;
const HISTORY_BYTES: u64 = 512 * 1024;
const VISIBLE: &str = "archived=0 AND is_visible";
const PROJECT: &str = "COALESCE(threads.project_id,assignment.value)";
const PROJECT_JOIN: &str = "LEFT JOIN json_each(?1) assignment ON assignment.key=threads.id";
const FIELDS: &str = "threads.id,COALESCE(name,title),cwd,updated_at_ms,COALESCE(threads.project_id,assignment.value)";

fn speeds(tiers: &Value) -> Vec<Value> {
    let mut speeds = vec![json!({"id":"default","name":"标准","description":"标准速度与用量"})];
    speeds.extend(tiers.as_array().into_iter().flatten().filter_map(|tier| {
        let id = tier["id"].as_str().filter(|id| *id != "default")?;
        Some(json!({"id":id,"name":tier["name"].as_str().unwrap_or(id),
            "description":tier["description"].as_str().unwrap_or("")}))
    }));
    speeds
}

pub(crate) fn live_models(data: &[Value]) -> Result<Value> {
    let mut ids = HashSet::new();
    let mut models = Vec::new();
    for model in data.iter().filter(|model| model["hidden"] != true) {
        let id = model["model"]
            .as_str()
            .or_else(|| model["id"].as_str())
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .context("Codex 模型名称无效")?;
        ensure!(ids.insert(id), "Codex 模型目录存在重复项");
        let efforts: Vec<_> = model["supportedReasoningEfforts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|level| level["reasoningEffort"].as_str())
            .collect();
        models.push(
            json!({"id":id,"name":model["displayName"].as_str().unwrap_or(id),
            "efforts":efforts,"defaultEffort":model["defaultReasoningEffort"],
            "speeds":speeds(&model["serviceTiers"])}),
        );
    }
    Ok(json!({"models":models,"fetchedAt":null,"source":"desktop-app-server"}))
}

fn cached_models(data: &Value, filename: &str) -> Value {
    let models: Vec<_> = data["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| model["visibility"] == "list")
        .filter_map(|model| {
            let id = model["slug"].as_str()?;
            let efforts: Vec<_> = model["supported_reasoning_levels"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|level| level["effort"].as_str())
                .collect();
            Some(
                json!({"id":id,"name":model["display_name"].as_str().unwrap_or(id),
                "efforts":efforts,"defaultEffort":model["default_reasoning_level"],
                "speeds":speeds(&model["service_tiers"])}),
            )
        })
        .collect();
    json!({"models":models,"fetchedAt":data["fetched_at"],
        "source":if filename == "models_cache.json" {"codex-cache"} else {"desktop-cache"}})
}

#[derive(Clone)]
pub struct History {
    home: PathBuf,
    host_key: String,
    queued: Arc<Mutex<Option<QueueFile>>>,
    rollouts: crate::history_media::Rollouts,
    replies: crate::reply_history::ReplyHistory,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    id: String,
    title: String,
    cwd: String,
    updated_at: i64,
    project_id: Option<String>,
    project_name: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    time: i64,
    id: String,
}

struct QueueFile {
    modified: SystemTime,
    length: u64,
    rows: Value,
}

struct ProjectIndex {
    names: HashMap<String, String>,
    order: Vec<String>,
    memberships: String,
}

fn columns(db: &Connection, table: &str) -> Result<HashSet<String>> {
    Ok(db
        .prepare("SELECT name FROM pragma_table_info(?1,'main')")?
        .query_map([table], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

fn configure_history(db: &Connection) -> Result<()> {
    let threads = columns(db, "threads")?;
    ensure!(
        ["id", "title", "cwd", "archived", "rollout_path"]
            .iter()
            .all(|column| threads.contains(*column)),
        "Codex 历史数据库缺少必要的会话列"
    );
    let name = if threads.contains("name") {
        "name"
    } else {
        "NULL"
    };
    let project = if threads.contains("project_id") {
        "project_id"
    } else {
        "NULL"
    };
    let updated = match (
        threads.contains("updated_at_ms"),
        threads.contains("updated_at"),
    ) {
        (true, true) => "COALESCE(updated_at_ms, updated_at * 1000, 0)",
        (true, false) => "COALESCE(updated_at_ms, 0)",
        (false, true) => "COALESCE(updated_at * 1000, 0)",
        (false, false) => anyhow::bail!("Codex 历史数据库缺少会话时间"),
    };
    let visible = if threads.contains("thread_source") {
        "(thread_source IN ('user','agent_created_thread') OR thread_source IS NULL)"
    } else if threads.contains("source") {
        // Older indexes store subagents in the source field as tagged JSON.
        "CASE WHEN json_valid(source) THEN json_type(source, '$.subagent') IS NULL
              ELSE COALESCE(source != 'subagent', 1) END"
    } else {
        "1"
    };
    let projects = columns(db, "projects")?;
    let projects = if projects.contains("id") && projects.contains("name") {
        let position = if projects.contains("position") {
            "position"
        } else {
            "0"
        };
        format!("SELECT id, name, {position} AS position FROM main.projects")
    } else {
        "SELECT NULL AS id, NULL AS name, 0 AS position WHERE 0".into()
    };
    db.execute_batch(&format!(
        "CREATE TEMP VIEW threads AS
           SELECT id, title, cwd, archived, rollout_path,
                  {name} AS name, {project} AS project_id, {updated} AS updated_at_ms,
                  {visible} AS is_visible FROM main.threads;
         CREATE TEMP VIEW projects AS {projects};"
    ))?;
    Ok(())
}

impl History {
    pub fn open(home: &Path) -> Result<Self> {
        let history = Self {
            home: home.canonicalize()?,
            host_key: format!("local:{}", std::path::absolute(home)?.display()),
            queued: Default::default(),
            rollouts: Default::default(),
            replies: Default::default(),
        };
        history.database()?.prepare(&format!(
            "SELECT {FIELDS},rollout_path FROM threads {PROJECT_JOIN} WHERE {VISIBLE} LIMIT 0"
        ))?;
        Ok(history)
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    fn database(&self) -> Result<Connection> {
        let mut candidates = Vec::new();
        for entry in fs::read_dir(&self.home)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(version) = name
                .to_str()
                .and_then(|name| name.strip_prefix("state_"))
                .and_then(|name| name.strip_suffix(".sqlite"))
                .filter(|version| version.bytes().all(|byte| byte.is_ascii_digit()))
                .and_then(|version| version.parse::<u64>().ok())
            else {
                continue;
            };
            let path = entry.path();
            if path.is_file() {
                candidates.push((version, path));
            }
        }
        candidates.sort_unstable_by(|first, second| second.cmp(first));
        let mut first_error = None;
        for (_, path) in candidates {
            let open = || -> Result<Connection> {
                let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
                db.busy_timeout(Duration::from_millis(500))?;
                configure_history(&db)?;
                Ok(db)
            };
            match open() {
                Ok(db) => return Ok(db),
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        Err(first_error.unwrap_or_else(|| anyhow::anyhow!("未找到 Codex 历史数据库")))
    }

    pub fn latest_thread(&self) -> Result<Option<Uuid>> {
        let id: Option<String> = self
            .database()?
            .query_row(
                &format!(
                    "SELECT id FROM threads WHERE {VISIBLE} ORDER BY updated_at_ms DESC LIMIT 1"
                ),
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(id.and_then(|id| Uuid::parse_str(&id).ok()))
    }

    pub fn anchor(&self, thread: &str) -> Result<String> {
        if thread == "new" {
            return Ok(self
                .latest_thread()?
                .map_or_else(|| "new".into(), |id| id.to_string()));
        }
        let id = Uuid::parse_str(thread)?.to_string();
        let exists: bool = self.database()?.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1 AND {VISIBLE})"),
            [&id],
            |row| row.get(0),
        )?;
        ensure!(exists, "找不到会话");
        Ok(id)
    }

    pub fn tools(&self, id: Uuid, disabled: &[String]) -> Result<crate::tools_catalog::Catalog> {
        let cwd: String = self.database()?.query_row(
            &format!("SELECT cwd FROM threads WHERE id=?1 AND {VISIBLE}"),
            [id.to_string()],
            |row| row.get(0),
        )?;
        crate::tools_catalog::Catalog::scan(&self.home, Path::new(&cwd), disabled)
    }

    fn global_state(&self) -> Result<Value> {
        match fs::read(self.home.join(".codex-global-state.json")) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
            Err(error) => Err(error.into()),
        }
    }

    pub fn native_queue(&self, thread: Uuid) -> Result<Vec<Value>> {
        let path = self.home.join(".codex-global-state.json");
        let info = path.metadata()?;
        let modified = info.modified()?;
        ensure!(info.len() <= 32 * 1024 * 1024, "桌面队列文件过大");
        let mut cached = self.queued.lock().expect("queue mutex poisoned");
        if cached
            .as_ref()
            .is_none_or(|old| old.modified != modified || old.length != info.len())
        {
            let mut file = File::open(path)?;
            let mut data = Vec::with_capacity(info.len() as usize);
            (&mut file)
                .take(32 * 1024 * 1024 + 1)
                .read_to_end(&mut data)?;
            ensure!(data.len() <= 32 * 1024 * 1024, "桌面队列文件过大");
            let mut value: Value = serde_json::from_slice(&data)?;
            let rows = value["queued-follow-ups"].take();
            ensure!(rows.is_object(), "此桌面版本未提供原生队列");
            *cached = Some(QueueFile {
                modified,
                length: info.len(),
                rows,
            });
        }
        let value = &cached.as_ref().unwrap().rows[&thread.to_string()];
        if value.is_null() {
            Ok(Vec::new())
        } else {
            value.as_array().cloned().context("桌面队列格式无效")
        }
    }

    pub fn project_aliases(&self) -> Result<Value> {
        let mut state = self.global_state()?;
        Ok(state["app-server-project-id-by-legacy-project-id-by-host"][&self.host_key].take())
    }

    fn model_cache(&self, name: &str) -> Result<Option<Value>> {
        let file = match File::open(self.home.join(name)) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let mut bytes = Vec::new();
        file.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 8 * 1024 * 1024, "Codex 模型缓存过大");
        let data: Value = serde_json::from_slice(&bytes)?;
        ensure!(data["models"].is_array(), "Codex 模型缓存格式无效");
        Ok(Some(cached_models(&data, name)))
    }

    pub(crate) fn desktop_models(&self) -> Result<Option<Value>> {
        // The Desktop and CLI use different catalogs even for the same login.
        self.model_cache("models_cache.codex_work_desktop.json")
    }

    pub fn models(&self) -> Result<Value> {
        let desktop = match self.desktop_models() {
            Ok(Some(catalog)) => return Ok(catalog),
            other => other,
        };
        if let Some(catalog) = self.model_cache("models_cache.json")? {
            return Ok(catalog);
        }
        desktop?;
        Ok(json!({"models":[],"fetchedAt":null,"source":"unavailable"}))
    }

    pub fn rpc(&self, method: &str, params: &Value, query: &Value) -> Result<Option<Value>> {
        match method {
            "models.list" => self.models().map(Some),
            "threads.list" => self.threads(query).map(Some),
            "projects.list" => self.projects().map(Some),
            "thread.read" | "history.read" => {
                let id = params["id"].as_str().context("会话 ID 无效")?;
                let db = self.database()?;
                let projects = self.project_index(&db)?;
                let Some((thread, path)) = db.query_row(
                    &format!("SELECT {FIELDS},rollout_path FROM threads {PROJECT_JOIN} WHERE threads.id=?2 AND {VISIBLE}"),
                    params![projects.memberships, id],
                    |row| Ok((read_thread(row, &projects.names)?, row.get::<_, Option<String>>(5)?)),
                ).optional()? else { return Ok(None); };
                if method == "thread.read" {
                    return Ok(Some(json!({"thread": thread})));
                }
                let path = path
                    .filter(|path| !path.is_empty())
                    .ok_or(crate::history_media::HistoryUnavailable)?;
                let page = self.read_page(id, Path::new(&path), query["cursor"].as_str())?;
                Ok(Some(
                    json!({"thread": thread, "messages": page.0, "nextCursor": page.1}),
                ))
            }
            _ => Ok(None),
        }
    }

    fn threads(&self, query: &Value) -> Result<Value> {
        let search = query["q"].as_str().unwrap_or("").trim();
        let project = query["project"].as_str();
        ensure!(search.encode_utf16().count() <= 120, "搜索过长");
        let cursor = query["cursor"]
            .as_str()
            .map(|value| {
                ensure!(value.len() <= 1024, "游标过长");
                Ok::<Cursor, anyhow::Error>(serde_json::from_slice(
                    &URL_SAFE_NO_PAD.decode(value)?,
                )?)
            })
            .transpose()?;
        let db = self.database()?;
        let projects = self.project_index(&db)?;
        let lower = search.to_lowercase();
        let matching: Vec<_> = projects
            .names
            .iter()
            .filter(|(_, name)| name.to_lowercase().contains(&lower))
            .map(|(id, _)| id)
            .collect();
        let mut stmt = db.prepare(&format!(
            "SELECT {FIELDS} FROM threads {PROJECT_JOIN} WHERE {VISIBLE}
             AND (?2 IS NULL OR (?2='none' AND {PROJECT} IS NULL) OR {PROJECT}=?2)
             AND (?3='' OR instr(lower(COALESCE(name,title)), lower(?3))>0 OR {PROJECT} IN (SELECT value FROM json_each(?4)))
             AND (?5 IS NULL OR updated_at_ms<?5 OR (updated_at_ms=?5 AND threads.id<?6))
             ORDER BY updated_at_ms DESC,threads.id DESC LIMIT ?7"
        ))?;
        let mut threads = stmt
            .query_map(
                params![
                    projects.memberships,
                    project,
                    search,
                    serde_json::to_string(&matching)?,
                    cursor.as_ref().map(|c| c.time),
                    cursor.as_ref().map(|c| &c.id),
                    PAGE_SIZE as i64 + 1,
                ],
                |row| read_thread(row, &projects.names),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let next = if threads.len() > PAGE_SIZE {
            threads.truncate(PAGE_SIZE);
            let last = &threads[PAGE_SIZE - 1];
            Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Cursor {
                time: last.updated_at,
                id: last.id.clone(),
            })?))
        } else {
            None
        };
        Ok(json!({"threads": threads, "nextCursor": next}))
    }

    fn project_index(&self, db: &Connection) -> Result<ProjectIndex> {
        let mut stmt = db.prepare("SELECT id,name FROM projects ORDER BY position,id")?;
        let native = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut order: Vec<_> = native.iter().map(|(id, _)| id.clone()).collect();
        let mut names: HashMap<_, _> = native.into_iter().collect();
        let state = self.global_state()?;
        let aliases = &state["app-server-project-id-by-legacy-project-id-by-host"][&self.host_key];
        let canonical = |id: &str| aliases[id].as_str().unwrap_or(id).to_owned();
        if let Some(legacy) = state["local-projects"].as_object() {
            for project in legacy.values() {
                if let (Some(id), Some(name)) = (project["id"].as_str(), project["name"].as_str()) {
                    let id = canonical(id);
                    if let std::collections::hash_map::Entry::Vacant(entry) =
                        names.entry(id.clone())
                    {
                        order.push(id);
                        entry.insert(name.to_owned());
                    }
                }
            }
        }
        let projectless: HashSet<_> = state["projectless-thread-ids"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let memberships: HashMap<_, _> = state["thread-project-assignments"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(thread, assignment)| {
                let id = canonical(assignment["projectId"].as_str()?);
                (!projectless.contains(thread.as_str())
                    && assignment["projectKind"] == "local"
                    && names.contains_key(&id))
                .then_some((thread, id))
            })
            .collect();
        Ok(ProjectIndex {
            names,
            order,
            memberships: serde_json::to_string(&memberships)?,
        })
    }

    fn projects(&self) -> Result<Value> {
        let db = self.database()?;
        let index = self.project_index(&db)?;
        let mut stmt = db.prepare(&format!(
            "SELECT {PROJECT},COUNT(*) FROM threads {PROJECT_JOIN} WHERE {VISIBLE} GROUP BY {PROJECT}"
        ))?;
        let counts: HashMap<Option<String>, i64> = stmt
            .query_map([index.memberships], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let projects: Vec<_> = index.order.iter().map(|id| json!({
            "id": id, "name": index.names[id], "count": counts.get(&Some(id.clone())).copied().unwrap_or_default()
        })).collect();
        Ok(
            json!({"projects":projects,"total":counts.values().sum::<i64>(),"ungrouped":counts.get(&None).copied().unwrap_or_default()}),
        )
    }

    pub fn media_context(&self, thread: Uuid) -> Result<(PathBuf, PathBuf)> {
        Ok(self.database()?.query_row(
            &format!("SELECT cwd,rollout_path FROM threads WHERE id=?1 AND {VISIBLE}"),
            [thread.to_string()],
            |row| {
                Ok((
                    PathBuf::from(row.get::<_, String>(0)?),
                    PathBuf::from(row.get::<_, String>(1)?),
                ))
            },
        )?)
    }

    pub fn open_rollout(&self, path: &Path) -> Result<File> {
        use crate::history_media::HistoryUnavailable;

        let path = self.home.join(path);
        let path = path
            .canonicalize()
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound
                    && path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
                {
                    path.with_extension("jsonl.zst").canonicalize()
                } else {
                    Err(error)
                }
            })
            .map_err(|_| HistoryUnavailable)?;
        let allowed = ["sessions", "archived_sessions"].iter().any(|root| {
            let directory = self.home.join(root);
            directory
                .canonicalize()
                .is_ok_and(|resolved| resolved == directory && path.starts_with(resolved))
        });
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if !allowed || !(name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")) {
            return Err(HistoryUnavailable.into());
        }
        self.rollouts
            .open(&path)
            .map_err(|_| HistoryUnavailable.into())
    }

    pub fn content(&self, id: Uuid, message_id: &str) -> Result<Option<Value>> {
        let Some(offset) = message_id
            .strip_prefix("rollout-")
            .and_then(|offset| offset.parse::<u64>().ok())
        else {
            return Ok(None);
        };
        let (_, path) = self.media_context(id)?;
        let mut file = self.open_rollout(&path)?;
        ensure!(offset < file.metadata()?.len(), "消息偏移无效");
        if offset > 0 {
            file.seek(SeekFrom::Start(offset - 1))?;
            let mut before = [0];
            file.read_exact(&mut before)?;
            ensure!(before == [b'\n'], "消息偏移无效");
        }
        let mut line = Vec::new();
        BufReader::new(file)
            .take(crate::history_media::MAX_LINE)
            .read_until(b'\n', &mut line)?;
        if line.last() != Some(&b'\n') {
            return Ok(None);
        }
        Ok(rollout_message(&line, &id.to_string(), offset, true)
            .filter(|message| message["id"] == message_id)
            .map(|message| json!({"message":message})))
    }

    pub(crate) fn has_saved_reply(&self, thread: Uuid, turn: &str) -> Result<bool> {
        let (_, path) = self.media_context(thread)?;
        let mut file = self.open_rollout(&path)?;
        Ok(self
            .replies
            .read(&thread.to_string(), &mut file)?
            .contains(turn))
    }

    fn read_page(
        &self,
        id: &str,
        path: &Path,
        cursor: Option<&str>,
    ) -> Result<(Vec<Value>, Option<String>)> {
        let mut file = self.open_rollout(path)?;
        let length = file.metadata()?.len();
        let end = cursor.map(str::parse::<u64>).transpose()?.unwrap_or(length);
        ensure!(end <= length, "历史游标已失效");
        let mut window = HISTORY_BYTES;
        let mut read_end = end;
        let (start, boundary, messages) = loop {
            let start = end.saturating_sub(window);
            let offset = start.saturating_sub(1);
            file.seek(SeekFrom::Start(offset))?;
            let mut bytes = Vec::with_capacity((read_end - offset) as usize);
            (&mut file)
                .take(read_end - offset)
                .read_to_end(&mut bytes)?;
            let first = if start == 0 {
                0
            } else {
                bytes
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .map_or(bytes.len(), |position| position + 1)
            };
            let boundary = offset + first as u64;
            let mut offset = boundary;
            let mut messages = Vec::new();
            for line in bytes[first..].split_inclusive(|byte| *byte == b'\n') {
                if line.ends_with(b"\n") {
                    if let Some(message) = rollout_message(line, id, offset, false) {
                        messages.push((offset, message));
                    }
                }
                offset += line.len() as u64;
            }
            // A large record or a suffix of internal events can hide the last visible message.
            if start == 0 || !messages.is_empty() || window >= crate::history_media::MAX_LINE {
                break (start, boundary, messages);
            }
            // Complete records in the newer suffix cannot contribute any rows.
            // Retain the leading partial record so expanding still recovers it.
            read_end = boundary;
            window = (window * 2).min(crate::history_media::MAX_LINE);
        };
        let skipped = messages.len().saturating_sub(100);
        let next = if skipped > 0 {
            Some(messages[skipped].0.to_string())
        } else {
            (start > 0).then(|| {
                // A single large record can span the entire window. Skip it without looping.
                if boundary >= end {
                    start.to_string()
                } else {
                    boundary.to_string()
                }
            })
        };
        let first_reply = messages.iter().skip(skipped).find_map(|(offset, message)| {
            (message["role"] == "assistant" && message["phase"] != "commentary").then_some(*offset)
        });
        let replies = first_reply
            .and_then(|offset| self.replies.page(id, &mut file, offset..end, length).ok());
        Ok((
            messages
                .into_iter()
                .skip(skipped)
                .map(|(offset, mut message)| {
                    if let Some(replies) = &replies {
                        replies.mark(offset, &mut message);
                    }
                    message
                })
                .collect(),
            next,
        ))
    }
}

fn read_thread(row: &Row<'_>, names: &HashMap<String, String>) -> rusqlite::Result<Thread> {
    let project_id: Option<String> = row.get(4)?;
    let project_name = project_id.as_ref().and_then(|id| names.get(id)).cloned();
    Ok(Thread {
        id: row.get(0)?,
        title: row.get(1)?,
        cwd: row.get(2)?,
        updated_at: row.get(3)?,
        project_id,
        project_name,
    })
}

fn rollout_message(line: &[u8], thread: &str, offset: u64, full: bool) -> Option<Value> {
    let record: Value = serde_json::from_slice(line).ok()?;
    let created_at = record["timestamp"]
        .as_str()
        .map(crate::state::rfc3339_ms)
        .filter(|&ts| ts > 0);
    let attach_ts = |mut entry: Value| {
        if let Some(ts) = created_at
            && entry.get("createdAt").is_none()
        {
            entry["createdAt"] = json!(ts);
        }
        entry
    };
    let message = &record["payload"];
    if record["type"] == "realtime_item" && message["type"] == "transcript_segment" {
        let role = message["role"].as_str()?;
        if !matches!(role, "user" | "assistant") {
            return None;
        }
        return text_message(
            offset,
            role,
            message["text"].as_str()?.to_owned(),
            Vec::new(),
            full,
        )
        .map(attach_ts);
    }
    if record["type"] == "event_msg" && message["type"] == "task_complete" {
        return crate::tool_activity::turn_timing(
            message["turn_id"].as_str()?,
            None,
            Some(message["duration_ms"].as_u64()?),
        );
    }
    if record["type"] == "event_msg"
        && message["type"] == "item_completed"
        && message["thread_id"] == thread
    {
        let item = &message["item"];
        let id = format!("rollout-{offset}");
        let turn = message["turn_id"].as_str();
        // The corresponding response_item contains another copy of the tool output.
        // Project only the completed item, whose envelope identifies this thread and turn.
        if item["type"] == "FunctionCallOutput"
            && let Some(input) = crate::codex_live::delegated_input(item)
        {
            let (text, attachments) = crate::files::message_attachment_text(&input);
            return text_message(
                offset,
                "user",
                crate::requests::display_reply(text),
                attachments,
                full,
            )
            .map(|entry| attach_ts(with_native_fields(entry, item, turn)));
        }
        if let Some(event) = crate::tool_activity::timeline_event(item, &id, turn) {
            return Some(attach_ts(with_native_fields(event, item, turn)));
        }
        let text = crate::tool_activity::summary(item)?;
        let mut projected = json!({
            "id":format!("rollout-{offset}"),"role":"tool","text":text,"turnId":message["turn_id"],
        });
        let actions = crate::tool_activity::action_kinds(item);
        if !actions.is_empty() {
            projected["toolActions"] = json!(actions);
        }
        if let Some(details) = crate::tool_activity::details(item) {
            if full {
                crate::tool_activity::apply_details(&mut projected, &details);
            } else {
                projected["deferred"] = json!(true);
            }
        }
        return Some(attach_ts(with_native_fields(projected, item, turn)));
    }
    if record["type"] != "response_item" {
        return None;
    }
    let role = message["role"].as_str().unwrap_or_default();
    if message["type"] != "message" || !matches!(role, "user" | "assistant") {
        let attachments = crate::history_media::attachments(Vec::new(), message);
        return (!attachments.is_empty()).then(|| {
            attach_ts(json!({"id":format!("rollout-{offset}:media:0"),
            "role":"assistant","text":"","attachments":attachments}))
        });
    }
    let metadata = &message["internal_chat_message_metadata_passthrough"];
    let content = &message["content"];
    let text = if role == "user" {
        crate::codex_live::native_user_text(content, message)
    } else {
        crate::codex_live::native_text(content)
    };
    if role == "user" && text.trim_start().starts_with("<environment_context>") {
        return None;
    }
    let (text, explicit) = if role == "user" {
        let (text, explicit) = crate::files::message_attachment_text(&text);
        (crate::requests::display_reply(text), explicit)
    } else {
        (text, Vec::new())
    };
    let attachments = crate::history_media::attachments(explicit, message);
    text_message(offset, role, text, attachments, full)
        .map(|entry| attach_ts(with_native_fields(entry, message, metadata["turn_id"].as_str())))
}

fn with_native_fields(mut message: Value, item: &Value, turn: Option<&str>) -> Value {
    // Keep the rollout offset as the public id used to resolve full text and details.
    if let Some(id) = item["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control))
    {
        message["nativeItemId"] = json!(id);
    }
    if let Some(turn) = turn.filter(|turn| !turn.is_empty()) {
        message["turnId"] = json!(turn);
    }
    if message["role"] == "assistant"
        && let Some(phase @ ("commentary" | "final_answer")) = item["phase"].as_str()
    {
        message["phase"] = json!(phase);
    }
    message
}

fn text_message(
    offset: u64,
    role: &str,
    text: String,
    attachments: Vec<Value>,
    full: bool,
) -> Option<Value> {
    let mut text = text;
    let limit = 2 * 1024 * 1024;
    if full && text.len() > limit {
        return None;
    }
    let truncated = !full && text.len() > 12_000 && text.len() <= limit;
    if !full && text.len() > 12_000 {
        let too_large = text.len() > limit;
        text.truncate(text.floor_char_boundary(12_000));
        if too_large {
            text.push_str("\n请在桌面查看完整内容。");
        }
    }
    (!text.is_empty() || !attachments.is_empty()).then(|| {
        json!({"id":format!("rollout-{offset}"),"role":role,"text":text,
            "attachments":attachments,"truncated":truncated})
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn goal_context_is_removed_from_normal_and_full_history() {
        let goal =
            "<codex_internal_context source=\"goal\">Fixture context</codex_internal_context>";
        let mut record = json!({"type":"response_item", "payload":{
            "type":"message", "role":"user", "id":"goal",
            "content":[{"type":"input_text", "text":goal}],
        }});
        assert!(rollout(record.clone()).is_none());

        record["payload"]["content"][0]["text"] = json!("Typed fixture context");
        record["payload"]["internal_chat_message_metadata_passthrough"] =
            json!({"content_item_kinds":["goal.internal_context"]});
        let raw = serde_json::to_vec(&record).unwrap();
        assert!(rollout_message(&raw, "thread", 100, true).is_none());

        let quoted = format!("Explain this XML: \n\n```xml\n{goal}\n```");
        record["payload"]["content"] = json!([
            {"type":"input_text", "text":"Typed fixture context"},
            {"type":"input_text", "text":quoted},
        ]);
        record["payload"]["internal_chat_message_metadata_passthrough"]["content_item_kinds"] =
            json!(["goal.internal_context", "plain_text"]);
        assert_eq!(rollout(record).unwrap()["text"], quoted);
    }

    #[test]
    fn model_cache_prefers_desktop_surface_and_reloads_without_restarting() -> Result<()> {
        let home = tempfile::tempdir()?;
        let history = History {
            home: home.path().to_owned(),
            host_key: "fixture".into(),
            queued: Default::default(),
            rollouts: Default::default(),
            replies: Default::default(),
        };
        let write = |name: &str, slug: &str, seconds: u64| -> Result<()> {
            let path = home.path().join(name);
            fs::write(&path, json!({"identity":"same-login","models":[
                {"slug":slug,"visibility":"list","supported_reasoning_levels":[{"effort":"new-effort"}]},
                {"slug":"hidden","visibility":"hide"},
            ]}).to_string())?;
            File::options().write(true).open(&path)?.set_times(
                std::fs::FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)),
            )?;
            Ok(())
        };
        let desktop = "models_cache.codex_work_desktop.json";
        write(desktop, "desktop-model", 100)?;
        write("models_cache.json", "newer-generic-model", 200)?;
        let current = history.models()?;
        assert_eq!(current["source"], "desktop-cache");
        assert_eq!(current["models"].as_array().unwrap().len(), 1);
        assert_eq!(current["models"][0]["id"], "desktop-model");
        assert_eq!(current["models"][0]["efforts"][0], "new-effort");
        write(desktop, "updated-desktop-model", 300)?;
        assert_eq!(
            history.models()?["models"][0]["id"],
            "updated-desktop-model"
        );
        // An explicitly empty desktop directory must not borrow the CLI's options.
        fs::write(home.path().join(desktop), r#"{"models":[]}"#)?;
        assert!(history.models()?["models"].as_array().unwrap().is_empty());
        fs::write(home.path().join(desktop), "{incomplete cache")?;
        assert_eq!(history.models()?["models"][0]["id"], "newer-generic-model");
        fs::remove_file(home.path().join(desktop))?;
        assert_eq!(history.models()?["models"][0]["id"], "newer-generic-model");
        Ok(())
    }

    #[test]
    fn live_model_catalog_keeps_native_options_and_never_invents_models() -> Result<()> {
        let catalog = live_models(&[
            json!({
                "id":"native-alias","model":"future-native-model","displayName":"Native supplied label",
                "hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"future-effort"}],
                "defaultReasoningEffort":"future-effort", "serviceTiers":[
                    {"id":"future-tier","name":"Native speed","description":"Native speed description"}
                ],
            }),
            json!({"model":"hidden","hidden":true}),
        ])?;
        assert_eq!(catalog["source"], "desktop-app-server");
        assert_eq!(catalog["models"].as_array().unwrap().len(), 1);
        assert_eq!(catalog["models"][0]["id"], "future-native-model");
        assert_eq!(catalog["models"][0]["efforts"][0], "future-effort");
        assert_eq!(catalog["models"][0]["speeds"][1]["id"], "future-tier");
        assert!(live_models(&[])?["models"].as_array().unwrap().is_empty());
        assert!(live_models(&[json!({"model":"same"}), json!({"model":"same"})]).is_err());
        Ok(())
    }

    #[test]
    fn history_pages_keep_a_large_reply_behind_the_completion_cursor() -> Result<()> {
        let home = tempfile::tempdir()?;
        let thread = Uuid::new_v4().to_string();
        let database = Connection::open(home.path().join("state_5.sqlite"))?;
        database.execute_batch(
            "CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, archived INTEGER,
                                   rollout_path TEXT, updated_at INTEGER);",
        )?;
        let relative = Path::new("sessions/rollout-test.jsonl");
        database.execute(
            "INSERT INTO threads VALUES (?1, 'Fixture', '/work', 0, ?2, 1000)",
            params![thread, relative.to_str()],
        )?;
        std::fs::create_dir(home.path().join("sessions"))?;
        let mut file = File::create(home.path().join(relative))?;
        let mut append = |value: Value| -> Result<u64> {
            let offset = file.stream_position()?;
            serde_json::to_writer(&mut file, &value)?;
            file.write_all(b"\n")?;
            Ok(offset)
        };
        let turn = "fixture-turn";
        append(json!({"type":"event_msg","payload":{"type":"task_started","turn_id":turn}}))?;
        let answer = append(json!({"type":"response_item","payload":{
            "type":"message", "id":"native-answer", "role":"assistant", "phase":"final_answer",
            "internal_chat_message_metadata_passthrough":{"turn_id":turn},
            "content":[{"type":"output_text","text":"answer ".repeat(110_000)}],
        }}))?;
        let completion = append(json!({"type":"event_msg","payload":{
            "type":"task_complete", "turn_id":turn, "duration_ms":1750,
        }}))?;
        assert!(completion - answer > HISTORY_BYTES);
        let history = History::open(home.path())?;
        let (latest, cursor) = history.read_page(&thread, relative, None)?;
        assert_eq!(latest.len(), 1);
        assert_eq!(latest[0]["codex"]["durationMs"], 1750);
        assert_eq!(cursor.as_deref(), Some(completion.to_string().as_str()));

        let (older, next) = history.read_page(&thread, relative, cursor.as_deref())?;
        assert_eq!(older.len(), 1);
        assert_eq!(older[0]["id"], format!("rollout-{answer}"));
        assert_eq!(older[0]["nativeItemId"], "native-answer");
        assert_eq!(older[0]["turnId"], turn);
        assert_eq!(older[0]["turnBoundary"], true);
        assert_eq!(older[0]["truncated"], true);
        assert!(next.is_none());
        Ok(())
    }

    #[test]
    fn reads_legacy_index_and_switches_to_newer_compatible_database() -> Result<()> {
        let home = tempfile::tempdir()?;
        let visible = Uuid::new_v4();
        let subagent = Uuid::new_v4();
        let archived = Uuid::new_v4();
        let legacy = Connection::open(home.path().join("state_4.sqlite"))?;
        legacy.execute_batch(
            "CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, archived INTEGER,
                                   rollout_path TEXT, source TEXT, updated_at INTEGER);",
        )?;
        for (id, source, archived, updated) in [
            (visible, "vscode", 0, 1234),
            (subagent, r#"{"subagent":"review"}"#, 0, 9876),
            (archived, "vscode", 1, 9999),
        ] {
            legacy.execute(
                "INSERT INTO threads VALUES (?1,'Legacy session','/work',?2,'',?3,?4)",
                params![id.to_string(), archived, source, updated],
            )?;
        }
        let history = History::open(home.path())?;
        assert_eq!(history.latest_thread()?, Some(visible));
        let legacy_threads = history.threads(&json!({"q":"legacy"}))?;
        assert_eq!(legacy_threads["threads"].as_array().unwrap().len(), 1);
        assert_eq!(legacy_threads["threads"][0]["updatedAt"], 1_234_000);
        assert_eq!(history.projects()?["ungrouped"], 1);
        assert!(history.anchor(&subagent.to_string()).is_err());
        assert!(history.anchor(&archived.to_string()).is_err());

        let modern = Connection::open(home.path().join("state_12.sqlite"))?;
        assert_eq!(history.latest_thread()?, Some(visible));
        modern.execute_batch(
            "CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, archived INTEGER,
                                   rollout_path TEXT, thread_source TEXT, updated_at_ms INTEGER,
                                   project_id TEXT);
             CREATE TABLE projects (id TEXT, name TEXT);
             INSERT INTO projects VALUES ('demo','Updated project');",
        )?;
        modern.execute(
            "INSERT INTO threads VALUES (?1,'Renamed session','Old title','/work',0,'','user',1234567,'demo')",
            [visible.to_string()],
        )?;
        std::fs::write(home.path().join("state_99.sqlite-wal"), "ignored")?;
        let current = history.threads(&json!({"project":"demo", "q":"renamed"}))?;
        assert_eq!(current["threads"][0]["title"], "Renamed session");
        assert_eq!(current["threads"][0]["updatedAt"], 1_234_567);
        assert_eq!(history.projects()?["projects"][0]["count"], 1);
        Ok(())
    }

    fn rollout(record: Value) -> Option<Value> {
        rollout_message(&serde_json::to_vec(&record).unwrap(), "thread", 100, false)
    }

    #[test]
    fn delegated_prompt_is_projected_once_with_the_completed_item_identity() {
        let tool = json!({
            "id":"native-item",
            "namespace":"codex_app",
            "name":"create_thread",
            "output":"<codex_delegation>\n<source_thread_id>ffffffff-ffff-4fff-8fff-ffffffffffff</source_thread_id>\n<input>\nReview this patch.\n</input>\n</codex_delegation>"
        });
        let mut response = tool.clone();
        response["type"] = json!("function_call_output");
        assert!(rollout(json!({"type":"response_item","payload":response})).is_none());

        let mut item = tool;
        item["type"] = json!("FunctionCallOutput");
        let record = json!({
            "type":"event_msg",
            "payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn","item":item}
        });
        let message = rollout(record.clone()).unwrap();
        assert_eq!(message["id"], "rollout-100");
        assert_eq!(message["nativeItemId"], "native-item");
        assert_eq!(message["role"], "user");
        assert_eq!(message["turnId"], "turn");
        assert_eq!(message["text"], "Review this patch.");

        let mut foreign = record;
        foreign["payload"]["thread_id"] = json!("another-thread");
        assert!(rollout(foreign).is_none());
    }

    #[test]
    fn delegated_file_only_prompt_keeps_attachment_without_inventing_inline_image() {
        let path = std::env::temp_dir().join("fixture").join("attachment.png");
        let prompt = crate::files::attachment_prompt(
            "",
            &[crate::files::Attachment {
                name: "reference: image.png".into(),
                path: path.clone(),
            }],
            false,
        )
        .unwrap();
        assert!(!prompt.contains("Image attachment: true"));
        let output = format!(
            "<codex_delegation>\n<source_thread_id>source</source_thread_id>\n<input>{prompt}</input>\n</codex_delegation>"
        );
        let message = rollout(json!({
            "type":"event_msg","payload":{
                "type":"item_completed","thread_id":"thread","turn_id":"turn",
                "item":{"type":"FunctionCallOutput","id":"native-item","namespace":"codex_app","name":"create_thread","output":output}
            }
        })).unwrap();
        assert_eq!(message["text"], "");
        assert_eq!(message["attachments"][0]["path"], path.to_str().unwrap());
        assert_eq!(message["attachments"][0]["name"], "reference: image.png");
    }

    #[test]
    fn history_keeps_item_identity_and_ignores_typed_workspace_instructions() {
        let assistant = rollout(json!({
            "type":"response_item",
            "payload": {
                "type":"message","id":"native-answer","role":"assistant","phase":"commentary",
                "content":[{"type":"output_text","text":"I will check."}],
                "internal_chat_message_metadata_passthrough":{"turn_id":"turn"}
            }
        }))
        .unwrap();
        assert_eq!(assistant["id"], "rollout-100");
        assert_eq!(assistant["nativeItemId"], "native-answer");
        assert_eq!(assistant["turnId"], "turn");
        assert_eq!(assistant["phase"], "commentary");

        let mut user = json!({
            "type":"response_item",
            "payload": {
                "type":"message","id":"native-user","role":"user",
                "content":[
                    {"type":"input_text","text":"generated instructions"},
                    {"type":"input_text","text":"generated environment"}
                ],
                "internal_chat_message_metadata_passthrough":{
                    "content_item_kinds":["agents_md.instructions","environments.environment_context"]
                }
            }
        });
        assert!(rollout(user.clone()).is_none());
        user["payload"]["content"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"input_text","text":"User input."}));
        user["payload"]["internal_chat_message_metadata_passthrough"]["content_item_kinds"]
            .as_array_mut()
            .unwrap()
            .push(json!("plain_text"));
        assert_eq!(rollout(user).unwrap()["text"], "User input.");
    }

    #[test]
    fn voice_transcript_segments_become_history_messages() {
        for role in ["user", "assistant"] {
            let transcript = json!({
                "type":"realtime_item",
                "payload":{"type":"transcript_segment","role":role,"text":"你好"}
            });
            let line = serde_json::to_vec(&transcript).unwrap();
            let message = rollout_message(&line, "voice-fork", 100, false).unwrap();
            assert_eq!(message["id"], "rollout-100");
            assert_eq!(message["role"], role);
            assert_eq!(message["text"], "你好");
            assert_eq!(
                rollout_message(&line, "voice-fork", 100, true),
                Some(message)
            );
        }
        assert!(
            rollout_message(
                br#"{"type":"realtime_item","payload":{"type":"realtime_session_closed"}}"#,
                "voice-fork",
                100,
                false
            )
            .is_none()
        );
    }
}
