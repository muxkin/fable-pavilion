use super::*;
use crate::update::UpdateGate;
use std::sync::Mutex;
use tokio::sync::oneshot;

#[test]
fn passive_protocol_requests_do_not_take_update_activity() {
    for request in [
        json!({"type":"watch"}),
        json!({"type":"ping"}),
        json!({"type":"unwatch"}),
        json!({"type":"rpc","call":{"method":"history.read"}}),
        json!({"type":"rpc","call":{"method":"content.read"}}),
        json!({"type":"rpc","call":{"method":"backends.list"}}),
        json!({"type":"rpc","call":{"method":"security.backup.status"}}),
        json!({"type":"file","action":"read"}),
        json!({"type":"voice-keepalive"}),
        json!({"type":"voice-stop"}),
    ] {
        assert!(!needs_activity(&request));
    }
    for request in [
        json!({"type":"rpc","call":{"method":"message.send"}}),
        json!({"type":"rpc","call":{"method":"thread.create"}}),
        json!({"type":"rpc","call":{"method":"upload.begin"}}),
        json!({"type":"rpc","call":{"method":"upload.chunk"}}),
        json!({"type":"rpc","call":{"method":"security.backup.import"}}),
        json!({"type":"file","action":"write"}),
        json!({"type":"file","action":"storage-import"}),
        json!({"type":"voice-start"}),
    ] {
        assert!(needs_activity(&request));
    }
}

#[tokio::test]
async fn accepted_storage_work_stays_protected_after_reader_disconnects() {
    let directory = tempfile::tempdir().unwrap();
    let db = Arc::new(Mutex::new(
        crate::state::Store::open(&directory.path().join("state")).unwrap(),
    ));
    let gate = UpdateGate::default();
    let activity = Arc::new(gate.admit().unwrap());
    let (finish, wait) = oneshot::channel::<()>();
    let (settled, done) = oneshot::channel();
    let mut jobs = StorageJobs(JoinSet::new());
    let ongoing = activity.clone();
    jobs.spawn(async move {
        let _activity = ongoing;
        let _ = wait.await;
        let _ = settled.send(());
    });
    drop(activity);
    drop(jobs);
    assert!(
        !gate.drain_requested(&db, true).unwrap(),
        "disconnect must not cancel the owned receipt/write"
    );
    finish.send(()).unwrap();
    done.await.unwrap();
    tokio::task::yield_now().await;
    assert!(gate.drain_requested(&db, true).unwrap());
}
