//! A binding without a native session (a role that was never configured, such
//! as a Claude chat's `unconfigured` Fast in `starting`, or a setup that never
//! confirmed a native id) has no process and no transcript to protect: it
//! fences neither a native reset nor a provider handoff. A binding with a
//! native session fences both exactly as before.
use super::*;
use orkestr_v2_contracts::{
    ClaudeNativeResetRequest, ConversationProvider, ProviderHandoffRequest,
};

/// Replace the conversation's Fast binding with one that never got a native
/// session, in `state`.
async fn unconfigured_fast(store: &Store, w: &Window, state: &str) {
    sqlx::query(
        "UPDATE session_bindings SET state='retired' WHERE role='fast' AND state!='retired'",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO session_bindings(id,owner_id,conversation_id,role,state) VALUES(?,?,?,'fast',?)")
        .bind(Uuid::new_v4().to_string())
        .bind(w.f.owner.to_string())
        .bind(w.f.conversation.to_string())
        .bind(state)
        .execute(&store.pool)
        .await
        .unwrap();
}

/// Put the conversation's Fast binding that has a native session in `state`.
async fn native_fast(store: &Store, state: &str) {
    let changed = sqlx::query(
        "UPDATE session_bindings SET state=? WHERE role='fast' AND native_session_id IS NOT NULL",
    )
    .bind(state)
    .execute(&store.pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(changed, 1, "the fixture has one native Fast binding");
}

fn reset(w: &Window) -> ClaudeNativeResetRequest {
    ClaudeNativeResetRequest {
        request_key: "reset-beside-unconfigured-fast".into(),
        window_id: w.status.window_id,
        generation: 1,
        acknowledge_native_history_loss: true,
    }
}

fn handoff(w: &Window) -> ProviderHandoffRequest {
    ProviderHandoffRequest {
        request_key: "synthetic:handoff-beside-unconfigured-fast".into(),
        window_id: w.status.window_id,
        generation: w.status.generation,
        expected_settings_revision: 0,
        target_provider: ConversationProvider::Claude,
        model: Some("opus".into()),
        reasoning_effort: Some("high".into()),
        acknowledge_new_native_session: true,
        history_summary: "Synthetic prior decisions; no actions to replay.".into(),
    }
}

/// The window closed and its proposals abandoned: what a reset or handoff
/// needs, apart from the binding fence under test.
async fn closed(w: &Window) -> Store {
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    fresh
}

#[tokio::test]
async fn a_never_configured_fast_binding_does_not_fence_a_claude_native_reset() {
    let p = pending().await;
    let w = &p.w;
    let fresh = closed(w).await;
    super::native_reset_tests::select_claude(&fresh, w).await;
    unconfigured_fast(&fresh, w, "starting").await;
    fresh
        .reset_claude_native_authenticated(&w.browser_credential, &w.f.conversation, &reset(w))
        .await
        .unwrap();
    // The reset retired it with every other role binding.
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM session_bindings WHERE state!='retired'"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn a_busy_binding_with_a_native_session_still_fences_the_native_reset() {
    let p = pending().await;
    let w = &p.w;
    let fresh = closed(w).await;
    super::native_reset_tests::select_claude(&fresh, w).await;
    native_fast(&fresh, "busy").await;
    assert!(fresh
        .reset_claude_native_authenticated(&w.browser_credential, &w.f.conversation, &reset(w))
        .await
        .is_err());
    assert_eq!(
        count(&fresh, "SELECT count(*) FROM conversation_native_resets").await,
        0
    );
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
async fn a_lost_binding_without_a_native_session_does_not_fence_a_provider_handoff() {
    let p = pending().await;
    let w = &p.w;
    let fresh = closed(w).await;
    retire_old(&fresh, w).await;
    unconfigured_fast(&fresh, w, "lost").await;
    fresh
        .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &handoff(w))
        .await
        .unwrap();
}

#[tokio::test]
async fn a_busy_lost_or_blocked_binding_with_a_native_session_still_fences_a_handoff() {
    for state in ["busy", "lost", "blocked"] {
        let p = pending().await;
        let w = &p.w;
        let fresh = closed(w).await;
        retire_old(&fresh, w).await;
        native_fast(&fresh, state).await;
        let refused = fresh
            .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &handoff(w))
            .await;
        assert!(refused.is_err(), "{state}");
        assert_eq!(
            count(
                &fresh,
                "SELECT count(*) FROM conversation_provider_handoffs"
            )
            .await,
            0
        );
    }
}
