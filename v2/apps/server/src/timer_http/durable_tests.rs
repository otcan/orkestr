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
