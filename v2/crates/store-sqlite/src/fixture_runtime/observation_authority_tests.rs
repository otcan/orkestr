//! Receipt authentication, terminal occupancy and ordinary-store refusal.
use super::dispatch_tests::fixture;
use super::guard_tests::snapshot;
use super::observation_contract_tests::{consumed, input};
use super::*;
use orkestr_v2_application::runtime::*;

#[tokio::test]
async fn failed_before_started_is_terminal_replayable_and_never_releases_session() {
    use orkestr_v2_application::IntakeStore;
    use orkestr_v2_contracts::{ConversationEvent, MessageInput};
    use std::time::Duration;
    let f = fixture().await;
    let p = consumed(&f).await;
    let e = input(&p, 1, ProviderEvent::Failed);
    let failed = f
        .handle
        .append_provider_event(&f.owner, &p, &e)
        .await
        .unwrap();
    assert_eq!(failed.state, RunState::Failed);
    f.a.admit(
        &f.owner,
        &f.conversation,
        &MessageInput {
            client_message_id: "followup".into(),
            text: "Synthetic followup".into(),
        },
    )
    .await
    .unwrap();
    let claim =
        f.a.claim_next(
            &f.owner,
            &f.conversation,
            &f.binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .admit_run(
                &claim,
                &f.binding.session_id,
                f.binding.generation,
                "second-run"
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::Busy
    );
    assert!(before == snapshot(&f).await);
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let handle = f.handle.reattach(&reopened).await.unwrap();
    let replay = handle
        .append_provider_event(&f.owner, &p, &e)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(failed.event_id, replay.event_id);
    assert_eq!(replay.state, RunState::Failed);
    let events = reopened
        .events(&f.owner, &f.conversation, 0, 100)
        .await
        .unwrap();
    assert_eq!(events.len(), 3);
    assert!(matches!(&events[0], ConversationEvent::MessageAccepted(_)));
    let ConversationEvent::FixtureProviderObserved(observed) = &events[1] else {
        panic!("distinct canonical variant")
    };
    assert_eq!(observed.source_message_id, f.claim.message_id);
    assert_eq!(observed.source_event_id, f.claim.event_id);
    assert_eq!(observed.payload_ref_or_safe_payload.run_sequence, 1);
    assert!(matches!(&events[2], ConversationEvent::MessageAccepted(_)));
    assert_eq!(
        events
            .iter()
            .map(ConversationEvent::sequence)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    reopened.close().await;
    f.cleanup().await;
}

#[tokio::test]
async fn forged_envelopes_cannot_read_committed_receipts_or_append_evidence() {
    let f = fixture().await;
    let p = consumed(&f).await;
    let e = input(&p, 1, ProviderEvent::Started);
    f.handle
        .append_provider_event(&f.owner, &p, &e)
        .await
        .unwrap();
    let before = snapshot(&f).await;
    for (case, mutate, _) in super::guard_tests::provider_tampers() {
        let mut forged = p.clone();
        mutate(&mut forged);
        assert!(
            f.handle
                .append_provider_event(&f.owner, &forged, &e)
                .await
                .is_err(),
            "forged committed replay accepted: {case}"
        );
        assert!(
            before == snapshot(&f).await,
            "forged replay changed rows: {case}"
        );
        let unseen = input(&p, 2, ProviderEvent::ApprovalRequested);
        assert!(
            f.handle
                .append_provider_event(&f.owner, &forged, &unseen)
                .await
                .is_err(),
            "forged unseen evidence accepted: {case}"
        );
        assert!(
            before == snapshot(&f).await,
            "forged unseen changed rows: {case}"
        );
    }
    for (lease, fence) in [
        (p.run.lease_generation + 1, p.run.dispatch_fence),
        (p.run.lease_generation, p.run.dispatch_fence + 1),
    ] {
        let mut changed = e.clone();
        changed.lease_generation = lease;
        changed.dispatch_fence = fence;
        assert_eq!(
            f.handle
                .append_provider_event(&f.owner, &p, &changed)
                .await
                .unwrap_err(),
            RuntimeStoreError::Conflict
        );
        changed.sequence = 2;
        assert!(matches!(
            f.handle
                .append_provider_event(&f.owner, &p, &changed)
                .await
                .unwrap_err(),
            RuntimeStoreError::StaleLease | RuntimeStoreError::Fenced
        ));
        assert!(before == snapshot(&f).await);
    }
    f.cleanup().await;
}

#[tokio::test]
async fn ordinary_store_append_stays_unavailable_and_lease_expired_committed_retry_is_read_only() {
    use std::time::Duration;
    let mut f = fixture().await;
    // Test-only shorten the unadmitted claim; admission persists this exact deadline.
    let deadline = now(&mut f.a.pool.acquire().await.unwrap()).await.unwrap() + 1500;
    f.claim.lease_deadline_ms = deadline;
    sqlx::query("UPDATE reasoning_inbox SET claim_deadline_ms=? WHERE conversation_id=?")
        .bind(deadline)
        .bind(f.conversation.to_string())
        .execute(&f.a.pool)
        .await
        .unwrap();
    let p = consumed(&f).await;
    let e = input(&p, 1, ProviderEvent::Started);
    let before = snapshot(&f).await;
    assert_eq!(
        f.a.append_provider_event(&f.owner, &p, &e)
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    assert!(before == snapshot(&f).await);
    let receipt = f
        .handle
        .append_provider_event(&f.owner, &p, &e)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1600)).await;
    let before = snapshot(&f).await;
    let duplicate = f
        .handle
        .append_provider_event(&f.owner, &p, &e)
        .await
        .unwrap();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.event_id, receipt.event_id);
    assert_eq!(
        f.handle
            .append_provider_event(
                &f.owner,
                &p,
                &input(&p, 2, ProviderEvent::ApprovalRequested)
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::Expired
    );
    assert!(before == snapshot(&f).await);
    f.cleanup().await;
}
