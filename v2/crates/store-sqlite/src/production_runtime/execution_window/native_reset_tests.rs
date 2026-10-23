//! Generic owner reset: preserve old evidence and require a separately admitted input.
use super::*;
use orkestr_v2_contracts::{
    ClaudeNativeResetRequest, ConversationProvider, ConversationSettingsUpdate,
};

fn request(w: &Window) -> ClaudeNativeResetRequest {
    ClaudeNativeResetRequest {
        request_key: "owner-fresh-claude".into(),
        window_id: w.status.window_id,
        generation: 1,
        acknowledge_native_history_loss: true,
    }
}

/// Use the existing fully retired role fixture, then select the native kind.
/// No provider output or success is fabricated by the production reset path.
async fn select_claude(store: &Store, w: &Window) {
    let sessions: Vec<String> =
        sqlx::query_scalar("SELECT id FROM session_bindings WHERE native_session_id IS NOT NULL")
            .fetch_all(&store.pool)
            .await
            .unwrap();
    for session in sessions {
        let native = Uuid::new_v4().to_string();
        sqlx::query("UPDATE session_bindings SET native_session_id=? WHERE id=?")
            .bind(&native)
            .bind(&session)
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE production_runs SET native_session_id=? WHERE session_id=?")
            .bind(native)
            .bind(session)
            .execute(&store.pool)
            .await
            .unwrap();
    }
    sqlx::query("UPDATE production_supervisors SET provider_kind='claude'")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE session_bindings SET provider_kind='claude' WHERE provider_kind='codex'")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE production_runs SET provider_kind='claude'")
        .execute(&store.pool)
        .await
        .unwrap();
    store
        .update_conversation_settings(
            &w.browser_credential,
            &w.f.owner,
            &w.f.conversation,
            &ConversationSettingsUpdate {
                expected_revision: 0,
                provider: ConversationProvider::Claude,
                model: Some("opus".into()),
                reasoning_effort: Some("high".into()),
                honor_no_reply: true,
                reply_prefix: None,
                reply_footer: None,
                review_before_accepting: false,
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn native_reset_retains_history_and_requires_new_bootstrap_and_input() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    select_claude(&fresh, w).await;
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT id,text FROM messages ORDER BY id")
        .fetch_all(&fresh.pool)
        .await
        .unwrap();
    let runs: Vec<(String, String)> =
        sqlx::query_as("SELECT id,state FROM production_runs ORDER BY id")
            .fetch_all(&fresh.pool)
            .await
            .unwrap();
    let request = request(w);
    let receipt = fresh
        .reset_claude_native_authenticated(&w.browser_credential, &w.f.conversation, &request)
        .await
        .unwrap();
    assert_eq!(receipt.window_id, w.status.window_id);
    assert_eq!(
        fresh
            .reset_claude_native_authenticated(&w.browser_credential, &w.f.conversation, &request)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        rows,
        sqlx::query_as::<_, (String, String)>("SELECT id,text FROM messages ORDER BY id")
            .fetch_all(&fresh.pool)
            .await
            .unwrap()
    );
    assert_eq!(
        runs,
        sqlx::query_as::<_, (String, String)>("SELECT id,state FROM production_runs ORDER BY id")
            .fetch_all(&fresh.pool)
            .await
            .unwrap()
    );
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM session_bindings WHERE state!='retired'"
        )
        .await,
        0
    );
    assert!(fresh
        .execution_window_failed_first_open_authenticated(&w.browser_credential, &w.f.conversation)
        .await
        .unwrap());
    let mut config = fixtures::config(ProductionTakeover::First);
    config.provider = ProviderKind::Claude;
    let initial = fresh
        .rebootstrap_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            config,
        )
        .await
        .unwrap();
    assert_eq!(initial.binding().provider_kind, ProviderKind::Unconfigured);
    assert!(initial.binding().native_session_id.is_none());
    assert_ne!(initial.binding().session_id, p.deep.binding.session_id);
    let mut next = input(&w.f, "new-owner-input-after-reset").await;
    next.expected_generation = 1;
    next.predecessor_window_id = Some(w.status.window_id);
    let admitted = fresh
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &next)
        .await
        .unwrap();
    let grant = initial
        .store()
        .issue_execution_window_credential(
            initial.credential(),
            admitted.status.window_id,
            2,
            "fresh-reset-boot",
            admitted.status.expires_at_ms,
            &"e".repeat(64),
        )
        .await
        .unwrap();
    let bound = initial
        .store()
        .bind_execution_window(initial.credential(), &grant)
        .await
        .unwrap();
    // Setup is still required: reset itself grants no ready native or inference.
    bound
        .authorize_session_metadata(initial.binding())
        .await
        .unwrap();
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM production_runs").await,
        runs.len() as i64
    );
}

