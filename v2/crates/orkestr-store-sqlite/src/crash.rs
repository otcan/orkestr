//! Test-only process fault injection; absent from production builds.
use crate::Store;
use orkestr_v2_domain::{ConversationKind, Envelope, Event, JournalRecord};
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

pub(super) fn checkpoint(phase: &str) {
    if std::env::var("ORKESTR_TEST_CRASH_PHASE").as_deref() == Ok(phase) {
        let marker = std::env::var_os("ORKESTR_TEST_CRASH_MARKER").unwrap();
        let marker = std::path::PathBuf::from(marker);
        let pending = marker.with_extension("pending");
        std::fs::write(&pending, phase).unwrap();
        std::fs::rename(pending, marker).unwrap();
        loop {
            std::thread::park();
        }
    }
}

fn record() -> JournalRecord {
    JournalRecord::new(Envelope {
        event_id: "crash-event".into(),
        event: Event::ConversationCreated {
            id: "home".into(),
            kind: ConversationKind::Home,
            parent_id: None,
        },
    })
}

#[tokio::test]
async fn crash_child() {
    let Some(path) = std::env::var_os("ORKESTR_TEST_CRASH_DB") else {
        return;
    };
    let store = Store::open(path).await.unwrap();
    store.append(&record()).await.unwrap();
    panic!("fault checkpoint was not reached");
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn kill_at(path: &Path, phase: &str) {
    let marker = path.with_extension("marker");
    let mut child = ChildGuard(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash::crash_child", "--nocapture"])
            .env("ORKESTR_TEST_CRASH_DB", path)
            .env("ORKESTR_TEST_CRASH_PHASE", phase)
            .env("ORKESTR_TEST_CRASH_MARKER", &marker)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    while !marker.exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "child exited before handshake"
        );
        assert!(Instant::now() < deadline, "child missed checkpoint");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(std::fs::read_to_string(marker).unwrap(), phase);
    child.0.kill().unwrap();
    let status = child.0.wait().unwrap();
    assert!(!status.success());
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(9));
    }
}

#[tokio::test]
async fn kill_before_commit_has_no_partial_event_or_projection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("before.sqlite");
    Store::open(&path).await.unwrap().close().await.unwrap();
    kill_at(&path, "before_commit");
    let store = Store::open(&path).await.unwrap();
    let snapshot = store.snapshot().await.unwrap();
    assert_eq!(snapshot.sequence, 0);
    assert!(snapshot.conversations.is_empty());
    assert_eq!(store.replay().await.unwrap(), snapshot);
    let receipt = store.append(&record()).await.unwrap();
    assert_eq!(receipt.sequence, 1);
    assert!(!receipt.duplicate);
}

#[tokio::test]
async fn kill_after_commit_retains_projection_and_lost_ack_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("after.sqlite");
    Store::open(&path).await.unwrap().close().await.unwrap();
    kill_at(&path, "after_commit");
    let store = Store::open(&path).await.unwrap();
    let snapshot = store.snapshot().await.unwrap();
    assert_eq!(snapshot.sequence, 1);
    assert!(snapshot.conversations.contains_key("home"));
    assert_eq!(store.replay().await.unwrap(), snapshot);
    let receipt = store.append(&record()).await.unwrap();
    assert_eq!(receipt.sequence, 1);
    assert!(receipt.duplicate);
}
