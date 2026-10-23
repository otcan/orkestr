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
async fn failed_first_claude_open_uses_claude_rebootstrap_without_provider_fallback() {
    use orkestr_v2_contracts::{
        ExecutionWindowReconciliationActor as Actor,
        ExecutionWindowReconciliationDecision as Decision,
    };
    let (store, owner, conversation, browser) = fresh().await;
    let mut config = fixtures::config(ProductionTakeover::First);
    config.provider = ProviderKind::Claude;
    let initial = store
        .bootstrap_execution_window_authenticated(&browser, &conversation, config)
        .await
        .unwrap();
    let input = store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "first-claude-failed-setup".into(),
                text: "synthetic input".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let mut req = ExecutionWindowRequest {
        request_key: "window:first-claude-failed-setup".into(),
        input_message_id: input.message_id,
        input_event_id: input.event_id,
        input_request_key: "first-claude-failed-setup".into(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    };
    let a = store
        .admit_execution_window_authenticated(&browser, &conversation, &req)
        .await
        .unwrap();
    let grant = initial
        .store()
        .issue_execution_window_credential(
            initial.credential(),
            a.status.window_id,
            1,
            "failed-claude-setup-boot",
            a.status.expires_at_ms,
            &"b".repeat(64),
        )
        .await
        .unwrap();
    initial
        .store()
        .bind_execution_window(initial.credential(), &grant)
        .await
        .unwrap();
    store
        .reconcile_execution_window_authenticated(&browser, &conversation, a.status.window_id, 1)
        .await
        .unwrap();
    let StrandedExecutionWindow::Pending(plan) = store
        .plan_stranded_execution_window_authenticated(
            &browser,
            &conversation,
            a.status.window_id,
            1,
            Decision::AbandonUnaccepted,
            Actor::Owner,
        )
        .await
        .unwrap()
    else {
        panic!("expected failed-open plan")
    };
    store
        .reconcile_stranded_execution_window_authenticated(
            &browser,
            &plan,
            Decision::AbandonUnaccepted,
            Actor::Owner,
        )
        .await
        .unwrap();
    let mut config = fixtures::config(ProductionTakeover::First);
    config.provider = ProviderKind::Claude;
    let reset = store
        .rebootstrap_execution_window_authenticated(&browser, &conversation, config)
        .await
        .unwrap();
    req.expected_generation = 1;
    req.predecessor_window_id = Some(a.status.window_id);
    req.request_key = "window:retry-claude-setup".into();
    let a = store
        .admit_execution_window_authenticated(&browser, &conversation, &req)
        .await
        .unwrap();
    let grant = reset
        .store()
        .issue_execution_window_credential(
            reset.credential(),
            a.status.window_id,
            2,
            "new-claude-setup-boot",
            a.status.expires_at_ms,
            &"c".repeat(64),
        )
        .await
        .unwrap();
    reset
        .store()
        .bind_execution_window(reset.credential(), &grant)
        .await
        .unwrap();
    let providers: Vec<String> =
        sqlx::query_scalar("SELECT provider_kind FROM production_supervisors")
            .fetch_all(&store.pool)
            .await
            .unwrap();
    assert_eq!(providers, vec!["claude"]);
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

#[tokio::test]
async fn another_native_conversation_requires_its_own_retirement_and_distinct_context() {
    use orkestr_v2_contracts::ConversationInput;
    let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("native-conversation-retired-{}", Uuid::new_v4()));
    super::retired_process_tests::seed_closed(root.clone(), false).await;
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let browser = "synthetic-browser-window";
    let (new, _) = store
        .create_conversation_authenticated(
            browser,
            &ConversationInput {
                client_request_id: "native-second-thread".into(),
                name: "Rust workbench".into(),
            },
        )
        .await
        .unwrap();
    let existing: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT context_id,incarnation_id,generation FROM production_supervisors")
            .fetch_all(&store.pool)
            .await
            .unwrap();
    let prior_config = fixtures::config(ProductionTakeover::First);
    assert!(store
        .bootstrap_execution_window_authenticated(browser, &new.conversation_id, prior_config)
        .await
        .is_err());
    let mut config = fixtures::config(ProductionTakeover::First);
    config.namespace = "native-second-context".into();
    config.supervisor_key = "native-second-supervisor".into();
    let initial = store
        .bootstrap_execution_window_authenticated(browser, &new.conversation_id, config)
        .await
        .unwrap();
    assert_eq!(initial.binding().conversation_id, new.conversation_id);
    assert!(initial.binding().native_session_id.is_none());
    for (context, incarnation, generation) in existing {
        let same: (String, i64) = sqlx::query_as(
            "SELECT incarnation_id,generation FROM production_supervisors WHERE context_id=?",
        )
        .bind(context)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(same, (incarnation, generation));
    }
    let (third, _) = store
        .create_conversation_authenticated(
            browser,
            &ConversationInput {
                client_request_id: "native-third-thread".into(),
                name: "Another thread".into(),
            },
        )
        .await
        .unwrap();
    let mut config = fixtures::config(ProductionTakeover::First);
    config.namespace = "native-third-context".into();
    config.supervisor_key = "native-third-supervisor".into();
    // Another conversation's issued-but-unused private context neither blocks
    // an independent conversation nor is discarded, replaced or reissued.
    let third_initial = store
        .bootstrap_execution_window_authenticated(browser, &third.conversation_id, config)
        .await
        .unwrap();
    assert_eq!(
        third_initial.binding().conversation_id,
        third.conversation_id
    );
    let mut second = fixtures::config(ProductionTakeover::First);
    second.namespace = "native-second-context".into();
    second.supervisor_key = "native-second-supervisor".into();
    assert!(store
        .bootstrap_execution_window_authenticated(browser, &new.conversation_id, second)
        .await
        .is_err());
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM production_supervisors WHERE namespace='native-second-context'",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(live, 1);
    let windows: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_windows")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(windows, 1);
}

#[tokio::test]
async fn an_unfinished_window_blocks_other_conversation_admission_without_new_rows() {
    use orkestr_v2_contracts::ConversationInput;
    let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("native-conversation-active-{}", Uuid::new_v4()));
    super::retired_process_tests::seed_closed(root.clone(), true).await;
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let browser = "synthetic-browser-window";
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let (new, _) = store
        .create_conversation_authenticated(
            browser,
            &ConversationInput {
                client_request_id: "native-blocked-thread".into(),
                name: "Unstarted thread".into(),
            },
        )
        .await
        .unwrap();
    let intake = store
        .admit(
            &owner,
            &new.conversation_id,
            &MessageInput {
                client_message_id: "queued-in-other-thread".into(),
                text: "synthetic input".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let result = store
        .admit_execution_window_authenticated(
            browser,
            &new.conversation_id,
            &ExecutionWindowRequest {
                request_key: "other-window".into(),
                input_message_id: intake.message_id,
                input_event_id: intake.event_id,
                input_request_key: "queued-in-other-thread".into(),
                expected_generation: 0,
                window_id: None,
                predecessor_window_id: None,
            },
        )
        .await;
    assert!(matches!(result, Err(RuntimeStoreError::Busy)));
    assert!(store
        .execution_window_status_authenticated(browser, &new.conversation_id)
        .await
        .unwrap()
        .is_none());
}
