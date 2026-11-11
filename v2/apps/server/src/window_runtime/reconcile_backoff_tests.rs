//! A manager-refused automatic reconcile waits for its spacing instead of
//! running again on every status poll and dispatcher pass (ORK-781). The
//! manager is a stand-in socket that counts connections; the client refuses
//! each as a foreign peer, so every manager step is refused.
use super::*;
use orkestr_v2_contracts::ExecutionWindowState;
use std::sync::atomic::{AtomicUsize, Ordering as Atomic};

fn expire(f: &Fixture, window: &ExecutionWindowStatus) {
    let out = std::process::Command::new("python3")
        .args([
            "-I",
            "-S",
            "-B",
            "-c",
            "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2],(sys.argv[3],)); c.commit()",
        ])
        .arg(f.root.join("core.sqlite3"))
        .arg("UPDATE execution_windows SET opened_at_ms=1,work_deadline_ms=870001,expires_at_ms=900001 WHERE id=?")
        .arg(window.window_id.to_string())
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A stand-in manager socket at a short path (a Unix socket path is limited
/// to 108 bytes; the fixture's home can be longer). Removed on drop.
struct CountingManager {
    path: std::path::PathBuf,
    count: Arc<AtomicUsize>,
}
impl CountingManager {
    fn start() -> Self {
        let path = std::path::PathBuf::from(format!(
            "/tmp/orkestr-reconcile-{}.sock",
            &Uuid::new_v4().simple().to_string()[..12]
        ));
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                seen.fetch_add(1, Atomic::SeqCst);
                drop(stream);
            }
        });
        Self { path, count }
    }
}
impl Drop for CountingManager {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn connections(count: &AtomicUsize) -> usize {
    let mut last = usize::MAX;
    loop {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let now = count.load(Atomic::SeqCst);
        if now == last {
            return now;
        }
        last = now;
    }
}

async fn refused_window(f: &Fixture) -> (ConversationId, ExecutionWindowStatus) {
    let conversation = f.conversation("refused-reconcile").await;
    let window = f.occupy(&conversation, "refused").await;
    expire(f, &window);
    (conversation, window)
}

#[tokio::test]
async fn a_manager_refused_window_is_not_retried_on_every_pass() {
    let f = fixture().await;
    let (conversation, _) = refused_window(&f).await;
    let manager = CountingManager::start();
    let controller = f.controller_at(8, manager.path.clone());
    controller.reconcile_expired_locked(BROWSER).await;
    let first = connections(&manager.count).await;
    assert!(first > 0, "the first pass asks the manager");
    // Status polls and dispatcher passes reach the automatic path about every
    // 0.75 s; before the spacing each one repeated every manager step.
    for _ in 0..5 {
        controller.reconcile_expired_locked(BROWSER).await;
    }
    assert_eq!(
        connections(&manager.count).await,
        first,
        "passes inside the spacing must not ask the manager again"
    );
    let status = f
        .store
        .execution_window_status_authenticated(BROWSER, &conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.state, ExecutionWindowState::ReconciliationRequired);
}

#[tokio::test]
async fn a_refused_window_is_retried_once_its_spacing_passes() {
    let f = fixture().await;
    let (_, window) = refused_window(&f).await;
    let manager = CountingManager::start();
    let controller = f.controller_at(8, manager.path.clone());
    controller.reconcile_expired_locked(BROWSER).await;
    let first = connections(&manager.count).await;
    assert_eq!(controller.reconcile_backoff.attempts(&window), 1);
    controller.reconcile_backoff.make_due(&window);
    controller.reconcile_expired_locked(BROWSER).await;
    assert_eq!(connections(&manager.count).await, 2 * first);
    assert_eq!(controller.reconcile_backoff.attempts(&window), 2);
}
