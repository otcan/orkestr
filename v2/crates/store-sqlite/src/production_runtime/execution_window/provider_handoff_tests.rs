//! Isolated native-lineage fixtures; no provider process or external transport.
use super::*;
use orkestr_v2_contracts::{ConversationProvider, ProviderHandoffRequest};
#[path = "provider_handoff_policy_tests.rs"]
mod policy_tests;

fn request(w: &Window) -> ProviderHandoffRequest {
    ProviderHandoffRequest {
        request_key: "synthetic:provider-handoff".into(),
        window_id: w.status.window_id,
        generation: w.status.generation,
        expected_settings_revision: 0,
        target_provider: ConversationProvider::Claude,
        model: Some("opus".into()),
        reasoning_effort: Some("high".into()),
        acknowledge_new_native_session: true,
        history_summary:
            "Synthetic prior decisions. Historical context only; no actions to replay.".into(),
    }
}

async fn retire_old(store: &Store, w: &Window) {
    store
        .retire_owner_input_for_browser(
            &w.browser_credential,
            &w.f.conversation,
            &w.old.input_message_id,
            &orkestr_v2_contracts::OwnerInputRetirementRequest {
                request_key: "synthetic:retire-old-input".into(),
                reason: "Synthetic old input must never replay".into(),
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn provider_handoff_database_failure_rolls_back_settings_and_binding_retirement() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    retire_old(&fresh, w).await;
    let before = fixtures::snapshot(&fresh).await;
    sqlx::query("CREATE TRIGGER synthetic_handoff_fail BEFORE INSERT ON conversation_provider_handoffs BEGIN SELECT RAISE(ABORT,'synthetic_handoff_failure'); END")
        .execute(&fresh.pool).await.unwrap();
    assert!(fresh
        .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &request(w))
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&fresh).await);
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM conversation_settings").await,
        0
    );
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM conversation_provider_handoffs"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn provider_handoff_concurrent_decisions_commit_one_and_settings_cannot_bypass_history() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    retire_old(&fresh, w).await;
    let update = orkestr_v2_contracts::ConversationSettingsUpdate {
        expected_revision: 0,
        provider: ConversationProvider::Claude,
        model: Some("opus".into()),
        reasoning_effort: Some("high".into()),
        honor_no_reply: true,
        reply_prefix: None,
        reply_footer: None,
        review_before_accepting: false,
    };
    assert!(matches!(
        fresh
            .update_conversation_settings(
                &w.browser_credential,
                &w.f.owner,
                &w.f.conversation,
                &update
            )
            .await,
        Err(crate::conversation_resources::ResourceError::Conflict(
            "provider_handoff_required"
        ))
    ));
    let first = request(w);
    let mut second = first.clone();
    second.request_key.push_str(":other");
    let (a, b) = tokio::join!(
        fresh.handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &first),
        fresh.handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &second)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM conversation_provider_handoffs"
        )
        .await,
        1
    );
    assert!(sqlx::query("DELETE FROM conversation_provider_handoffs")
        .execute(&fresh.pool)
        .await
        .is_err());
}

#[tokio::test]
async fn provider_handoff_is_atomic_idempotent_and_creates_only_fresh_unconfigured_bindings() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    retire_old(&fresh, w).await;
    let messages: Vec<(String, String)> =
        sqlx::query_as("SELECT id,text FROM messages ORDER BY id")
            .fetch_all(&fresh.pool)
            .await
            .unwrap();
    let runs = count(&fresh, "SELECT count(*) FROM production_runs").await;
    let req = request(w);
    let receipt = fresh
        .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &req)
        .await
        .unwrap();
    assert_eq!(receipt.from_provider, ConversationProvider::Codex);
    assert_eq!(receipt.to_provider, ConversationProvider::Claude);
    assert_eq!(receipt.settings_revision, 1);
    assert_eq!(
        fresh
            .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &req)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        fresh
            .provider_handoff_receipt_authenticated(
                &w.browser_credential,
                &w.f.conversation,
                &req.request_key
            )
            .await
            .unwrap(),
        Some(receipt)
    );
    let mut changed = req.clone();
    changed.history_summary.push_str("Changed");
    assert!(fresh
        .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &changed)
        .await
        .is_err());
    assert_eq!(
        runs,
        count(&fresh, "SELECT count(*) FROM production_runs").await
    );
    assert_eq!(
        messages,
        sqlx::query_as::<_, (String, String)>("SELECT id,text FROM messages ORDER BY id")
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
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM conversation_handoff_sessions").await,
        2
    );
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM conversation_handoff_context_delivery"
        )
        .await,
        0
    );
    assert_eq!(
        runs,
        count(&fresh, "SELECT count(*) FROM production_runs").await
    );
}