#[tokio::test]
async fn native_reset_refuses_live_unaccepted_wrong_owner_and_changed_intent_without_writes() {
    let p = pending().await;
    let w = &p.w;
    let req = request(w);
    let fresh = Store::open(&w.f.root.join("core.sqlite3")).await.unwrap();
    select_claude(&fresh, w).await;
    let before = fixtures::snapshot(&fresh).await;
    assert!(fresh
        .reset_claude_native_authenticated(&w.browser_credential, &w.f.conversation, &req)
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&fresh).await);
    let fresh = restart(w, true).await;
    // Pending proposals cannot be bypassed by the explicit continuity-loss ACK.
    assert!(fresh
        .reset_claude_native_authenticated(&w.browser_credential, &w.f.conversation, &req)
        .await
        .is_err());
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    let before = fixtures::snapshot(&fresh).await;
    let mut unacknowledged = req.clone();
    unacknowledged.acknowledge_native_history_loss = false;
    let mut invalid_key = req.clone();
    invalid_key.request_key = "invalid key".into();
    let mut foreign_window = req.clone();
    foreign_window.window_id = Uuid::new_v4();
    for bad in [unacknowledged, invalid_key, foreign_window] {
        assert!(fresh
            .reset_claude_native_authenticated(&w.browser_credential, &w.f.conversation, &bad)
            .await
            .is_err());
    }
    assert!(fresh
        .reset_claude_native_authenticated("foreign-owner", &w.f.conversation, &req)
        .await
        .is_err());
    let mut stale = req.clone();
    stale.generation = 2;
    assert!(fresh
        .reset_claude_native_authenticated(&w.browser_credential, &w.f.conversation, &stale)
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&fresh).await);
    fresh
        .reset_claude_native_authenticated(&w.browser_credential, &w.f.conversation, &req)
        .await
        .unwrap();
    let mut changed = req.clone();
    changed.generation = 2;
    assert!(fresh
        .reset_claude_native_authenticated(&w.browser_credential, &w.f.conversation, &changed)
        .await
        .is_err());
    let mut second = req.clone();
    second.request_key = "different-reset-same-window".into();
    assert!(fresh
        .reset_claude_native_authenticated(&w.browser_credential, &w.f.conversation, &second)
        .await
        .is_err());
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM conversation_native_resets").await,
        1
    );
}

#[tokio::test]
async fn native_reset_never_selects_claude_for_a_codex_conversation() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    let before = fixtures::snapshot(&fresh).await;
    assert!(fresh
        .reset_claude_native_authenticated(&w.browser_credential, &w.f.conversation, &request(w))
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&fresh).await);
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM conversation_native_resets").await,
        0
    );
}

#[tokio::test]
async fn native_reset_failed_claude_resume_archives_unobserved_setup_before_restoring_lineage() {
    use crate::ClaudeProcessInitialization;
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    select_claude(&fresh, w).await;
    let mut config = fixtures::config(ProductionTakeover::First);
    config.provider = ProviderKind::Claude;
    let retired = fresh
        .recover_retired_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            config,
        )
        .await
        .unwrap();
    let mut source = input(&w.f, "failed-claude-resume").await;
    source.expected_generation = 1;
    source.predecessor_window_id = Some(w.status.window_id);
    let next = fresh
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &source)
        .await
        .unwrap();
    let grant = retired
        .store()
        .issue_idle_execution_window_credential_authenticated(
            &w.browser_credential,
            next.status.window_id,
            2,
            "failed-resume-boot",
            next.status.expires_at_ms,
            &"d".repeat(64),
        )
        .await
        .unwrap();
    let mut config = fixtures::config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: retired.predecessor_incarnation().into(),
    });
    config.provider = ProviderKind::Claude;
    let (bound, _) = fresh
        .reattach_terminal_supervisor(grant.credential(), config, &p.deep.run.run_id)
        .await
        .unwrap();
    let fast = bound
        .ensure_role_bindings(&w.f.owner, &w.f.conversation)
        .await
        .unwrap()
        .fast;
    let metadata = bound
        .authorize_window_fast_metadata(grant.credential(), &fast)
        .await
        .unwrap();
    bound
        .initialize_claude_session(
            metadata,
            ClaudeProcessInitialization {
                requested_native_session_id: fast.native_session_id.clone().unwrap(),
                protocol_version: "claude-control-v1".into(),
                source_event_key: "failed-resume-setup".into(),
            },
        )
        .await
        .unwrap();
    // Deep setup fails here; no input was ever consumed in this incarnation.
    fresh
        .reconcile_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            next.status.window_id,
            2,
        )
        .await
        .unwrap();
    let StrandedExecutionWindow::Pending(plan) = fresh
        .plan_stranded_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            next.status.window_id,
            2,
            Decision::AbandonUnaccepted,
            Actor::Owner,
        )
        .await
        .unwrap()
    else {
        panic!("expected failed-open plan")
    };
    fresh
        .reconcile_stranded_execution_window_authenticated(
            &w.browser_credential,
            &plan,
            Decision::AbandonUnaccepted,
            Actor::Owner,
        )
        .await
        .unwrap();
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM execution_window_failed_native_requests"
        )
        .await,
        1
    );
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM production_requested_native").await,
        0
    );
    assert_eq!(window_state(&fresh, next.status.window_id).await, "closed");
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM production_runs").await,
        2
    );
    fresh
        .reset_claude_native_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            &ClaudeNativeResetRequest {
                request_key: "reset-after-failed-resume".into(),
                window_id: next.status.window_id,
                generation: 2,
                acknowledge_native_history_loss: true,
            },
        )
        .await
        .unwrap();
}
