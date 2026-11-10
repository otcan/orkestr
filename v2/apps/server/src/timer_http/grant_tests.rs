//! Immutable retry regression: assertions apply to original and corrected controller.
use super::*;
use orkestr_v2_store_sqlite::history_import::timers::{TimerImportRequest, TimerSchedule};
async fn fixture() -> (
    TimerController,
    OwnerId,
    Uuid,
    dto::Enable,
    std::path::PathBuf,
) {
    let directory = std::env::temp_dir().join(format!("timer-grant-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let store = Store::open(&directory.join("store.sqlite3")).await.unwrap();
    let conversation = store
        .setup("synthetic-grant-owner", "synthetic-password-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-grant-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    store
        .save_session("synthetic-grant-token", &owner)
        .await
        .unwrap();
    let namespace = Uuid::new_v4();
    store
        .import_dormant_timer(
            "synthetic-grant-token",
            &owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "synthetic-grant".into(),
                source_timer_id: "fake-grant-timer".into(),
                source_enabled: true,
                schedule: TimerSchedule::Interval { every_ms: 60_000 },
            },
        )
        .await
        .unwrap();
    (
        TimerController::new(store),
        owner,
        namespace,
        dto::Enable {
            expected_revision: 1,
            request_key: "fake-grant-enable".into(),
            conversation_id: conversation,
            text: "Fresh synthetic work".into(),
        },
        directory,
    )
}
fn retry(body: &dto::Enable) -> dto::Enable {
    dto::Enable {
        expected_revision: body.expected_revision,
        request_key: body.request_key.clone(),
        conversation_id: body.conversation_id.clone(),
        text: body.text.clone(),
    }
}
#[tokio::test]
async fn exact_retry_never_extends_grant_expiry() {
    let (controller, owner, namespace, body, directory) = fixture().await;
    controller
        .enable(
            "synthetic-grant-token".into(),
            owner.clone(),
            namespace,
            retry(&body),
        )
        .await
        .unwrap();
    let key = TimerController::key(&owner, namespace);
    let expires = controller.grants.lock().await[&key].expires;
    controller
        .enable(
            "synthetic-grant-token".into(),
            owner.clone(),
            namespace,
            body,
        )
        .await
        .unwrap();
    assert_eq!(
        controller.grants.lock().await[&key].expires,
        expires,
        "retry must not renew grant"
    );
    controller.grants.lock().await.clear();
    controller.store.close().await;
    std::fs::remove_dir_all(directory).unwrap();
}
#[tokio::test]
async fn restart_or_expiry_retry_never_rearms_and_fresh_transition_does() {
    let (controller, owner, namespace, body, directory) = fixture().await;
    let enabled = controller
        .enable(
            "synthetic-grant-token".into(),
            owner.clone(),
            namespace,
            retry(&body),
        )
        .await
        .unwrap();
    let key = TimerController::key(&owner, namespace);
    controller
        .grants
        .lock()
        .await
        .get_mut(&key)
        .unwrap()
        .expires = Instant::now() - Duration::from_secs(1);
    controller
        .enable(
            "synthetic-grant-token".into(),
            owner.clone(),
            namespace,
            retry(&body),
        )
        .await
        .unwrap();
    assert!(
        !controller.armed(&owner, &enabled).await,
        "expired retry must not rearm"
    );
    let restarted = TimerController::new(controller.store.clone());
    restarted
        .enable(
            "synthetic-grant-token".into(),
            owner.clone(),
            namespace,
            retry(&body),
        )
        .await
        .unwrap();
    assert!(
        !restarted.armed(&owner, &enabled).await,
        "restart retry must not rearm"
    );
    let disabled = controller
        .store
        .control_dormant_timer(
            "synthetic-grant-token",
            &owner,
            &TimerControlRequest {
                namespace,
                expected_revision: enabled.revision,
                request_key: "fake-disable-grant".into(),
                action: TimerControl::Disable,
            },
        )
        .await
        .unwrap();
    let fresh = dto::Enable {
        expected_revision: disabled.revision,
        request_key: "fake-fresh-enable".into(),
        ..body
    };
    let enabled = restarted
        .enable(
            "synthetic-grant-token".into(),
            owner.clone(),
            namespace,
            fresh,
        )
        .await
        .unwrap();
    assert!(restarted.armed(&owner, &enabled).await);
    controller.grants.lock().await.clear();
    restarted.grants.lock().await.clear();
    controller.store.close().await;
    std::fs::remove_dir_all(directory).unwrap();
}