#[tokio::test]
async fn provider_handoff_refuses_active_stale_foreign_and_queued_input() {
    let p = pending().await;
    let w = &p.w;
    let req = request(w);
    assert!(w
        .f
        .store
        .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &req)
        .await
        .is_err());
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    retire_old(&fresh, w).await;
    for variant in 0..5 {
        let mut altered = req.clone();
        match variant {
            0 => altered.generation += 1,
            1 => altered.expected_settings_revision += 1,
            2 => altered.acknowledge_new_native_session = false,
            3 => altered.model = Some("fable".into()),
            _ => altered.window_id = Uuid::new_v4(),
        }
        assert!(fresh
            .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &altered)
            .await
            .is_err());
    }
    assert!(fresh
        .handoff_provider_authenticated("foreign-browser", &w.f.conversation, &req)
        .await
        .is_err());
    assert!(
        matches!(
            fresh
                .handoff_provider_authenticated(&w.f.token, &w.f.conversation, &req)
                .await,
            Err(RuntimeStoreError::Unauthorized)
        ),
        "a machine credential of the same owner is not a browser decision"
    );
    let _queued = input(&w.f, "synthetic-new-queued-input").await;
    assert!(fresh
        .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &req)
        .await
        .is_err());
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM conversation_provider_handoffs"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn provider_handoff_context_reaches_each_fresh_role_once_and_never_replays_an_old_input() {
    let p = pending().await;
    let old = &p.w;
    let fresh = restart(old, true).await;
    reconcile(&fresh, old, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    retire_old(&fresh, old).await;
    super::native_reset_tests::select_claude(&fresh, old).await;
    let mut req = request(old);
    req.target_provider = ConversationProvider::Codex;
    req.expected_settings_revision = 1;
    req.model = Some("gpt-6.1-sol".into());
    fresh
        .handoff_provider_authenticated(&old.browser_credential, &old.f.conversation, &req)
        .await
        .unwrap();
    let initial = fresh
        .rebootstrap_execution_window_authenticated(
            &old.browser_credential,
            &old.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    let mut next = input(&old.f, "synthetic-new-after-handoff").await;
    next.expected_generation = old.status.generation;
    next.predecessor_window_id = Some(old.status.window_id);
    let admitted = fresh
        .admit_execution_window_authenticated(&old.browser_credential, &old.f.conversation, &next)
        .await
        .unwrap();
    let grant = initial
        .store()
        .issue_execution_window_credential(
            initial.credential(),
            admitted.status.window_id,
            admitted.status.generation,
            "synthetic-handoff-boot",
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
    let mut roles = bound
        .ensure_role_bindings(&old.f.owner, &old.f.conversation)
        .await
        .unwrap();
    let metadata = bound.authorize_session_metadata(&roles.deep).await.unwrap();
    roles.deep = bound
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: roles.deep.session_id.clone(),
                expected_generation: roles.deep.generation,
                native_session_id: "synthetic-handoff-deep".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "synthetic-handoff-ready".into(),
            },
        )
        .await
        .unwrap()
        .binding()
        .clone();
    let f = fixtures::Case {
        store: fresh.clone(),
        handle: initial.store().clone(),
        root: old.f.root.clone(),
        owner: old.f.owner.clone(),
        conversation: old.f.conversation.clone(),
        token: initial.credential().into(),
    };
    let mut w = Window {
        f,
        browser_credential: old.browser_credential.clone(),
        bound,
        credential: grant,
        status: admitted.status,
        roles,
        old: old.old.clone(),
        source: next,
    };
    w.roles.fast = w.ready_fast().await;
    w.bound
        .activate_execution_window(
            w.credential.credential(),
            w.status.window_id,
            w.status.generation,
            "synthetic-handoff-boot",
        )
        .await
        .unwrap();
    let claim = w
        .bound
        .claim_next(
            &w.f.owner,
            &w.f.conversation,
            &w.roles.deep.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.message_id, w.source.input_message_id);
    let admission = w
        .bound
        .admit_run(
            &claim,
            &w.roles.deep.session_id,
            w.roles.deep.generation,
            "synthetic-handoff-deep-turn",
        )
        .await
        .unwrap();
    let deep = w.consume(&admission).await;
    assert!(deep.text().contains(&req.history_summary));
    assert!(deep.text().contains("Current input:"));
    let fast = w
        .bound
        .admit_fast(
            w.credential.credential(),
            &FastAdmissionInput {
                source_message_id: w.source.input_message_id.clone(),
                source_event_id: w.source.input_event_id.clone(),
                fast_binding_id: w.roles.fast.session_id.clone(),
                expected_binding_generation: w.roles.fast.generation,
                request_key: "synthetic-handoff-fast-turn".into(),
            },
        )
        .await
        .unwrap();
    let fast = w.consume(&fast).await;
    assert!(fast.text().contains(&req.history_summary));
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM conversation_handoff_context_delivery"
        )
        .await,
        2
    );
    // The exact first envelopes and once markers survive a Store restart.
    let reopened = Store::open(&old.f.root.join("core.sqlite3")).await.unwrap();
    let envelopes: Vec<String> = sqlx::query_scalar(
        "SELECT turn_text FROM conversation_handoff_context_delivery ORDER BY session_id",
    )
    .fetch_all(&reopened.pool)
    .await
    .unwrap();
    assert_eq!(envelopes.len(), 2);
    assert!(envelopes.iter().any(|text| text == deep.text()));
    assert!(envelopes.iter().any(|text| text == fast.text()));
    let mut tx = reopened.pool.begin().await.unwrap();
    let later = crate::production_runtime::execution_window::handoff_context::attach(
        &mut tx,
        deep.provider(),
        "Second new input".into(),
    )
    .await
    .unwrap();
    assert_eq!(later, "Second new input");
    tx.commit().await.unwrap();
    let old_state: String =
        sqlx::query_scalar("SELECT state FROM reasoning_inbox WHERE message_id=?")
            .bind(old.old.input_message_id.to_string())
            .fetch_one(&fresh.pool)
            .await
            .unwrap();
    assert_eq!(old_state, "retired");
}
