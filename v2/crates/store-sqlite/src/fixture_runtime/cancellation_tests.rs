//! Actual SQLite cancellation authority; no provider process or production start.
use super::dispatch_tests::fixture;
use super::guard_tests::{provider_tampers, snapshot};
use super::observation_contract_tests::{consumed, input};
use super::*;
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{ConversationEvent, MessageInput};

fn control(p: &ProviderAdmission, receipt: &CancelReceipt) -> ProviderAdmission {
    ProviderAdmission {
        run: receipt.new_fenced_admission.clone(),
        binding: p.binding.clone(),
    }
}

#[tokio::test]
async fn candidate_and_reserved_cancel_atomically_erase_authority_without_delivery() {
    for reserved in [false, true] {
        let f = fixture().await;
        let fresh = f.admit().await;
        let claim = if reserved {
            let DispatchClaimResult::Reserved(claim) = f
                .handle
                .claim_provider_dispatch(&fresh, "reserve")
                .await
                .unwrap()
            else {
                panic!("reservation")
            };
            Some(claim)
        } else {
            None
        };
        let second = f.handle.reattach(&f.b).await.unwrap();
        let (a, b) = tokio::join!(
            f.handle
                .request_cancel(&f.owner, &fresh.provider.run.run_id, "cancel"),
            second.request_cancel(&f.owner, &fresh.provider.run.run_id, "cancel")
        );
        let receipt = a.unwrap();
        assert_eq!(receipt, b.unwrap());
        assert_eq!(receipt.state, RunState::Cancelled);
        assert_eq!(receipt.inflight_status, InflightStatus::NotDispatched);
        assert_eq!(
            receipt.new_fenced_admission.purpose,
            AdmissionPurpose::CancellationAcknowledgement
        );
        assert_eq!(receipt.new_fenced_admission.lease_generation, 2);
        assert_eq!(
            receipt.new_fenced_admission.dispatch_fence,
            fresh.provider.run.dispatch_fence + 1
        );
        let row = sqlx::query("SELECT r.*,c.state AS control FROM fixture_runs r JOIN fixture_control_outbox c ON c.run_id=r.id")
            .fetch_one(&f.a.pool).await.unwrap();
        assert_eq!(row.get::<&str, _>("state"), "cancelled");
        assert_eq!(row.get::<&str, _>("control"), "not_dispatched");
        for field in ["candidate_hash", "reservation_hash", "reserve_key"] {
            assert!(row.get::<Option<String>, _>(field).is_none());
        }
        let before = snapshot(&f).await;
        assert!(f
            .handle
            .claim_provider_dispatch(&fresh, "retry")
            .await
            .is_err());
        if let Some(claim) = claim {
            assert!(f.handle.consume_provider_dispatch(&claim).await.is_err());
        }
        let p = control(&fresh.provider, &receipt);
        assert!(f
            .handle
            .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Stopped))
            .await
            .is_err());
        assert!(before == snapshot(&f).await);
        let events = f.a.events(&f.owner, &f.conversation, 0, 100).await.unwrap();
        assert_eq!(events.len(), 2);
        assert!(
            matches!(&events[1],ConversationEvent::FixtureCancellationRequested(e) if matches!(e.payload_ref_or_safe_payload.outcome,orkestr_v2_contracts::FixtureCancellationOutcome::NotDispatched))
        );
        f.cleanup().await;
    }
}

