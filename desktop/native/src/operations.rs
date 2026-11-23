use crate::{
    codex_live::{Action, Outcome, View},
    conversations::DraftUploads,
    files::Scope,
    plugins::{Delivery, Observation, Write},
    state::{Store, hash, now},
};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serde_json::{Value, json};
use uuid::Uuid;

const COLUMNS: &str =
    "id,thread_id,kind,state,turn_id,error,created,updated,result_thread_id,backend_id";

impl Store {
    pub fn begin_operation(
        &mut self,
        backend: &str,
        id: Uuid,
        device: &str,
        thread: Uuid,
        action: &Action,
    ) -> Result<(Value, bool)> {
        self.begin(
            backend,
            id,
            device,
            &thread.to_string(),
            action.name(),
            json!([thread, action]),
        )
    }

    pub fn begin_management(
        &mut self,
        backend: &str,
        id: Uuid,
        device: &str,
        thread: &str,
        kind: &str,
        input: &impl serde::Serialize,
    ) -> Result<(Value, bool)> {
        self.begin(
            backend,
            id,
            device,
            thread,
            kind,
            json!([thread, kind, input]),
        )
    }

    pub(crate) fn begin_plugin(
        &mut self,
        backend: &str,
        id: Uuid,
        device: &str,
        thread: &str,
        action: &Write,
    ) -> Result<(Value, bool)> {
        self.begin(
            backend,
            id,
            device,
            thread,
            action.kind(),
            json!([thread, action]),
        )
    }

