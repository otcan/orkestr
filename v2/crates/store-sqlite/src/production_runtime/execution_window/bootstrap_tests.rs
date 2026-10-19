use super::*;
use crate::production_runtime::tests as fixtures;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;

async fn fresh() -> (Store, OwnerId, ConversationId, String) {
    let path = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("beta-first-owner-{}", Uuid::new_v4()))
        .join("core.sqlite3");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let store = Store::open(&path).await.unwrap();
    let conversation = store
        .setup("synthetic-first-owner", "synthetic-password-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-first-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    // Only the ordinary browser login session exists. No machine setup helper.
    let browser = format!("synthetic-first-browser-{}", Uuid::new_v4());
    store.save_session(&browser, &owner).await.unwrap();
    (store, owner, conversation, browser)
}
#[tokio::test]
async fn first_login_private_bootstrap_then_window_without_machine_file_or_readiness() {
    let (store, owner, conversation, browser) = fresh().await;
    let initial = store
        .bootstrap_execution_window_authenticated(
            &browser,
            &conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    assert_ne!(initial.credential(), browser);
    assert!(store
        .authorize_supervisor(
            initial.credential(),
            fixtures::config(ProductionTakeover::First)
        )
        .await
        .is_err());
    assert!(initial
        .store()
        .authorize_session_metadata(initial.binding())
        .await
        .is_err());
    assert!(initial
        .store()
        .claim_next(
            &owner,
            &conversation,
            &initial.binding().session_id,
            std::time::Duration::from_secs(30)
        )
        .await
        .is_err());
    assert_eq!(initial.binding().state, SessionState::Starting);
    assert_eq!(initial.binding().provider_kind, ProviderKind::Unconfigured);
    assert!(initial.binding().native_session_id.is_none());
    let input = store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "fresh-owner-input".into(),
                text: "synthetic first input".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let admission = store
        .admit_execution_window_authenticated(
            &browser,
            &conversation,
            &ExecutionWindowRequest {
                request_key: "first-owner-window".into(),
                input_message_id: input.message_id,
                input_event_id: input.event_id,
                input_request_key: "fresh-owner-input".into(),
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
            admission.status.window_id,
            1,
            "first-owner-boot",
            admission.status.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    let bound = initial
        .store()
        .bind_execution_window(initial.credential(), &grant)
        .await
        .unwrap();
    bound
        .authorize_session_metadata(initial.binding())
        .await
        .unwrap();
    for table in ["production_readiness", "production_runs"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
    assert!(store
        .bootstrap_execution_window_authenticated(
            &browser,
            &conversation,
            fixtures::config(ProductionTakeover::First)
        )
        .await
        .is_err());
}
#[tokio::test]
async fn bootstrap_current_auth_foreign_scope_and_history_refuse_without_writes() {
    let (store, owner, conversation, browser) = fresh().await;
    assert!(store
        .bootstrap_execution_window_authenticated(
            "revoked-or-unknown",
            &conversation,
            fixtures::config(ProductionTakeover::First)
        )
        .await
        .is_err());
    let (_foreign_store, _, _, foreign_browser) = fresh().await;
    assert!(store
        .bootstrap_execution_window_authenticated(
            &foreign_browser,
            &conversation,
            fixtures::config(ProductionTakeover::First)
        )
        .await
        .is_err());
    let foreign_conversation = ConversationId(Uuid::new_v4());
    assert!(store
        .bootstrap_execution_window_authenticated(
            &browser,
            &foreign_conversation,
            fixtures::config(ProductionTakeover::First)
        )
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM production_supervisors")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    store
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap();
    assert!(store
        .bootstrap_execution_window_authenticated(
            &browser,
            &conversation,
            fixtures::config(ProductionTakeover::First)
        )
        .await
        .is_err());
    let (store, _, conversation, browser) = fresh().await;
    store.revoke_session(&browser).await.unwrap();
    assert!(store
        .bootstrap_execution_window_authenticated(
            &browser,
            &conversation,
            fixtures::config(ProductionTakeover::First)
        )
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM production_supervisors")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
