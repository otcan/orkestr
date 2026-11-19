//! The window's own supervisor heartbeat against a real Store whose write lock
//! another process holds, as a long writer does in production. No provider
//! process is started.
use super::*;
use std::time::Instant;
use supervisor_lease::{SupervisorLease, LEASE_MARGIN};

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
    wait_for_retry(&execution).await;
    assert_eq!(execution.maintain(&mut heartbeat).await, Ok(()));
    assert!(
        !admission::heartbeat_due(heartbeat, Instant::now()),
        "heartbeat accepted"
    );
    assert!(!execution.supervisor_lease.deferred());
    let after = execution
        .store
        .supervisor_lease_remaining_ms()
        .await
        .unwrap();
    assert!(
        after > during,
        "the lease did not advance after the lock cleared"
    );
    // The local bound assumes Core grants SUPERVISOR_LEASE; it must not grant less.
    assert!(after <= supervisor_lease::SUPERVISOR_LEASE.as_millis() as i64);
    assert!(
        execution
            .supervisor_lease
            .remaining(Instant::now())
            .unwrap()
            <= supervisor_lease::SUPERVISOR_LEASE
    );
    finish(execution, root).await;
}

async fn wait_for_retry(execution: &ConfiguredExecution) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while execution.supervisor_lease.retry_pending(Instant::now()) {
        assert!(Instant::now() < deadline, "retry never became due");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
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

/// The proven local bound is checked on every maintain, also while a retry
/// waits and with no heartbeat due: a window that cannot renew pauses while
/// the margin is still left, never after Core's lease lapsed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_local_bound_pauses_while_a_retry_is_pending() {
    let (execution, root) = execution().await;
    let db = root.join("core.sqlite3");
    let mut heartbeat = due();
    assert_eq!(execution.maintain(&mut heartbeat).await, Ok(()));
    let holder = hold_write_lock(&db).await;
    let started = Instant::now();
    let deadline = started + supervisor_lease::SUPERVISOR_LEASE;
    let paused = loop {
        if let Err(reason) = execution.maintain(&mut heartbeat).await {
            break reason;
        }
        assert!(Instant::now() < deadline, "the window outlived its lease");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    release_write_lock(holder);
    assert_eq!(paused, "execution supervisor heartbeat refused");
    let left = deadline.saturating_duration_since(Instant::now());
    assert!(
        left >= LEASE_MARGIN - Duration::from_secs(8),
        "paused only {left:?} before Core's lease would lapse"
    );
    finish(execution, root).await;
}

/// Lost authority is not transient, even while the store is locked: the
/// validated lease read reports it and the window pauses without deferring.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lost_authority_pauses_while_the_store_is_locked() {
    let (execution, root) = execution().await;
    let db = root.join("core.sqlite3");
    sql(
        &db,
        "UPDATE production_supervisors SET generation=generation+1",
    );
    let holder = hold_write_lock(&db).await;
    let mut heartbeat = due();
    let started = Instant::now();
    let result = execution.maintain(&mut heartbeat).await;
    release_write_lock(holder);
    assert_eq!(result, Err("execution supervisor heartbeat refused"));
    assert!(
        started.elapsed() < Duration::from_secs(9),
        "one bounded heartbeat and one read, no backoff"
    );
    assert!(!execution.supervisor_lease.retry_pending(Instant::now()));
    finish(execution, root).await;
}

/// Every pooled connection busy on a held write lock: each store call on the
/// heartbeat path gives up at its timeout instead of the pool's 30 s acquire
/// timeout, and the proven lease keeps the window running.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_saturated_pool_is_bounded_by_the_call_timeouts() {
    let (mut execution, root) = execution().await;
    let timeout = Duration::from_secs(1);
    execution.supervisor_lease =
        std::sync::Arc::new(SupervisorLease::with_timeouts(timeout, timeout));
    let db = root.join("core.sqlite3");
    let mut heartbeat = due();
    assert_eq!(
        execution.maintain(&mut heartbeat).await,
        Ok(()),
        "lease proven"
    );
    let holder = hold_write_lock(&db).await;
    // More writers than pooled connections, each waiting out busy_timeout.
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let blockers: Vec<_> = (0..10)
        .map(|_| {
            let store = execution.store.clone();
            let stop = stop.clone();
            tokio::spawn(async move {
                while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = store.heartbeat_supervisor().await;
                }
            })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut due_now = due();
    let started = Instant::now();
    assert_eq!(execution.maintain(&mut due_now).await, Ok(()));
    assert!(
        started.elapsed() < Duration::from_millis(4_500),
        "maintain took {:?}; a call waited past its timeout",
        started.elapsed()
    );
    assert!(execution.supervisor_lease.deferred());
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    for blocker in blockers {
        blocker.abort();
    }
    release_write_lock(holder);
    finish(execution, root).await;
}

