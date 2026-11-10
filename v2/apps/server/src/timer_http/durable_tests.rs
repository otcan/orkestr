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
        DurableTick {
            scanned: 1,
            admitted: 0,
            deferred: 1
        }
    );
    store.revoke_session(BROWSER).await.unwrap();
    let mut restarted = DurableTimerController::new(bound.clone());
    assert_eq!(restarted.tick().await.unwrap().scanned, 1);
    // Simulates new controller plus freshly reopened Store attachment; no browser auth.
    let reopened = Store::open(&dir.join("core.sqlite3")).await.unwrap();
    let rebound = bound.reattach_supervisor(&reopened).await.unwrap();
    let mut restarted = DurableTimerController::new(rebound);
    assert_eq!(restarted.tick().await.unwrap().deferred, 1);
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
    let (store, bound, _, _, _, dir) = fixture().await;
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
