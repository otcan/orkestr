//! Synthetic Core proof; no native/provider process or real owner data.
use super::*;
use crate::OperatorProviderPolicy;

async fn ready() -> (
    Pending,
    Store,
    ExecutionWindowRequest,
    OperatorProviderPolicy,
    ProviderHandoffRequest,
) {
    let p = pending().await;
    let w = &p.w;
    let store = restart(w, true).await;
    reconcile(&store, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    retire_old(&store, w).await;
    super::native_reset_tests::select_claude(&store, w).await;
    let current = input(&w.f, "synthetic-policy-new-input").await;
    let proof = OperatorProviderPolicy {
        source_message_id: current.input_message_id.clone(),
        policy_sha256: "b".repeat(64),
        source_commit: "c".repeat(40),
        rule_ids: vec!["synthetic-category".into()],
    };
    let mut request = request(w);
    request.target_provider = ConversationProvider::Codex;
    request.expected_settings_revision = 1;
    request.model = Some("gpt-6.1-sol".into());
    (p, store, current, proof, request)
}

#[tokio::test]
async fn operator_policy_handoff_keeps_exact_new_input_queued_and_attests_separate_actor() {
    let (p, store, current, proof, request) = ready().await;
    let w = &p.w;
    assert!(
        store
            .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &request)
            .await
            .is_err(),
        "ordinary owner handoff must still reject queued input"
    );
    let receipt = store
        .handoff_provider_for_operator_policy(
            &w.browser_credential,
            &w.f.conversation,
            &request,
            &proof,
        )
        .await
        .unwrap();
    assert_eq!(receipt.to_provider, ConversationProvider::Codex);
    assert_eq!(
        store
            .handoff_provider_for_operator_policy(
                &w.browser_credential,
                &w.f.conversation,
                &request,
                &proof
            )
            .await
            .unwrap(),
        receipt
    );
    let state: (String, Option<String>) =
        sqlx::query_as("SELECT state,admitted_run_id FROM reasoning_inbox WHERE message_id=?")
            .bind(current.input_message_id.to_string())
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(state, ("queued".into(), None));
    let attestation:(String,String,String)=sqlx::query_as("SELECT source_message_id,policy_sha256,source_commit FROM operator_provider_handoffs WHERE handoff_id=?")
        .bind(receipt.handoff_id.to_string()).fetch_one(&store.pool).await.unwrap();
    assert_eq!(
        attestation,
        (
            current.input_message_id.to_string(),
            proof.policy_sha256.clone(),
            proof.source_commit.clone()
        )
    );
    assert_eq!(
        store
            .conversation_provider_policy_rules(&w.f.owner, &w.f.conversation)
            .await
            .unwrap(),
        proof.rule_ids
    );
    assert!(sqlx::query("DELETE FROM operator_provider_handoffs")
        .execute(&store.pool)
        .await
        .is_err());
    assert!(
        sqlx::query("DELETE FROM conversation_provider_policy_matches")
            .execute(&store.pool)
            .await
            .is_err()
    );
    let settings = store
        .conversation_settings(&w.browser_credential, &w.f.owner, &w.f.conversation)
        .await
        .unwrap();
    assert_eq!(settings.provider_generation, 2);
    let old: String = sqlx::query_scalar("SELECT state FROM reasoning_inbox WHERE message_id=?")
        .bind(w.old.input_message_id.to_string())
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(old, "retired");
}

#[tokio::test]
async fn operator_policy_handoff_refuses_unknown_source_other_pending_work_and_retired_input() {
    let (p, store, _current, mut proof, request) = ready().await;
    let w = &p.w;
    proof.source_commit = "unknown".into();
    assert!(store
        .handoff_provider_for_operator_policy(
            &w.browser_credential,
            &w.f.conversation,
            &request,
            &proof
        )
        .await
        .is_err());
    proof.source_commit = "c".repeat(40);
    proof.source_message_id = w.old.input_message_id.clone();
    assert!(store
        .handoff_provider_for_operator_policy(
            &w.browser_credential,
            &w.f.conversation,
            &request,
            &proof
        )
        .await
        .is_err());
    let another = input(&w.f, "synthetic-other-pending").await;
    proof.source_message_id = another.input_message_id;
    assert!(store
        .handoff_provider_for_operator_policy(
            &w.browser_credential,
            &w.f.conversation,
            &request,
            &proof
        )
        .await
        .is_err());
    assert_eq!(
        count(
            &store,
            "SELECT count(*) FROM conversation_provider_handoffs"
        )
        .await,
        0
    );
    let before = store
        .conversation_settings(&w.browser_credential, &w.f.owner, &w.f.conversation)
        .await
        .unwrap();
    assert_eq!(before.provider, ConversationProvider::Claude);
}

#[tokio::test]
async fn operator_policy_receipt_proof_drift_and_foreign_auth_never_replay_or_refresh() {
    let (p, store, _current, mut proof, request) = ready().await;
    let w = &p.w;
    assert!(store
        .handoff_provider_for_operator_policy(
            "foreign-browser",
            &w.f.conversation,
            &request,
            &proof
        )
        .await
        .is_err());
    let receipt = store
        .handoff_provider_for_operator_policy(
            &w.browser_credential,
            &w.f.conversation,
            &request,
            &proof,
        )
        .await
        .unwrap();
    proof.source_commit = "d".repeat(40);
    assert!(store
        .handoff_provider_for_operator_policy(
            &w.browser_credential,
            &w.f.conversation,
            &request,
            &proof
        )
        .await
        .is_err());
    assert_eq!(
        count(&store, "SELECT count(*) FROM operator_provider_handoffs").await,
        1
    );
    let again = store
        .provider_handoff_receipt_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            &request.request_key,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(again, receipt);
}