#[tokio::test]
async fn consumed_cancel_requires_exact_control_token_and_preserves_historical_receipts() {
    let f = fixture().await;
    let p = consumed(&f).await;
    let started = input(&p, 1, ProviderEvent::Started);
    let original = f
        .handle
        .append_provider_event(&f.owner, &p, &started)
        .await
        .unwrap();
    let receipt = f
        .handle
        .request_cancel(&f.owner, &p.run.run_id, "cancel")
        .await
        .unwrap();
    assert_eq!(
        (receipt.state, receipt.inflight_status),
        (RunState::CancelRequested, InflightStatus::Unknown)
    );
    let c = control(&p, &receipt);
    let before = snapshot(&f).await;
    let replay = f
        .handle
        .append_provider_event(&f.owner, &p, &started)
        .await
        .unwrap();
    assert_eq!(
        (replay.event_id, replay.state),
        (original.event_id, RunState::Running)
    );
    assert!(replay.duplicate);
    assert_eq!(
        f.handle
            .append_provider_event(
                &f.owner,
                &p,
                &input(&p, 2, ProviderEvent::CompletedProposal { synthetic: true })
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, 2, ProviderEvent::Stopped))
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &c, &input(&c, 2, ProviderEvent::Started))
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert_eq!(
        f.handle
            .renew_lease(&c.run, c.run.lease_generation)
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    for (case, mutate, _) in provider_tampers() {
        let mut forged = c.clone();
        mutate(&mut forged);
        if forged == c {
            continue;
        }
        assert!(
            f.handle
                .append_provider_event(&f.owner, &forged, &input(&c, 2, ProviderEvent::Stopped))
                .await
                .is_err(),
            "accepted {case}"
        );
        assert!(before == snapshot(&f).await, "changed {case}");
    }
    let mut forged_execution = c.clone();
    forged_execution.run.purpose = AdmissionPurpose::Execution;
    assert_eq!(
        f.handle
            .append_provider_event(
                &f.owner,
                &forged_execution,
                &input(&c, 2, ProviderEvent::Stopped)
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert!(before == snapshot(&f).await);
    let second = f.handle.reattach(&f.b).await.unwrap();
    let stopped = input(&c, 2, ProviderEvent::Stopped);
    let (a, b) = tokio::join!(
        f.handle.append_provider_event(&f.owner, &c, &stopped),
        second.append_provider_event(&f.owner, &c, &stopped)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(
        (a.event_id.clone(), a.scope_sequence, a.state),
        (b.event_id, b.scope_sequence, RunState::Cancelled)
    );
    assert_ne!(a.duplicate, b.duplicate);
    let control_state: String = sqlx::query_scalar("SELECT state FROM fixture_control_outbox")
        .fetch_one(&f.a.pool)
        .await
        .unwrap();
    assert_eq!(control_state, "acknowledged");
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .request_cancel(&f.owner, &p.run.run_id, "cancel")
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        f.handle
            .request_cancel(&f.owner, &p.run.run_id, "different")
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &c, &input(&c, 2, ProviderEvent::Failed))
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert!(before == snapshot(&f).await);
    let events = f.a.events(&f.owner, &f.conversation, 0, 100).await.unwrap();
    assert_eq!(
        events
            .iter()
            .map(ConversationEvent::sse_name)
            .collect::<Vec<_>>(),
        vec![
            "message_accepted",
            "fixture_provider_observed",
            "fixture_cancellation_requested",
            "fixture_provider_stopped"
        ]
    );
    let ConversationEvent::FixtureProviderStopped(e) = &events[3] else {
        panic!("stopped metadata")
    };
    assert_eq!(e.payload_ref_or_safe_payload.run_sequence, 2);
    assert_eq!(
        events
            .iter()
            .map(ConversationEvent::sequence)
            .collect::<Vec<_>>(),
        vec![1, 2, 3, 4]
    );
    f.a.close().await;
    f.b.close().await;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let handle = f.handle.reattach(&reopened).await.unwrap();
    let replay = handle
        .append_provider_event(&f.owner, &c, &stopped)
        .await
        .unwrap();
    assert_eq!(
        (replay.event_id, replay.state, replay.duplicate),
        (a.event_id, RunState::Cancelled, true)
    );
    assert_eq!(
        handle
            .request_cancel(&f.owner, &p.run.run_id, "cancel")
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        reopened
            .request_cancel(&f.owner, &p.run.run_id, "cancel")
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    reopened.close().await;
    f.cleanup().await;
}

#[tokio::test]
async fn cancel_and_consume_race_never_reports_unknown_as_confirmed_stop() {
    for _ in 0..4 {
        let f = fixture().await;
        let fresh = f.admit().await;
        let DispatchClaimResult::Reserved(claim) = f
            .handle
            .claim_provider_dispatch(&fresh, "reserve")
            .await
            .unwrap()
        else {
            panic!("reserved")
        };
        let second = f.handle.reattach(&f.b).await.unwrap();
        let (consume, cancel) = tokio::join!(
            f.handle.consume_provider_dispatch(&claim),
            second.request_cancel(&f.owner, &fresh.provider.run.run_id, "cancel")
        );
        let cancel = cancel.unwrap();
        match consume {
            Ok(DispatchConsumption::DispatchNow) => assert_eq!(
                (cancel.state, cancel.inflight_status),
                (RunState::CancelRequested, InflightStatus::Unknown)
            ),
            Err(RuntimeStoreError::StaleLease | RuntimeStoreError::Fenced) => assert_eq!(
                (cancel.state, cancel.inflight_status),
                (RunState::Cancelled, InflightStatus::NotDispatched)
            ),
            other => panic!("unexpected consume outcome: {other:?}"),
        }
        let before = snapshot(&f).await;
        assert!(f.handle.consume_provider_dispatch(&claim).await.is_err());
        assert!(before == snapshot(&f).await);
        f.cleanup().await;
    }
}

#[tokio::test]
async fn cancel_and_stopped_failure_roll_back_all_authority_journal_and_control_rows() {
    let f = fixture().await;
    let p = consumed(&f).await;
    sqlx::raw_sql("CREATE TRIGGER fail_cancel BEFORE INSERT ON fixture_control_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END;").execute(&f.a.pool).await.unwrap();
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .request_cancel(&f.owner, &p.run.run_id, "cancel")
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    assert!(before == snapshot(&f).await);
    sqlx::query("DROP TRIGGER fail_cancel")
        .execute(&f.a.pool)
        .await
        .unwrap();
    let receipt = f
        .handle
        .request_cancel(&f.owner, &p.run.run_id, "cancel")
        .await
        .unwrap();
    let c = control(&p, &receipt);
    sqlx::raw_sql("CREATE TRIGGER fail_stopped BEFORE UPDATE ON fixture_control_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END;").execute(&f.a.pool).await.unwrap();
    let before = snapshot(&f).await;
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &c, &input(&c, 1, ProviderEvent::Stopped))
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    assert!(before == snapshot(&f).await);
    sqlx::query("DROP TRIGGER fail_stopped")
        .execute(&f.a.pool)
        .await
        .unwrap();
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &c, &input(&c, 1, ProviderEvent::Stopped))
            .await
            .unwrap()
            .state,
        RunState::Cancelled
    );
    f.cleanup().await;
}