/// Admission after a deferral waits for a heartbeat Core accepts, so the run
/// is admitted on a full lease; shutdown ends the wait.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admission_waits_for_an_accepted_heartbeat_after_a_deferral() {
    let (execution, root) = execution().await;
    let db = root.join("core.sqlite3");
    let mut heartbeat = due();
    assert_eq!(execution.maintain(&mut heartbeat).await, Ok(()));
    let holder = hold_write_lock(&db).await;
    let mut deferred = due();
    assert_eq!(execution.maintain(&mut deferred).await, Ok(()));
    assert!(execution.supervisor_lease.deferred());

    // Shutdown during the wait: no admission.
    let (stop, mut shutdown) = watch::channel(false);
    let stopper = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let _ = stop.send(true);
    });
    assert_eq!(
        execution
            .accepted_heartbeat(&mut shutdown, &mut deferred)
            .await,
        Ok(false)
    );
    stopper.await.unwrap();

    // The lock clears while admission waits: it proceeds on a fresh grant.
    let (_sender, mut shutdown) = watch::channel(false);
    let release = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        release_write_lock(holder);
    });
    let started = Instant::now();
    assert_eq!(
        execution
            .accepted_heartbeat(&mut shutdown, &mut deferred)
            .await,
        Ok(true)
    );
    assert!(
        started.elapsed() >= Duration::from_secs(2),
        "admitted before the lock cleared"
    );
    release.await.unwrap();
    assert!(!execution.supervisor_lease.deferred());
    let remaining = execution
        .store
        .supervisor_lease_remaining_ms()
        .await
        .unwrap();
    assert!(
        remaining > 55_000,
        "admitted on a short lease: {remaining} ms"
    );
    finish(execution, root).await;
}

/// A running run's due lease renewal through a held lock: held while the
/// heartbeat is deferred and both leases keep the margin, released by an
/// accepted heartbeat once the lock clears; near the margin it goes ahead.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_due_run_renewal_is_held_through_a_lock() {
    let (execution, root) = execution().await;
    let db = root.join("core.sqlite3");
    let mut heartbeat = due();
    assert_eq!(execution.maintain(&mut heartbeat).await, Ok(()));
    let wall = supervisor_lease::wall_now_ms().unwrap();
    let run_deadline = wall + 40_000;
    assert_eq!(
        execution
            .run_renewal_ready(run_deadline, &mut heartbeat)
            .await,
        Ok(true),
        "a healthy store renews on schedule"
    );
    let holder = hold_write_lock(&db).await;
    let mut deferred = due();
    assert_eq!(execution.maintain(&mut deferred).await, Ok(()));
    let quick = Instant::now();
    assert_eq!(
        execution
            .run_renewal_ready(run_deadline, &mut deferred)
            .await,
        Ok(false),
        "a renewal against a locked store would quarantine the child"
    );
    assert!(
        quick.elapsed() < Duration::from_secs(1),
        "held without a store call"
    );
    // Down to the margin: one heartbeat attempt, then the renewal goes ahead.
    let short = supervisor_lease::wall_now_ms().unwrap()
        + i64::try_from(LEASE_MARGIN.as_millis()).unwrap()
        - 1_000;
    assert_eq!(
        execution.run_renewal_ready(short, &mut deferred).await,
        Ok(true)
    );
    release_write_lock(holder);
    wait_for_retry(&execution).await;
    assert_eq!(
        execution
            .run_renewal_ready(run_deadline, &mut deferred)
            .await,
        Ok(true),
        "an accepted heartbeat releases the renewal"
    );
    assert!(!execution.supervisor_lease.deferred());
    finish(execution, root).await;
}
