use super::*;
use orkestr_v2_application::runtime::{
    ProductionSupervisorConfig, ProductionTakeover, ProviderKind,
};
use orkestr_v2_contracts::{ConversationId, OwnerId};
use orkestr_v2_store_sqlite::history_import::timers::{
    authority::DurableTimerEnable, TimerEnableRequest, TimerImportRequest, TimerSchedule,
};

const MACHINE: &str = "abababababababababababababababababababababababababababababababab";
const BROWSER: &str = "browser:synthetic-timer-creator";
async fn fixture() -> (
    Store,
    Store,
    OwnerId,
    Uuid,
    ConversationId,
    std::path::PathBuf,
) {
    let dir = std::env::temp_dir().join(format!("durable-controller-{}", Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let store = Store::open(&dir.join("core.sqlite3")).await.unwrap();
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
    store.save_session(MACHINE, &owner).await.unwrap();
    store.save_session(BROWSER, &owner).await.unwrap();
    let bound = store
        .authorize_supervisor(
            MACHINE,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "synthetic-provider".into(),
                supervisor_key: "timer-controller".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let namespace = Uuid::new_v4();
    store
        .import_dormant_timer(
            BROWSER,
            &owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "synthetic-source".into(),
                source_timer_id: "synthetic-weekly".into(),
                source_enabled: true,
                schedule: TimerSchedule::Interval {
                    every_ms: 7 * 86_400_000,
                },
            },
        )
        .await
        .unwrap();
    store
        .enable_durable_timer(
            BROWSER,
            &owner,
            &DurableTimerEnable {
                timer: TimerEnableRequest {
                    namespace,
                    expected_revision: 1,
                    request_key: "fresh-enable".into(),
                    conversation_id: conversation.clone(),
                },
                instruction: "Fresh synthetic owner instruction".into(),
            },
        )
        .await
        .unwrap();
    (store, bound, owner, namespace, conversation, dir)
}
#[test]
fn bounded_keyset_wraps_only_after_short_or_empty_page() {
    let full: Vec<_> = (1..=32).map(Uuid::from_u128).collect();
    assert_eq!(next_cursor(&full), Some(Uuid::from_u128(32)));
    assert_eq!(next_cursor(&full[..31]), None);
    assert_eq!(next_cursor(&[]), None);
}
#[tokio::test]
async fn registered_store_long_due_logout_restart_and_machine_revoke() {
    let (store, bound, owner, namespace, _conversation, dir) = fixture().await;
    let mut controller = DurableTimerController::new(bound.clone());
    assert_eq!(
        controller.tick().await.unwrap(),
        // Not due yet: nothing is scanned or retried.
        DurableTick {
            scanned: 0,
            admitted: 0,
            deferred: 0,
            ..Default::default()
        }
    );
    store.revoke_session(BROWSER).await.unwrap();
    let mut restarted = DurableTimerController::new(bound.clone());
    assert_eq!(restarted.tick().await.unwrap(), DurableTick::default());
    // Simulates new controller plus freshly reopened Store attachment; no browser auth.
    let reopened = Store::open(&dir.join("core.sqlite3")).await.unwrap();
    let rebound = bound.reattach_supervisor(&reopened).await.unwrap();
    let mut restarted = DurableTimerController::new(rebound);
    assert_eq!(restarted.tick().await.unwrap(), DurableTick::default());
    let current = store
        .dormant_timer_receipt(MACHINE, &owner, namespace)
        .await
        .unwrap();
    store
        .revoke_durable_timer(
            MACHINE,
            &owner,
            namespace,
            current.revision,
            "explicit-revoke".into(),
        )
        .await
        .unwrap();
    assert_eq!(restarted.tick().await.unwrap().scanned, 0);
    store.revoke_session(MACHINE).await.unwrap();
    assert!(matches!(
        restarted.tick().await,
        Err(HistoryError::Unauthorized)
    ));
    reopened.close().await;
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn ordinary_store_refuses_and_shutdown_is_joinable_without_tick() {
    let (store, _bound, _, _, _, dir) = fixture().await;
    let bound = store.authorize_timer_supervisor(MACHINE).await.unwrap();
    let mut ordinary = DurableTimerController::new(store.clone());
    assert!(matches!(
        ordinary.tick().await,
        Err(HistoryError::Unauthorized)
    ));
    let (shutdown, receiver) = tokio::sync::watch::channel(true);
    DurableTimerController::new(bound)
        .run(receiver)
        .await
        .unwrap();
    drop(shutdown);
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn actual_store_clock_due_once_is_not_readmitted_after_controller_restart() {
    let (store, bound, owner, _, conversation, dir) = fixture().await;
    let namespace = Uuid::new_v4();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    store
        .import_dormant_timer(
            BROWSER,
            &owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "synthetic-source".into(),
                source_timer_id: "synthetic-once".into(),
                source_enabled: false,
                schedule: TimerSchedule::Once {
                    due_ms: now + 2_000,
                },
            },
        )
        .await
        .unwrap();
    store
        .enable_durable_timer(
            BROWSER,
            &owner,
            &DurableTimerEnable {
                timer: TimerEnableRequest {
                    namespace,
                    expected_revision: 1,
                    request_key: "fresh-once".into(),
                    conversation_id: conversation,
                },
                instruction: "Fresh synthetic once instruction".into(),
            },
        )
        .await
        .unwrap();
    let mut controller = DurableTimerController::new(bound.clone());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut admitted = 0;
    while admitted == 0 && tokio::time::Instant::now() < deadline {
        admitted += controller.tick().await.unwrap().admitted;
        if admitted == 0 {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    assert_eq!(admitted, 1);
    let reopened = Store::open(&dir.join("core.sqlite3")).await.unwrap();
    let rebound = bound.reattach_supervisor(&reopened).await.unwrap();
    let mut restarted = DurableTimerController::new(rebound);
    assert_eq!(restarted.tick().await.unwrap().admitted, 0);
    assert_eq!(
        store
            .dormant_timer_receipt(MACHINE, &owner, namespace)
            .await
            .unwrap()
            .state,
        orkestr_v2_store_sqlite::history_import::timers::TimerState::Exhausted
    );
    reopened.close().await;
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn trusted_controller_start_renews_current_service_and_retires_exact_context() {
    let (store, _other, _, _, _, dir) = fixture().await;
    let bound = store.authorize_timer_supervisor(MACHINE).await.unwrap();
    let changed = std::process::Command::new("python3")
        .arg("-c")
        .arg("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE auth_sessions SET expires_at=unixepoch()+30'); c.commit(); c.close()")
        .arg(dir.join("core.sqlite3")).status().unwrap();
    assert!(changed.success());
    let (_shutdown, receiver) = tokio::sync::watch::channel(true);
    DurableTimerController::new(bound.clone())
        .run(receiver)
        .await
        .unwrap();
    let checked = std::process::Command::new("python3")
        .arg("-c")
        .arg("import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); n=c.execute('SELECT max(expires_at)-unixepoch() FROM auth_sessions').fetchone()[0]; assert 43199<=n<=43200; c.close()")
        .arg(dir.join("core.sqlite3")).status().unwrap();
    assert!(checked.success());
    assert!(bound.timer_scheduler_candidates(None, 1).await.is_err());
    let successor = store.authorize_timer_supervisor(MACHINE).await.unwrap();
    successor.retire_timer_supervisor().await.unwrap();
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn retry_backoff_doubles_from_five_seconds_to_fifteen_minutes() {
    let delays: Vec<u64> = (1..=10).map(|n| retry_delay(n).as_secs()).collect();
    assert_eq!(delays, [5, 10, 20, 40, 80, 160, 320, 640, 900, 900]);
    assert_eq!(retry_delay(u32::MAX), RETRY_MAX);
}

#[tokio::test]
async fn due_occurrence_that_cannot_be_admitted_backs_off_without_rescanning() {
    let (store, bound, owner, namespace, _conversation, dir) = fixture().await;
    let database = dir.join("core.sqlite3");
    let sql = |statement: String| {
        let status = std::process::Command::new("python3")
            .arg("-c")
            .arg("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2]); c.commit(); c.close()")
            .arg(&database)
            .arg(statement)
            .status()
            .unwrap();
        assert!(status.success());
    };
    // Due now, but its Stop watermark no longer matches (as after an owner Stop).
    sql(format!("UPDATE dormant_timers SET next_due_ms=next_due_ms-30*86400000 WHERE namespace='{namespace}'"));
    sql(format!("UPDATE dormant_timer_input_guards SET stop_sequence=stop_sequence+7 WHERE namespace='{namespace}'"));
    let woken = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let counter = woken.clone();
    let mut controller = DurableTimerController::new(bound.clone()).with_window_dispatch(
        std::sync::Arc::new(move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }),
    );
    assert_eq!(
        controller.tick().await.unwrap(),
        DurableTick {
            scanned: 1,
            admitted: 0,
            deferred: 1,
            ..Default::default()
        }
    );
    // Held in backoff: not rescanned on the next one-second tick.
    assert_eq!(
        controller.tick().await.unwrap(),
        DurableTick {
            scanned: 0,
            admitted: 0,
            deferred: 1,
            ..Default::default()
        }
    );
    assert_eq!(woken.load(std::sync::atomic::Ordering::SeqCst), 0);
    // A fresh controller (restart) retries once and admits after repair.
    sql(format!("UPDATE dormant_timer_input_guards SET stop_sequence=stop_sequence-7 WHERE namespace='{namespace}'"));
    let mut restarted = DurableTimerController::new(bound.clone());
    assert_eq!(restarted.tick().await.unwrap().admitted, 1);
    assert_eq!(
        store
            .dormant_timer_receipt(MACHINE, &owner, namespace)
            .await
            .unwrap()
            .state,
        orkestr_v2_store_sqlite::history_import::timers::TimerState::Enabled
    );
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn deploy_drain_defers_a_due_fire_until_resume() {
    let (store, bound, owner, _, conversation, dir) = fixture().await;
    let namespace = Uuid::new_v4();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    store
        .import_dormant_timer(
            BROWSER,
            &owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "synthetic-source".into(),
                source_timer_id: "synthetic-drained-once".into(),
                source_enabled: false,
                schedule: TimerSchedule::Once { due_ms: now + 500 },
            },
        )
        .await
        .unwrap();
    store
        .enable_durable_timer(
            BROWSER,
            &owner,
            &DurableTimerEnable {
                timer: TimerEnableRequest {
                    namespace,
                    expected_revision: 1,
                    request_key: "drained-once".into(),
                    conversation_id: conversation,
                },
                instruction: "Fresh synthetic drained instruction".into(),
            },
        )
        .await
        .unwrap();
    let paused = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let flag = paused.clone();
    let mut controller =
        DurableTimerController::new(bound.clone()).with_pause(Arc::new(move || {
            flag.load(std::sync::atomic::Ordering::Acquire)
        }));
    tokio::time::sleep(Duration::from_millis(800)).await;
    // Due, but drained: nothing fires and the occurrence stays due.
    for _ in 0..3 {
        assert_eq!(controller.tick().await.unwrap(), DurableTick::default());
    }
    paused.store(false, std::sync::atomic::Ordering::Release);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut admitted = 0;
    while admitted == 0 && tokio::time::Instant::now() < deadline {
        admitted += controller.tick().await.unwrap().admitted;
        if admitted == 0 {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    assert_eq!(admitted, 1, "the deferred occurrence fires after resume");
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

// ORK: a locked store must not read as a revoked credential.
#[test]
fn only_authority_loss_stops_the_supervisor() {
    // Transient infrastructure: the lease is still valid, so the controller holds.
    for transient in [RuntimeStoreError::Busy, RuntimeStoreError::Unavailable] {
        assert!(
            !supervisor_authority_lost(&transient),
            "{transient:?} is a locked or unavailable store, not lost authority"
        );
    }
    // Authority actually gone, or a context that no longer matches: still fatal.
    for fatal in [
        RuntimeStoreError::Unauthorized,
        RuntimeStoreError::Fenced,
        RuntimeStoreError::Expired,
        RuntimeStoreError::StaleLease,
        RuntimeStoreError::Conflict,
        RuntimeStoreError::NotFound,
        RuntimeStoreError::InvalidInput,
    ] {
        assert!(
            supervisor_authority_lost(&fatal),
            "{fatal:?} must still stop the controller"
        );
    }
    // Spending at most half the 60 s lease keeps a margin against the Store's own deadline.
    assert!(SUPERVISOR_GRACE < Duration::from_secs(60));
}

// ORK: a genuinely expired session must still terminate the controller, with the
// real cause surfaced rather than every failure collapsed to Unauthorized.
#[tokio::test]
async fn expired_session_still_refuses_startup() {
    let (store, _other, _, _, _, dir) = fixture().await;
    let bound = store.authorize_timer_supervisor(MACHINE).await.unwrap();
    let expired = std::process::Command::new("python3")
        .arg("-c")
        .arg("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE auth_sessions SET expires_at=unixepoch()-1'); c.commit(); c.close()")
        .arg(dir.join("core.sqlite3"))
        .status()
        .unwrap();
    assert!(expired.success());
    let (_shutdown, receiver) = tokio::sync::watch::channel(false);
    assert!(matches!(
        DurableTimerController::new(bound).run(receiver).await,
        Err(HistoryError::Unauthorized)
    ));
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

// Reads the supervisor lease that the heartbeat writes. WAL lets a reader observe
// it while a writer holds the write lock. Runs on a blocking pool and is bounded,
// so it can never stall an executor thread or wait forever.
async fn lease_deadline_ms(db: &std::path::Path) -> i64 {
    let path = db.to_path_buf();
    let joined = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::task::spawn_blocking(move || {
            std::process::Command::new("python3")
                .arg("-c")
                .arg(
                    "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,timeout=5); \
                     print(c.execute('SELECT coalesce(max(lease_deadline_ms),0) FROM production_supervisors').fetchone()[0]); \
                     c.close()",
                )
                .arg(path)
                .output()
        }),
    )
    .await
    .expect("lease read did not return within 20s")
    .expect("lease reader panicked")
    .expect("could not spawn python3");
    assert!(
        joined.status.success(),
        "lease read failed: {}",
        String::from_utf8_lossy(&joined.stderr)
    );
    String::from_utf8(joined.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

// Takes the write lock and holds it until killed, so release is immediate and
// deterministic rather than a race between a sleep and the test's own clock.
// Returns once the helper has CONFIRMED the lock is held, so contention is a fact.
async fn hold_write_lock(db: &std::path::Path, held: &std::path::Path) -> std::process::Child {
    let child = std::process::Command::new("python3")
        .arg("-c")
        .arg(
            "import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1], isolation_level=None, timeout=5); \
             c.execute('BEGIN EXCLUSIVE'); open(sys.argv[2],'w').write('held'); time.sleep(600)",
        )
        .arg(db)
        .arg(held)
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

// SIGKILL drops the connection, so the OS releases the lock at once.
fn release_write_lock(mut child: std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

// ORK: the regression itself, bounded and deterministic.
//
// Proves, via the lease the heartbeat actually writes: the controller is live and
// heartbeating; the lock is confirmed held; the heartbeat is genuinely blocked
// (lease stops advancing); the controller does NOT die; and it resumes once the
// lock clears. multi_thread so a blocking helper can never starve the controller
// or tokio's timers.
//
// Against the deployed controller this fails at the survival assertion:
// heartbeat_supervisor returns Unavailable, which the old
// `.map_err(|_| HistoryError::Unauthorized)?` turned into a fatal exit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transient_store_lock_does_not_end_the_controller() {
    let (store, _unbound, _, _, _, dir) = fixture().await;
    let bound = store.authorize_timer_supervisor(MACHINE).await.unwrap();
    let db = dir.join("core.sqlite3");
    let (shutdown, receiver) = tokio::sync::watch::channel(false);
    let controller = tokio::spawn(DurableTimerController::new(bound).run(receiver));

    // 1. Really heartbeating: the lease advances unaided.
    let first = lease_deadline_ms(&db).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let before = lease_deadline_ms(&db).await;
    assert!(
        before > first,
        "controller is not heartbeating: lease stuck at {first}"
    );

    // 2. Contention, confirmed held, spanning several one-second renewals.
    let held = dir.join("lock-held");
    let holder = hold_write_lock(&db, &held).await;
    let during = lease_deadline_ms(&db).await;
    tokio::time::sleep(Duration::from_secs(8)).await;
    assert_eq!(
        lease_deadline_ms(&db).await,
        during,
        "the write lock did not actually block the heartbeat"
    );
    // 3. Past busy_timeout and several missed renewals: still alive.
    assert!(
        !controller.is_finished(),
        "a transient store lock ended the controller"
    );

    // 4. Recovery: the lease advances again once the lock clears.
    release_write_lock(holder);
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert!(
        lease_deadline_ms(&db).await > during,
        "controller did not resume heartbeating after the lock cleared"
    );

    let _ = shutdown.send(true);
    tokio::time::timeout(Duration::from_secs(15), controller)
        .await
        .expect("controller did not observe shutdown")
        .unwrap()
        .unwrap();
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

// ORK: the grace is a bound, not an amnesty. An outage longer than the window
// must still end the controller, and as Unavailable so the cause is not
// misreported as lost authority.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outage_past_the_grace_window_still_ends_the_controller() {
    let (store, _unbound, _, _, _, dir) = fixture().await;
    let bound = store.authorize_timer_supervisor(MACHINE).await.unwrap();
    let db = dir.join("core.sqlite3");
    let mut controller = DurableTimerController::new(bound);
    // Longer than one busy_timeout (5s) so this measures the WINDOW elapsing
    // across repeated failures rather than a single blocked call.
    controller.test_grace = Some(Duration::from_secs(8));
    let (_shutdown, receiver) = tokio::sync::watch::channel(false);
    let handle = tokio::spawn(controller.run(receiver));
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(!handle.is_finished(), "controller died before contention");

    let held = dir.join("lock-held-long");
    let holder = hold_write_lock(&db, &held).await;
    let outcome = tokio::time::timeout(Duration::from_secs(40), handle)
        .await
        .expect("grace window did not terminate the controller")
        .unwrap();
    release_write_lock(holder);
    assert!(
        matches!(outcome, Err(HistoryError::Unavailable)),
        "a store outage must end as Unavailable, got {outcome:?}"
    );
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

// ORK: a revoked session is real authority loss and must still terminate the
// controller mid-run - the grace window must not swallow it. Covers
// heartbeat_supervisor; expired_session_still_refuses_startup covers
// renew_timer_supervisor_credential.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoked_session_terminates_the_running_controller() {
    let (store, _unbound, _, _, _, dir) = fixture().await;
    let bound = store.authorize_timer_supervisor(MACHINE).await.unwrap();
    let (_shutdown, receiver) = tokio::sync::watch::channel(false);
    let controller = tokio::spawn(DurableTimerController::new(bound).run(receiver));
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        !controller.is_finished(),
        "controller died before revocation"
    );
    store.revoke_session(MACHINE).await.unwrap();
    // Fatal on the next tick; emphatically NOT retried for the grace window.
    let outcome = tokio::time::timeout(Duration::from_secs(20), controller)
        .await
        .expect("revocation did not stop the controller")
        .unwrap();
    assert!(matches!(outcome, Err(HistoryError::Unauthorized)));
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

// ORK: the inverse failure. tick() returns Ok WITHOUT any store call when paused
// (also while timeout_retry is pending, and after a 5s pass timeout). If a bare
// tick()==Ok reset the grace window, a controller whose heartbeat kept failing
// would run indefinitely on an unrenewed lease - free to act while a successor
// could legitimately take over. Only heartbeat_supervisor and
// renew_timer_supervisor_credential extend lease_deadline_ms, so only they may
// move the window. Pause makes every tick an Ok that must NOT count.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paused_ticks_do_not_extend_the_grace_window() {
    let (store, _unbound, _, _, _, dir) = fixture().await;
    let bound = store.authorize_timer_supervisor(MACHINE).await.unwrap();
    let db = dir.join("core.sqlite3");
    let mut controller = DurableTimerController::new(bound).with_pause(Arc::new(|| true));
    // The grace MUST outlast one failed heartbeat. A blocked BEGIN IMMEDIATE
    // returns only after busy_timeout (5s), so a 2s window ended the controller on
    // the first failure and no paused tick ever ran - the test passed whether or
    // not a bare tick()==Ok reset the window, proving nothing. 12s reaches
    // failed-heartbeat -> paused-Ok -> retry twice while the window is unspent.
    controller.test_grace = Some(Duration::from_secs(12));
    let (_shutdown, receiver) = tokio::sync::watch::channel(false);
    let handle = tokio::spawn(controller.run(receiver));
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(!handle.is_finished(), "controller died before contention");

    // Corrected: failures accumulate and it ends at ~15s (third failure, past 12s).
    // With a tick()==Ok reset restored the window clears every ~5s, the controller
    // never ends, and this bounded wait FAILS instead of hanging CI.
    let held = dir.join("lock-held-paused");
    let holder = hold_write_lock(&db, &held).await;
    let outcome = tokio::time::timeout(Duration::from_secs(45), handle)
        .await
        .expect("paused Ok ticks extended the grace window past the real lease")
        .unwrap();
    release_write_lock(holder);
    assert!(
        matches!(outcome, Err(HistoryError::Unavailable)),
        "expected Unavailable once the window elapsed, got {outcome:?}"
    );
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

// The pilot exit of 2026-11-05: the controller task was not polled for 102s, then
// resumed into a store call whose own deadline had lapsed and returned
// Unavailable. The store had answered everyone else throughout. Judged by the
// stale stamp alone that ended the controller as a store outage. With the lease
// still valid the heartbeat renews it and the controller carries on.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unscheduled_pass_with_a_live_lease_does_not_end_the_controller() {
    let (store, _unbound, _, _, _, dir) = fixture().await;
    let bound = store.authorize_timer_supervisor(MACHINE).await.unwrap();
    let db = dir.join("core.sqlite3");
    let mut controller = DurableTimerController::new(bound);
    controller.test_grace = Some(Duration::from_secs(2));
    // Longer than the grace, far shorter than the 60s lease.
    controller.test_unscheduled_pass = Some(Duration::from_secs(5));
    let (shutdown, receiver) = tokio::sync::watch::channel(false);
    let handle = tokio::spawn(controller.run(receiver));

    tokio::time::sleep(Duration::from_secs(8)).await;
    assert!(
        !handle.is_finished(),
        "a pass that was merely not scheduled ended the controller"
    );
    let resumed = lease_deadline_ms(&db).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(
        lease_deadline_ms(&db).await > resumed,
        "controller did not resume heartbeating after the stall"
    );

    let _ = shutdown.send(true);
    tokio::time::timeout(Duration::from_secs(15), handle)
        .await
        .expect("controller did not observe shutdown")
        .unwrap()
        .unwrap();
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

// The same stall, but authority really was lost while the task did not run. The
// heartbeat says so, and the controller ends as lost authority, not as an outage.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unscheduled_pass_that_lost_authority_ends_as_unauthorized() {
    let (store, _unbound, _, _, _, dir) = fixture().await;
    let bound = store.authorize_timer_supervisor(MACHINE).await.unwrap();
    let mut controller = DurableTimerController::new(bound);
    controller.test_grace = Some(Duration::from_secs(2));
    controller.test_unscheduled_pass = Some(Duration::from_secs(5));
    let (_shutdown, receiver) = tokio::sync::watch::channel(false);
    let handle = tokio::spawn(controller.run(receiver));

    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        !handle.is_finished(),
        "controller died before the stall ended"
    );
    store.revoke_session(MACHINE).await.unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(20), handle)
        .await
        .expect("lost authority did not stop the controller")
        .unwrap();
    assert!(
        matches!(outcome, Err(HistoryError::Unauthorized)),
        "authority lost during a stall must end as Unauthorized, got {outcome:?}"
    );
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}