#[tokio::test]
async fn terminal_evidence_cannot_be_relabelled_or_release_the_occupied_session() {
    for event in [
        ProviderEvent::Failed,
        ProviderEvent::Lost,
        ProviderEvent::CompletedProposal { synthetic: true },
    ] {
        let f = fixture().await;
        let p = consumed(&f).await;
        let sequence = if matches!(event, ProviderEvent::CompletedProposal { .. }) {
            f.handle
                .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
                .await
                .unwrap();
            2
        } else {
            1
        };
        let evidence = input(&p, sequence, event);
        let receipt = f
            .handle
            .append_provider_event(&f.owner, &p, &evidence)
            .await
            .unwrap();
        let before = snapshot(&f).await;
        assert_eq!(
            f.handle
                .request_cancel(&f.owner, &p.run.run_id, "cancel")
                .await
                .unwrap_err(),
            RuntimeStoreError::Fenced
        );
        let replay = f
            .handle
            .append_provider_event(&f.owner, &p, &evidence)
            .await
            .unwrap();
        assert_eq!(
            (replay.event_id, replay.state),
            (receipt.event_id, receipt.state)
        );
        assert!(before == snapshot(&f).await);
        f.a.admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "followup".into(),
                text: "synthetic".into(),
            },
        )
        .await
        .unwrap();
        let claim =
            f.a.claim_next(
                &f.owner,
                &f.conversation,
                &f.binding.session_id,
                std::time::Duration::from_secs(10),
            )
            .await
            .unwrap()
            .unwrap();
        let before = snapshot(&f).await;
        assert_eq!(
            f.handle
                .admit_run(&claim, &f.binding.session_id, f.binding.generation, "run2")
                .await
                .unwrap_err(),
            RuntimeStoreError::Busy
        );
        assert!(before == snapshot(&f).await);
        f.cleanup().await;
    }
}
