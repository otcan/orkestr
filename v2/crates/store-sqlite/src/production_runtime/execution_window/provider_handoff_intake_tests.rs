//! Deterministic two-ordering proof for the handoff/admission race.
use super::*;
use orkestr_v2_application::StoreError;
use orkestr_v2_contracts::{MessageInput, OwnerInputRetirementRequest};

fn continuation() -> MessageInput {
    MessageInput {
        client_message_id: "synthetic:guarded-continuation".into(),
        text: "Synthetic one-time continuation".into(),
    }
}

#[tokio::test]
async fn handoff_wins_then_guarded_continuation_rolls_back_every_intake_write() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    retire_old(&fresh, w).await;
    fresh
        .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &request(w))
        .await
        .unwrap();
    let before: i64 = sqlx::query_scalar("SELECT sequence FROM conversations WHERE id=?")
        .bind(w.f.conversation.to_string())
        .fetch_one(&fresh.pool)
        .await
        .unwrap();
    assert!(matches!(
        fresh
            .admit_with_provider_generation(
                &w.f.owner,
                &w.f.conversation,
                &continuation(),
                None,
                Some(0),
                None,
            )
            .await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    // Reopen to prove the failed transaction committed no sequence, message,
    // event, inbox or outbox row for this new key.
    let reopened = Store::open(&w.f.root.join("core.sqlite3")).await.unwrap();
    let after: i64 = sqlx::query_scalar("SELECT sequence FROM conversations WHERE id=?")
        .bind(w.f.conversation.to_string())
        .fetch_one(&reopened.pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        count(
            &reopened,
            "SELECT count(*) FROM messages WHERE request_key='synthetic:guarded-continuation'"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn continuation_wins_blocks_handoff_and_exact_retired_receipt_never_requeues() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    retire_old(&fresh, w).await;
    let input = continuation();
    let admitted = fresh
        .admit_with_provider_generation(
            &w.f.owner,
            &w.f.conversation,
            &input,
            None,
            Some(0),
            Some(&p.deep.run.run_id),
        )
        .await
        .unwrap();
    assert!(fresh
        .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &request(w))
        .await
        .is_err());
    fresh
        .retire_owner_input_for_browser(
            &w.browser_credential,
            &w.f.conversation,
            &admitted.receipt.message_id,
            &OwnerInputRetirementRequest {
                request_key: "synthetic:retire-continuation".into(),
                reason: "Synthetic negative disposition before handoff".into(),
            },
        )
        .await
        .unwrap();
    fresh
        .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &request(w))
        .await
        .unwrap();
    let replay = fresh
        .admit_with_provider_generation(
            &w.f.owner,
            &w.f.conversation,
            &input,
            None,
            Some(0),
            Some(&p.deep.run.run_id),
        )
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.receipt.message_id, admitted.receipt.message_id);
    let state: String = sqlx::query_scalar("SELECT state FROM reasoning_inbox WHERE message_id=?")
        .bind(replay.receipt.message_id.to_string())
        .fetch_one(&fresh.pool)
        .await
        .unwrap();
    assert_eq!(state, "retired");
}

#[tokio::test]
async fn current_generation_and_same_provider_never_revive_a_retired_source_session() {
    let p = pending().await;
    let w = &p.w;
    let fresh = restart(w, true).await;
    reconcile(&fresh, w, Decision::AbandonUnaccepted, Actor::Owner)
        .await
        .unwrap();
    retire_old(&fresh, w).await;
    fresh
        .handoff_provider_authenticated(&w.browser_credential, &w.f.conversation, &request(w))
        .await
        .unwrap();
    // Synthetic same-name later epoch: the immutable old source binding must
    // remain fenced even when the adapter freezes today's matching settings.
    sqlx::query("UPDATE conversation_settings SET provider='codex',provider_generation=2 WHERE conversation_id=?")
        .bind(w.f.conversation.to_string()).execute(&fresh.pool).await.unwrap();
    assert!(matches!(
        fresh
            .admit_with_provider_generation(
                &w.f.owner,
                &w.f.conversation,
                &continuation(),
                None,
                Some(2),
                Some(&p.deep.run.run_id)
            )
            .await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    assert_eq!(
        count(
            &fresh,
            "SELECT count(*) FROM messages WHERE request_key='synthetic:guarded-continuation'"
        )
        .await,
        0
    );
}