    fn begin(
        &mut self,
        backend: &str,
        id: Uuid,
        device: &str,
        thread: &str,
        kind: &str,
        input: Value,
    ) -> Result<(Value, bool)> {
        let time = now();
        let id = id.to_string();
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let fingerprint = hash(&serde_json::to_string(&input)?);
        let old: Option<(String, String, Value)> = tx.query_row(
            &format!("SELECT device_id,fingerprint,{COLUMNS} FROM operations WHERE backend_id=?1 AND id=?2"),
            params![backend, id],
            |row| Ok((row.get(0)?, row.get(1)?, operation(row, 2)?)),
        ).optional()?;
        if let Some((owner, actual, operation)) = old {
            ensure!(
                owner == device && actual == fingerprint,
                "请求 ID 已用于其他操作"
            );
            return Ok((operation, false));
        }
        let busy = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE backend_id=?1 AND thread_id=?2 AND state='dispatching')",
            params![backend, thread], |row| row.get::<_, bool>(0),
        )?;
        let (state, error) = if busy {
            ("rejected", Some("此会话有一个控制请求正在确认"))
        } else {
            ("dispatching", None)
        };
        tx.execute(
            "INSERT INTO operations (id,device_id,thread_id,kind,fingerprint,state,error,created,updated,backend_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8,?9)",
            params![id, device, thread, kind, fingerprint, state, error, time, backend],
        )?;
        let result = tx.query_row(
            &format!("SELECT {COLUMNS} FROM operations WHERE backend_id=?1 AND id=?2"),
            params![backend, id],
            |row| operation(row, 0),
        )?;
        tx.commit()?;
        Ok((result, !busy))
    }

    pub fn finish_operation(&mut self, backend: &str, id: Uuid, outcome: Outcome) -> Result<()> {
        update_operation(&self.db, backend, id, outcome).map(|_| ())
    }

    pub(crate) fn finish_create_with_uploads(
        &mut self,
        backend: &str,
        id: Uuid,
        device: &str,
        draft: &DraftUploads,
        outcome: Outcome,
    ) -> Result<()> {
        let Outcome::Completed(Some(thread)) = outcome else {
            return self.finish_operation(backend, id, outcome);
        };
        let tx = self.db.transaction()?;
        if update_operation(&tx, backend, id, Outcome::Completed(Some(thread)))? == 1 {
            link_create_uploads(&tx, backend, device, thread, draft)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn record_codex_created(
        &mut self,
        backend: &str,
        id: Uuid,
        device: &str,
        thread: Uuid,
        draft: Option<&DraftUploads>,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        let changed = tx.execute(
            "UPDATE operations SET result_thread_id=?1,updated=?2
             WHERE backend_id=?3 AND id=?4 AND device_id=?5 AND kind='create' AND state='dispatching'
               AND (result_thread_id IS NULL OR result_thread_id=?1)",
            params![thread.to_string(), now(), backend, id.to_string(), device],
        )?;
        ensure!(changed == 1, "无法记录已创建的 Codex 会话");
        if let Some(draft) = draft {
            link_create_uploads(&tx, backend, device, thread, draft)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn finish_plugin(
        &mut self,
        backend: &str,
        id: Uuid,
        result: Delivery,
    ) -> Result<()> {
        let (state, turn, error, thread) = match result {
            Delivery::Accepted(turn) => ("accepted", turn, None, None),
            Delivery::Completed(thread) => ("completed", None, None, thread),
            Delivery::Command {
                id,
                succeeded: true,
            } => ("completed", Some(id), None, None),
            Delivery::Command {
                id,
                succeeded: false,
            } => ("failed", Some(id), Some("DSH 原生命令执行失败"), None),
            Delivery::Rejected(reason) => ("rejected", None, Some(reason), None),
            Delivery::Uncertain => (
                "uncertain",
                None,
                Some("结果待确认，请在原会话中核对"),
                None,
            ),
        };
        self.db.execute(
            "UPDATE operations SET state=?1,turn_id=?2,error=?3,updated=?4,result_thread_id=COALESCE(?5,result_thread_id)
             WHERE backend_id=?6 AND id=?7 AND state='dispatching'",
            params![state, turn, error, now(), thread, backend, id.to_string()],
        )?;
        Ok(())
    }

    pub(crate) fn record_plugin_thread(
        &mut self,
        backend: &str,
        id: Uuid,
        thread: &str,
        draft: Option<(&str, &DraftUploads)>,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        let changed = tx.execute(
            "UPDATE operations SET result_thread_id=?1,updated=?2
             WHERE backend_id=?3 AND id=?4 AND kind='create' AND state='dispatching'
               AND (result_thread_id IS NULL OR result_thread_id=?1)",
            params![thread, now(), backend, id.to_string()],
        )?;
        ensure!(changed == 1, "无法保存新会话标识");
        if let Some((device, draft)) = draft {
            link_plugin_create_uploads(&tx, backend, device, thread, draft)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn observe_plugin(
        &mut self,
        backend: &str,
        thread: &str,
        events: &[Observation],
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        let mut update = tx.prepare(
            "UPDATE operations SET state=?1,turn_id=?2,error=NULL,updated=?3
             WHERE backend_id=?4 AND thread_id=?5
               AND ((kind IN ('send','steer','queue') AND id=?6)
                    OR (kind='interrupt' AND ?1<>'accepted' AND turn_id=?2))
               AND state IN ('dispatching','accepted','uncertain')
               AND (state<>?1 OR turn_id IS NOT ?2)",
        )?;
        for event in events {
            update.execute(params![
                event.state,
                event.turn,
                now(),
                backend,
                thread,
                event.request.map(|id| id.to_string()),
            ])?;
        }
        drop(update);
        tx.commit()?;
        Ok(())
    }

    pub fn observe_operations(&mut self, backend: &str, thread: &str, view: &View) -> Result<()> {
        let tx = self.db.transaction()?;
        if view.is_ready_to_continue() {
            tx.execute(
                "UPDATE operations SET state='completed',error=NULL,updated=?1
                 WHERE backend_id=?2 AND thread_id=?3 AND kind='open'
                   AND state IN ('dispatching','uncertain')",
                params![now(), backend, thread],
            )?;
        }
        let mut update = tx.prepare(
            "UPDATE operations SET state=?1,turn_id=?2,error=NULL,updated=?3
             WHERE backend_id=?4 AND thread_id=?5 AND kind IN ('send','steer','respond')
               AND state IN ('dispatching','accepted','uncertain')
               AND (turn_id=?2 OR id=?6)
               AND (state<>?1 OR turn_id IS NULL)",
        )?;
        for turn in &view.turns {
            if !matches!(
                turn.state.as_str(),
                "accepted" | "completed" | "interrupted" | "failed"
            ) {
                continue;
            }
            update.execute(params![
                turn.state,
                turn.id,
                now(),
                backend,
                thread,
                turn.request
            ])?;
        }
        drop(update);
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn operation_for(
        &self,
        backend: &str,
        device: &str,
        id: &str,
    ) -> Result<Option<Value>> {
        Ok(self.db.query_row(
            &format!("SELECT {COLUMNS} FROM operations WHERE backend_id=?1 AND device_id=?2 AND id=?3"),
            params![backend, device, id], |row| operation(row, 0),
        ).optional()?)
    }

    pub(crate) fn recent_operations_for(
        &self,
        backend: &str,
        device: &str,
        thread: &str,
    ) -> Result<Vec<Value>> {
        let mut stmt = self.db.prepare(
            &format!("SELECT {COLUMNS} FROM operations WHERE backend_id=?1 AND device_id=?2 AND thread_id=?3 ORDER BY created DESC LIMIT 20"),
        )?;
        Ok(stmt
            .query_map(params![backend, device, thread], |row| operation(row, 0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn revoke_device(&mut self, device: &str) -> Result<()> {
        self.db
            .execute("UPDATE devices SET revoked=1 WHERE id=?1", [device])?;
        Ok(())
    }
}

fn link_create_uploads(
    db: &Connection,
    backend: &str,
    device: &str,
    thread: Uuid,
    draft: &DraftUploads,
) -> Result<()> {
    link_draft_uploads(db, &Scope::codex_draft(backend, draft.id), &Scope::codex(backend, thread), device, draft)
}

fn link_plugin_create_uploads(
    db: &Connection,
    backend: &str,
    device: &str,
    thread: &str,
    draft: &DraftUploads,
) -> Result<()> {
    link_draft_uploads(db, &Scope::codex_draft(backend, draft.id), &Scope::plugin(backend, thread), device, draft)
}

fn link_draft_uploads(
    db: &Connection,
    source: &Scope,
    destination: &Scope,
    device: &str,
    draft: &DraftUploads,
) -> Result<()> {
    let mut link = db.prepare(
        "INSERT INTO native_upload_thread_links (upload_id,thread)
         SELECT id,?1 FROM native_uploads WHERE id=?2 AND device=?3 AND thread=?4 AND complete=1
         ON CONFLICT(upload_id,thread) DO UPDATE SET thread=excluded.thread",
    )?;
    for upload in &draft.uploads {
        let linked = link.execute(params![
            destination.key(),
            upload.to_string(),
            device,
            source.key()
        ])?;
        ensure!(linked == 1, "无法绑定新会话附件");
    }
    Ok(())
}

fn update_operation(db: &Connection, backend: &str, id: Uuid, outcome: Outcome) -> Result<usize> {
    let (state, turn, error, result) = match outcome {
        Outcome::Completed(result) => ("completed", None, None, result.map(|id| id.to_string())),
        Outcome::Rejected(message) => ("rejected", None, Some(message), None),
        Outcome::Uncertain => (
            "uncertain",
            None,
            Some("结果待确认，请在 Codex 会话中核对".to_owned()),
            None,
        ),
        Outcome::Accepted(turn) => ("accepted", Some(turn), None, None),
        Outcome::Interrupted(turn) => ("interrupted", Some(turn), None, None),
    };
    Ok(db.execute(
        "UPDATE operations SET state=?1,turn_id=COALESCE(?2,turn_id),error=?3,updated=?4,result_thread_id=COALESCE(result_thread_id,?5)
         WHERE backend_id=?6 AND id=?7 AND state='dispatching'",
        params![state, turn, error, now(), result, backend, id.to_string()],
    )?)
}

fn operation(row: &Row<'_>, offset: usize) -> rusqlite::Result<Value> {
    let mut result = json!({
        "id": row.get::<_, String>(offset)?,
        "threadId": row.get::<_, String>(offset + 1)?,
        "kind": row.get::<_, String>(offset + 2)?,
        "state": row.get::<_, String>(offset + 3)?,
        "turnId": row.get::<_, Option<String>>(offset + 4)?,
        "error": row.get::<_, Option<String>>(offset + 5)?,
        "createdAt": row.get::<_, i64>(offset + 6)?,
        "updatedAt": row.get::<_, i64>(offset + 7)?,
        "backendId": row.get::<_, String>(offset + 9)?,
    });
    if let Some(thread) = row.get::<_, Option<String>>(offset + 8)? {
        result["resultThreadId"] = json!(thread);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn confirms_an_uncertain_open_from_its_live_view() -> Result<()> {
        let state = tempfile::tempdir()?;
        let mut store = Store::open(&state.path().join("state"))?;
        let backend = crate::codex_backend::ID;
        let device = "paired-phone";
        let thread = Uuid::new_v4().to_string();
        let request = Uuid::new_v4();
        store.begin_management(backend, request, device, &thread, "open", &())?;
        store.finish_operation(backend, request, Outcome::Uncertain)?;
        let mut view: View = serde_json::from_value(json!({
            "thread":{"id":thread,"synchronized":false,"owner":true,"runtimeStatus":"idle"},
            "messages":[],"turns":[],"epoch":Uuid::new_v4()
        }))?;
        store.observe_operations(backend, &thread, &view)?;
        assert_eq!(
            store
                .operation_for(backend, device, &request.to_string())?
                .unwrap()["state"],
            "uncertain"
        );
        view.thread["synchronized"] = json!(true);
        store.observe_operations(backend, &thread, &view)?;
        let operation = store
            .operation_for(backend, device, &request.to_string())?
            .unwrap();
        assert_eq!(operation["state"], "completed");
        assert!(operation["error"].is_null());
        Ok(())
    }

    #[test]
    fn completed_creation_links_only_verified_draft_uploads_and_keeps_replay() -> Result<()> {
        let state = tempfile::tempdir()?;
        let mut store = Store::open(&state.path().join("state"))?;
        let backend = crate::codex_backend::ID;
        let device = "paired-phone";
        let thread = Uuid::new_v4();
        let destination = Scope::codex(backend, thread);
        let draft_id = Uuid::new_v4();
        let source = Scope::codex_draft(backend, draft_id);
        let bytes = b"fixture attachment";
        let hash = format!("{:x}", Sha256::digest(bytes));
        let manifest = store.begin_upload(
            device,
            &source,
            json!({
                "name":"attachment.txt","size":bytes.len(),"sha256":hash,"hashes":[hash]
            }),
            None,
        )?;
        let upload = Uuid::parse_str(manifest["id"].as_str().unwrap())?;
        assert!(store.attachment(device, &source, upload).is_err());
        store.file_request(device, &source, upload, "write", Some(0), bytes)?;
        store.file_request(device, &source, upload, "finish", None, &[])?;
        let file = store.attachment(device, &source, upload)?;
        assert!(
            store
                .describe_upload(device, &destination, &file.path)
                .is_err()
        );

        let input = json!({"draftId":draft_id,"uploadIds":[upload]});
        let request = Uuid::new_v4();
        assert!(
            store
                .begin_management(backend, request, device, "new", "create", &input)?
                .1
        );

        let mut draft = DraftUploads {
            id: draft_id,
            uploads: vec![upload, Uuid::new_v4()],
        };
        assert!(
            store
                .finish_create_with_uploads(
                    backend,
                    request,
                    device,
                    &draft,
                    Outcome::Completed(Some(thread))
                )
                .is_err()
        );
        assert!(
            store
                .describe_upload(device, &destination, &file.path)
                .is_err()
        );
        assert_eq!(
            store
                .operation_for(backend, device, &request.to_string())?
                .unwrap()["state"],
            "dispatching"
        );

        draft.uploads.pop();
        store.finish_create_with_uploads(
            backend,
            request,
            device,
            &draft,
            Outcome::Completed(Some(thread)),
        )?;
        assert_eq!(store.read_upload(device, &destination, upload, 0)?, bytes);
        assert!(
            store
                .describe_upload(device, &destination, &file.path)
                .is_ok()
        );
        assert!(store.describe_upload(device, &source, &file.path).is_ok());
        assert!(
            store
                .describe_upload("another-device", &destination, &file.path)
                .is_err()
        );
        assert!(
            store
                .describe_upload(device, &Scope::codex("other-backend", thread), &file.path)
                .is_err()
        );
        assert!(
            store
                .describe_upload(device, &Scope::codex(backend, Uuid::new_v4()), &file.path)
                .is_err()
        );
        assert!(
            store
                .describe_upload(
                    device,
                    &Scope::codex_draft(backend, Uuid::new_v4()),
                    &file.path
                )
                .is_err()
        );
        let (persisted, fresh) =
            store.begin_management(backend, request, device, "new", "create", &input)?;
        assert!(!fresh);
        assert_eq!(persisted["state"], "completed");
        assert_eq!(persisted["resultThreadId"], thread.to_string());
        Ok(())
    }
    #[test]
    fn created_codex_thread_is_recorded_before_the_first_turn() -> Result<()> {
        let state = tempfile::tempdir()?;
        let mut store = Store::open(&state.path().join("state"))?;
        let backend = crate::codex_backend::ID;
        let device = "paired-phone";
        let request = Uuid::new_v4();
        let thread = Uuid::new_v4();
        let input = json!({"skillIds":["fixture"]});
        assert!(
            store
                .begin_management(backend, request, device, "new", "create", &input)?
                .1
        );

        let unrelated = Uuid::new_v4();
        assert!(
            store
                .record_codex_created(backend, request, "other-phone", unrelated, None)
                .is_err()
        );
        let unverified = DraftUploads {
            id: Uuid::new_v4(),
            uploads: vec![Uuid::new_v4()],
        };
        assert!(
            store
                .record_codex_created(backend, request, device, unrelated, Some(&unverified))
                .is_err()
        );
        let pending = store
            .operation_for(backend, device, &request.to_string())?
            .unwrap();
        assert!(pending.get("resultThreadId").is_none());

        store.record_codex_created(backend, request, device, thread, None)?;
        store.record_codex_created(backend, request, device, thread, None)?;
        assert!(
            store
                .record_codex_created(backend, request, device, unrelated, None)
                .is_err()
        );
        store.finish_operation(backend, request, Outcome::Uncertain)?;
        let (persisted, fresh) =
            store.begin_management(backend, request, device, "new", "create", &input)?;
        assert!(!fresh);
        assert_eq!(persisted["state"], "uncertain");
        assert_eq!(persisted["resultThreadId"], thread.to_string());
        Ok(())
    }
}
