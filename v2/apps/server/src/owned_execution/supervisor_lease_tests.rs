//! The window's own supervisor heartbeat against a real Store whose write lock
//! another process holds, as a long writer does in production. No provider
//! process is started.
use super::*;
use std::time::Instant;

async fn execution() -> (ConfiguredExecution, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("supervisor-lease-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let conversation = store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = "cd".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let token_file = root.join("machine-token");
    std::fs::write(&token_file, token).unwrap();
    std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let config = Config {
        schema_version: 1,
        mode: "isolated-acceptance-v1".into(),
        conversation_id: conversation,
        machine_token_file: token_file,
        launcher: PathBuf::from("/usr/bin/true"),
        launcher_sha256: "0".repeat(64),
        workspace: root.clone(),
        workspace_authority: None,
        namespace: "synthetic-lease".into(),
        supervisor_key: "synthetic-lease".into(),
        provider: config::Provider::Codex,
        role: config::ExecutionRole::Fast,
        execution_budget: Default::default(),
        worker: None,
        provider_routing: None,
    };
    let execution = ConfiguredExecution::from_config(&store, &root, config, false)
        .await
        .unwrap();
    (execution, root)
}

/// Runs one SQL statement against the store file from another process.
fn sql(db: &std::path::Path, statement: &str) {
    let status = std::process::Command::new("python3")
        .arg("-c")
        .arg("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2]); c.commit(); c.close()")
        .arg(db)
        .arg(statement)
        .status()
        .expect("could not spawn python3");
    assert!(status.success(), "{statement}");
}

/// Takes the write lock from another process and holds it until killed.
/// Returns once the helper has confirmed the lock is held.
async fn hold_write_lock(db: &std::path::Path) -> std::process::Child {
    let held = db.with_extension("lock-held");
    let child = std::process::Command::new("python3")
        .arg("-c")
        .arg(
            "import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1], isolation_level=None, timeout=5); \
             c.execute('BEGIN EXCLUSIVE'); open(sys.argv[2],'w').write('held'); time.sleep(600)",
        )
        .arg(db)
        .arg(&held)
        .spawn()
        .expect("could not spawn python3");
    let deadline = Instant::now() + Duration::from_secs(15);
    while !held.exists() {
        assert!(
            Instant::now() < deadline,
            "helper never confirmed the write lock"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    child
}

fn release_write_lock(mut child: std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn due() -> Instant {
    Instant::now()
        .checked_sub(Duration::from_secs(11))
        .expect("monotonic clock is older than 11 s")
}

async fn finish(execution: ConfiguredExecution, root: PathBuf) {
    execution.store.close().await;
    drop(execution);
    std::fs::remove_dir_all(root).unwrap();
}

/// The regression: a writer holding SQLite past busy_timeout used to end the
/// window with "execution supervisor heartbeat refused" and cancel its run.
/// Now the heartbeat is deferred with backoff and renews once the lock clears.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn held_write_lock_defers_the_heartbeat_instead_of_pausing() {
    let (execution, root) = execution().await;
    let db = root.join("core.sqlite3");
    let before = execution
        .store
        .supervisor_lease_remaining_ms()
        .await
        .unwrap();
    let mut heartbeat = due();
    let holder = hold_write_lock(&db).await;
    let started = Instant::now();
    assert_eq!(
        execution.maintain(&mut heartbeat).await,
        Ok(()),
        "a transient store lock must not pause the window"
    );
    assert!(
        started.elapsed() >= Duration::from_secs(4),
        "the heartbeat must really have waited on the held lock"
    );
    assert!(execution.supervisor_lease.retry_pending(Instant::now()));
    assert!(
        admission::heartbeat_due(heartbeat, Instant::now()),
        "a deferred heartbeat is still due"
    );
    // While the retry waits, maintain does not hammer the locked store.
    let quick = Instant::now();
    assert_eq!(execution.maintain(&mut heartbeat).await, Ok(()));
    assert!(quick.elapsed() < Duration::from_secs(2));
    let during = execution
        .store
        .supervisor_lease_remaining_ms()
        .await
        .unwrap();
    assert!(during < before, "the lock did not block the heartbeat");

    release_write_lock(holder);
    let deadline = Instant::now() + Duration::from_secs(10);
    while execution.supervisor_lease.retry_pending(Instant::now()) {
        assert!(Instant::now() < deadline, "retry never became due");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(execution.maintain(&mut heartbeat).await, Ok(()));
    assert!(
        !admission::heartbeat_due(heartbeat, Instant::now()),
        "heartbeat accepted"
    );
    assert!(!execution.supervisor_lease.retry_pending(Instant::now()));
    assert!(
        execution
            .store
            .supervisor_lease_remaining_ms()
            .await
            .unwrap()
            > during,
        "the lease did not advance after the lock cleared"
    );
    finish(execution, root).await;
}

/// Deferral is bounded by Core's real lease: when it would lapse, the window
/// still pauses.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lease_about_to_lapse_still_pauses() {
    let (execution, root) = execution().await;
    let db = root.join("core.sqlite3");
    sql(
        &db,
        "UPDATE production_supervisors SET lease_deadline_ms=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)+8000",
    );
    let mut heartbeat = due();
    let holder = hold_write_lock(&db).await;
    let result = execution.maintain(&mut heartbeat).await;
    release_write_lock(holder);
    assert_eq!(result, Err("execution supervisor heartbeat refused"));
    finish(execution, root).await;
}

/// Lost authority is not transient: a replaced supervisor generation pauses at
/// once, without waiting out any backoff.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lost_authority_still_pauses_at_once() {
    let (execution, root) = execution().await;
    sql(
        &root.join("core.sqlite3"),
        "UPDATE production_supervisors SET generation=generation+1",
    );
    let mut heartbeat = due();
    let started = Instant::now();
    assert_eq!(
        execution.maintain(&mut heartbeat).await,
        Err("execution supervisor heartbeat refused")
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(!execution.supervisor_lease.retry_pending(Instant::now()));
    finish(execution, root).await;
}
