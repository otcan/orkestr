use super::*;
use crate::owner_password::PasswordChange;
use crate::production_runtime::tests as fixtures;
use orkestr_v2_application::runtime::ProductionTakeover;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;

#[tokio::test]
async fn password_rotation_preserves_actual_window_bootstrap_and_issued_credentials() {
    let home = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
    std::fs::create_dir_all(&home).unwrap();
    let path = home.join(format!("password-window-{}.sqlite3", Uuid::new_v4()));
    let store = Store::open(&path).await.unwrap();
    let conversation = store.setup("synthetic-owner", "old-hash").await.unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let browser = "browser:synthetic-window-rotation";
    store.save_session(browser, &owner).await.unwrap();
    let initial = store
        .bootstrap_execution_window_authenticated(
            browser,
            &conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    let receipt = store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "synthetic-rotation-input".into(),
                text: "synthetic work".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let admitted = store
        .admit_execution_window_authenticated(
            browser,
            &conversation,
            &ExecutionWindowRequest {
                request_key: "window:synthetic-rotation-input".into(),
                input_message_id: receipt.message_id,
                input_event_id: receipt.event_id,
                input_request_key: "synthetic-rotation-input".into(),
                expected_generation: 0,
                window_id: None,
                predecessor_window_id: None,
            },
        )
        .await
        .unwrap();
    let grant = initial
        .store()
        .issue_execution_window_credential(
            initial.credential(),
            admitted.status.window_id,
            1,
            "synthetic-password-rotation-boot",
            admitted.status.expires_at_ms,
            &"b".repeat(64),
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .change_owner_password(browser, "old-hash", "new-hash")
            .await
            .unwrap(),
        PasswordChange::Changed
    );
    assert!(store.authenticate(browser).await.unwrap().is_none());
    assert!(store
        .authenticate(initial.credential())
        .await
        .unwrap()
        .is_some());
    assert!(store
        .authenticate(grant.credential())
        .await
        .unwrap()
        .is_some());
    store.close().await;
    std::fs::remove_file(path).unwrap();
}
