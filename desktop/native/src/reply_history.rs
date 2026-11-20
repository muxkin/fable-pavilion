use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{File, Metadata},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    ops::Range,
    sync::{Arc, Mutex},
    time::SystemTime,
};
use uuid::Uuid;

const PAGE_CONTEXT_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Default)]
pub(crate) struct ReplyHistory(Arc<Mutex<Option<Cached>>>);

struct Cached {
    thread: Uuid,
    length: u64,
    modified: SystemTime,
    identity: FileIdentity,
    checkpoint: [u8; 32],
    scan: Scan,
}

#[derive(PartialEq, Eq)]
struct FileIdentity {
    created: Option<SystemTime>,
    #[cfg(unix)]
    inode: (u64, u64),
}

impl FileIdentity {
    fn from_metadata(metadata: &Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            created: metadata.created().ok(),
            #[cfg(unix)]
            inode: (metadata.dev(), metadata.ino()),
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct Boundaries {
    turns: HashMap<String, u64>,
    offsets: HashMap<u64, String>,
}

#[derive(Default)]
struct Scan {
    offset: u64,
    current: Option<String>,
    pending: HashMap<String, Candidate>,
    boundaries: Arc<Boundaries>,
    page: Option<Page>,
}

struct Page {
    messages: Range<u64>,
    started: HashSet<String>,
    ambiguous: bool,
}

#[derive(Default)]
struct Candidate {
    final_answer: Option<u64>,
    legacy_answer: Option<(u64, [u8; 32])>,
}

impl ReplyHistory {
    pub(crate) fn page(
        &self,
        thread: &str,
        file: &mut File,
        messages: Range<u64>,
        length: u64,
    ) -> anyhow::Result<Arc<Boundaries>> {
        let id = Uuid::parse_str(thread)?;
        let metadata = file.metadata()?;
        let identity = FileIdentity::from_metadata(&metadata);
        let modified = metadata.modified()?;
        // An exact index may already be available after paging or forking.
        // Never wait for a different request that is scanning the full journal.
        if let Ok(cache) = self.0.try_lock()
            && let Some(cached) = cache.as_ref().filter(|cached| {
                cached.thread == id
                    && cached.identity == identity
                    && cached.length == length
                    && cached.length == metadata.len()
                    && cached.modified == modified
            })
        {
            return Ok(cached.scan.boundaries.clone());
        }

        let start = messages.start.saturating_sub(PAGE_CONTEXT_BYTES);
        let end = length.min(messages.end.saturating_add(PAGE_CONTEXT_BYTES));
        let offset = start.saturating_sub(1);
        file.seek(SeekFrom::Start(offset))?;
        let mut reader = BufReader::new((&mut *file).take(end.saturating_sub(offset)));
        let mut scan = Scan {
            offset,
            ..Scan::default()
        };
        if start > 0 {
            let Some(skipped) = through_newline(&mut reader)? else {
                return Ok(scan.boundaries);
            };
            scan.offset += skipped;
            scan.page = Some(Page {
                messages: messages.clone(),
                started: HashSet::new(),
                ambiguous: false,
            });
        }
        scan.advance(reader)?;
        let completion_beyond_window = end < length
            && scan.pending.values().any(|candidate| {
                candidate
                    .final_answer
                    .is_some_and(|offset| messages.contains(&offset))
                    || candidate
                        .legacy_answer
                        .is_some_and(|(offset, _)| messages.contains(&offset))
            });
        if scan.page.is_some_and(|page| page.ambiguous) || completion_beyond_window {
            // Legacy replies may omit the turn ID, and a long tool run can
            // separate a past reply from its completion record.
            return self.read(thread, file);
        }
        Ok(scan.boundaries)
    }

    pub(crate) fn read(&self, thread: &str, file: &mut File) -> anyhow::Result<Arc<Boundaries>> {
        let thread = Uuid::parse_str(thread)?;
        let metadata = file.metadata()?;
        let length = metadata.len();
        let modified = metadata.modified()?;
        let identity = FileIdentity::from_metadata(&metadata);
        let mut cache = self.0.lock().expect("reply history cache");
        let existing = cache
            .take()
            .filter(|cached| cached.thread == thread && cached.identity == identity);
        if let Some(cached) = existing.as_ref()
            && cached.length == length
            && cached.modified == modified
        {
            let boundaries = cached.scan.boundaries.clone();
            *cache = existing;
            return Ok(boundaries);
        }
        let mut scan = match existing {
            Some(cached)
                if cached.length < length
                    && cached.modified <= modified
                    && checkpoint(file, cached.scan.offset)? == cached.checkpoint =>
            {
                cached.scan
            }
            _ => Scan::default(),
        };
        file.seek(SeekFrom::Start(scan.offset))?;
        scan.advance(BufReader::new((&mut *file).take(length - scan.offset)))?;
        let boundaries = scan.boundaries.clone();
        *cache = Some(Cached {
            thread,
            length,
            modified,
            identity,
            checkpoint: checkpoint(file, scan.offset)?,
            scan,
        });
        Ok(boundaries)
    }
}

impl Boundaries {
    pub(crate) fn contains(&self, turn: &str) -> bool {
        self.turns.contains_key(turn)
    }

    pub(crate) fn mark(&self, offset: u64, message: &mut Value) {
        if message["role"] == "assistant"
            && let Some(turn) = self.offsets.get(&offset)
        {
            message["turnId"] = serde_json::json!(turn);
            message["turnBoundary"] = serde_json::json!(true);
        }
    }

    fn remove(&mut self, turn: &str) {
        if let Some(offset) = self.turns.remove(turn) {
            self.offsets.remove(&offset);
        }
    }

    fn record(&mut self, turn: &str, offset: u64) {
        self.remove(turn);
        self.turns.insert(turn.to_owned(), offset);
        self.offsets.insert(offset, turn.to_owned());
    }
}

impl Scan {
    fn advance(&mut self, mut reader: impl BufRead) -> io::Result<()> {
        let mut line = Vec::new();
        loop {
            line.clear();
            let length = (&mut reader)
                .take(crate::history_media::MAX_LINE)
                .read_until(b'\n', &mut line)?;
            if length == 0 {
                break;
            }
            let start = self.offset;
            if line.last() != Some(&b'\n') {
                // A partial line carries no trustworthy completion signal.
                let Some(skipped) = through_newline(&mut reader)? else {
                    break;
                };
                self.offset += length as u64 + skipped;
                continue;
            }
            self.offset += length as u64;
            // Most journal rows are large outputs with no bearing on the reply boundary.
            if !line
                .windows(12)
                .any(|part| matches!(part, b"turn_context" | b"task_started" | b"turn_aborted"))
                && !line.windows(13).any(|part| part == b"task_complete")
                && !line.windows(13).any(|part| part == b"response_item")
            {
                continue;
            }
            let Ok(record) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            let entry = &record["payload"];
            match (record["type"].as_str(), entry["type"].as_str()) {
                (Some("turn_context"), _) => {
                    self.current = turn_id(&entry["turn_id"]).map(str::to_owned)
                }
                (Some("event_msg"), Some("task_started" | "turn_aborted")) => {
                    if let Some(turn) = turn_id(&entry["turn_id"]) {
                        Arc::make_mut(&mut self.boundaries).remove(turn);
                        self.pending.remove(turn);
                        if entry["type"] == "task_started" {
                            if let Some(page) = &mut self.page {
                                page.started.insert(turn.to_owned());
                            }
                            self.current = Some(turn.to_owned());
                        } else if self.current.as_deref() == Some(turn) {
                            self.current = None;
                        }
                    }
                }
                (Some("event_msg"), Some("task_complete")) => {
                    if let Some(turn) = turn_id(&entry["turn_id"]) {
                        if let Some(candidate) = self.pending.remove(turn) {
                            let boundary = candidate.final_answer.or_else(|| {
                                let (offset, hash) = candidate.legacy_answer?;
                                let actual = digest(entry["last_agent_message"].as_str()?);
                                (hash == actual).then_some(offset)
                            });
                            if let Some(boundary) = boundary {
                                Arc::make_mut(&mut self.boundaries).record(turn, boundary);
                            }
                        }
                        if self.current.as_deref() == Some(turn) {
                            self.current = None;
                        }
                    }
                }
                (Some("response_item"), Some("message")) => {
                    let turn = &entry["internal_chat_message_metadata_passthrough"]["turn_id"];
                    let turn = if turn.is_null() {
                        turn_id(&entry["turn_id"]).or(self.current.as_deref())
                    } else {
                        turn_id(turn)
                    };
                    if entry["role"] == "user" {
                        if let Some(turn) = turn {
                            self.pending.remove(turn);
                        }
                    } else if entry["role"] == "assistant"
                        && (entry["status"].is_null() || entry["status"] == "completed")
                        && (entry["phase"].is_null() || entry["phase"] == "final_answer")
                    {
                        let text = crate::codex_live::native_text(&entry["content"]);
                        if text.trim().is_empty()
                            && (entry["phase"] != "final_answer"
                                || crate::history_media::media(entry).is_empty())
                        {
                            continue;
                        }
                        if let Some(page) = &mut self.page
                            && page.messages.contains(&start)
                            && (turn.is_none()
                                || (entry["phase"].is_null()
                                    && !turn.is_some_and(|turn| page.started.contains(turn))))
                        {
                            page.ambiguous = true;
                        }
                        let Some(turn) = turn else {
                            continue;
                        };
                        if entry["phase"] == "final_answer" {
                            self.pending
                                .entry(turn.to_owned())
                                .or_default()
                                .final_answer = Some(start);
                        } else {
                            self.pending
                                .entry(turn.to_owned())
                                .or_default()
                                .legacy_answer = Some((start, digest(&text)));
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

fn checkpoint(file: &mut File, offset: u64) -> io::Result<[u8; 32]> {
    let mut tail = [0; 128];
    let start = offset.saturating_sub(tail.len() as u64);
    file.seek(SeekFrom::Start(start))?;
    file.read_exact(&mut tail[..(offset - start) as usize])?;
    Ok(Sha256::digest(tail).into())
}

fn through_newline(reader: &mut impl BufRead) -> io::Result<Option<u64>> {
    let mut skipped = 0;
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return Ok(None);
        }
        let end = bytes.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(bytes.len(), |end| end + 1);
        reader.consume(count);
        skipped += count as u64;
        if end.is_some() {
            return Ok(Some(skipped));
        }
    }
}

fn digest(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}

fn turn_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|id| {
        (1..=200).contains(&id.encode_utf16().count()) && !id.chars().any(char::is_control)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn event(kind: &str, turn: &str, last: Option<&str>) -> Value {
        json!({"type":"event_msg","payload":{"type":kind,"turn_id":turn,"last_agent_message":last}})
    }

    fn answer(turn: Option<&str>, phase: Option<&str>, text: &str) -> Value {
        json!({"type":"response_item","payload":{
            "type":"message","role":"assistant","phase":phase,"status":"completed",
            "internal_chat_message_metadata_passthrough":{"turn_id":turn},
            "content":[{"type":"output_text","text":text}]
        }})
    }

    fn append(file: &mut File, value: Value, newline: bool) -> io::Result<u64> {
        let offset = file.seek(SeekFrom::End(0))?;
        serde_json::to_writer(&mut *file, &value)?;
        if newline {
            file.write_all(b"\n")?;
        }
        Ok(offset)
    }

    fn extend_journal(file: &mut File) -> io::Result<()> {
        // A large irrelevant record separates the cold tail from older replies.
        let end = file.seek(SeekFrom::End(0))?;
        file.set_len(end + 48 * 1024 * 1024)?;
        file.seek(SeekFrom::End(-1))?;
        file.write_all(b"\n")
    }

    #[test]
    fn cold_tail_skips_the_long_prefix_and_keeps_reply_identity_and_timing() -> anyhow::Result<()> {
        let index = ReplyHistory::default();
        let thread = Uuid::new_v4().to_string();
        let mut file = tempfile::tempfile()?;
        append(&mut file, event("task_started", "older", None), true)?;
        let old = append(
            &mut file,
            answer(Some("older"), Some("final_answer"), "earlier answer"),
            true,
        )?;
        append(&mut file, event("task_complete", "older", None), true)?;
        extend_journal(&mut file)?;
        append(&mut file, event("task_started", "latest", None), true)?;
        let current = append(&mut file, answer(None, None, "latest answer"), true)?;
        let completion = event("task_complete", "latest", Some("latest answer"));
        append(&mut file, completion, false)?;

        let length = file.metadata()?.len();
        let pending = index.page(&thread, &mut file, current..length, length)?;
        assert!(!pending.contains("latest"));
        assert!(!pending.contains("older"));
        assert!(index.0.lock().unwrap().is_none());

        file.seek(SeekFrom::End(0))?;
        file.write_all(b"\n")?;
        let length = file.metadata()?.len();
        let recent = index.page(&thread, &mut file, current..length, length)?;
        let mut reply = json!({"role":"assistant"});
        recent.mark(current, &mut reply);
        assert_eq!(reply["turnId"], "latest");
        assert_eq!(reply["turnBoundary"], true);
        assert!(!recent.contains("older"));
        assert!(index.0.lock().unwrap().is_none());

        let historical = index.read(&thread, &mut file)?;
        let mut older = json!({"role":"assistant"});
        historical.mark(old, &mut older);
        assert_eq!(older["turnId"], "older");
        assert!(historical.contains("latest"));
        Ok(())
    }

    #[test]
    fn cold_tail_recovers_legacy_reply_whose_context_precedes_the_window() -> anyhow::Result<()> {
        let mut file = tempfile::tempfile()?;
        let index = ReplyHistory::default();
        let thread = Uuid::new_v4().to_string();
        append(&mut file, event("task_started", "legacy", None), true)?;
        extend_journal(&mut file)?;
        let current = append(&mut file, answer(None, None, "complete answer"), true)?;
        append(
            &mut file,
            event("task_complete", "legacy", Some("complete answer")),
            true,
        )?;

        let length = file.metadata()?.len();
        let replies = index.page(&thread, &mut file, current..length, length)?;
        let mut reply = json!({"role":"assistant"});
        replies.mark(current, &mut reply);
        assert_eq!(reply["turnId"], "legacy");
        assert_eq!(reply["turnBoundary"], true);
        Ok(())
    }

    #[test]
    fn older_page_looks_ahead_for_completion_without_scanning_the_file() -> anyhow::Result<()> {
        let index = ReplyHistory::default();
        let thread = Uuid::new_v4().to_string();
        let mut file = tempfile::tempfile()?;
        extend_journal(&mut file)?;
        append(&mut file, event("task_started", "past", None), true)?;
        let first = append(
            &mut file,
            answer(Some("past"), Some("final_answer"), "past answer"),
            true,
        )?;
        let cursor = append(&mut file, event("task_complete", "past", None), true)?;
        extend_journal(&mut file)?;
        append(&mut file, event("task_started", "later", None), true)?;
        append(
            &mut file,
            answer(Some("later"), Some("final_answer"), "later answer"),
            true,
        )?;
        append(&mut file, event("task_complete", "later", None), true)?;
        let length = file.metadata()?.len();

        let replies = index.page(&thread, &mut file, first..cursor, length)?;
        let mut reply = json!({"role":"assistant"});
        replies.mark(first, &mut reply);
        assert_eq!(reply["turnId"], "past");
        assert_eq!(reply["turnBoundary"], true);
        assert!(!replies.contains("later"));
        assert!(index.0.lock().unwrap().is_none());
        Ok(())
    }

    #[test]
    fn older_page_keeps_reply_whose_completion_is_beyond_the_window() -> anyhow::Result<()> {
        let index = ReplyHistory::default();
        let thread = Uuid::new_v4().to_string();
        let mut file = tempfile::tempfile()?;
        append(&mut file, event("task_started", "past", None), true)?;
        let first = append(
            &mut file,
            answer(Some("past"), Some("final_answer"), "past answer"),
            true,
        )?;
        let cursor = file.metadata()?.len();
        extend_journal(&mut file)?;
        append(&mut file, event("task_complete", "past", None), true)?;
        let length = file.metadata()?.len();

        let replies = index.page(&thread, &mut file, first..cursor, length)?;
        let mut reply = json!({"role":"assistant"});
        replies.mark(first, &mut reply);
        assert_eq!(reply["turnId"], "past");
        assert_eq!(reply["turnBoundary"], true);
        assert!(index.0.lock().unwrap().is_some());
        Ok(())
    }

    #[test]
    fn resumes_from_the_last_complete_record_and_marks_an_earlier_page() -> anyhow::Result<()> {
        let mut file = tempfile::tempfile()?;
        let index = ReplyHistory::default();
        let thread = Uuid::new_v4().to_string();
        append(&mut file, event("task_started", "completed", None), true)?;
        let offset = append(
            &mut file,
            answer(Some("completed"), Some("final_answer"), "final"),
            true,
        )?;
        let completion = append(
            &mut file,
            event("task_complete", "completed", Some("final")),
            false,
        )?;
        let before = index.read(&thread, &mut file)?;
        assert!(!before.contains("completed"));
        assert_eq!(
            index.0.lock().unwrap().as_ref().unwrap().scan.offset,
            completion
        );
        file.seek(SeekFrom::End(0))?;
        file.write_all(b"\n")?;
        append(&mut file, event("item_completed", "completed", None), true)?;
        let after = index.read(&thread, &mut file)?;
        let mut message = json!({"role":"assistant"});
        after.mark(offset, &mut message);
        assert_eq!(message["turnBoundary"], true);
        assert_eq!(message["turnId"], "completed");
        assert!(after.contains("completed"));
        assert!(!before.contains("completed"));
        Ok(())
    }

    #[test]
    fn requires_a_completed_exact_turn_and_a_matching_legacy_reply() -> anyhow::Result<()> {
        let mut file = tempfile::tempfile()?;
        let index = ReplyHistory::default();
        let thread = Uuid::new_v4().to_string();
        append(&mut file, event("task_started", "legacy", None), true)?;
        append(&mut file, answer(None, None, "shared"), true)?;
        append(
            &mut file,
            event("task_complete", "other", Some("shared")),
            true,
        )?;
        append(
            &mut file,
            event("task_complete", "legacy", Some("shared")),
            true,
        )?;
        append(&mut file, event("task_started", "aborted", None), true)?;
        append(
            &mut file,
            answer(Some("aborted"), Some("final_answer"), "shared"),
            true,
        )?;
        append(&mut file, event("turn_aborted", "aborted", None), true)?;
        append(&mut file, event("task_started", "incomplete", None), true)?;
        append(
            &mut file,
            answer(Some("incomplete"), Some("final_answer"), "shared"),
            true,
        )?;
        append(&mut file, event("task_started", "commentary", None), true)?;
        append(
            &mut file,
            answer(Some("commentary"), Some("commentary"), "shared"),
            true,
        )?;
        append(
            &mut file,
            event("task_complete", "commentary", Some("shared")),
            true,
        )?;
        append(&mut file, event("task_started", "mismatch", None), true)?;
        append(&mut file, answer(None, None, "first"), true)?;
        append(
            &mut file,
            event("task_complete", "mismatch", Some("shared")),
            true,
        )?;
        let replies = index.read(&thread, &mut file)?;
        assert!(replies.contains("legacy"));
        for turn in ["other", "aborted", "incomplete", "commentary", "mismatch"] {
            assert!(!replies.contains(turn), "{turn} incorrectly forkable");
        }
        Ok(())
    }
}
