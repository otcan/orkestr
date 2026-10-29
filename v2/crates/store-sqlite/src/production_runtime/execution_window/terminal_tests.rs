use super::tests::{browser, input};
use super::*;
use crate::production_runtime::{observation_tests::input as observation, tests as fixtures};
use orkestr_v2_contracts::ExecutionAcceptanceRequest;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expired_proposal_acceptance_closes_only_with_terminal_provenance_then_reattaches() {
    let f = fixtures::setup().await;
    let browser = browser(&f).await;
    let binding = fixtures::ready(&f).await;
    let request = input(&f, "first-window-proposal").await;
    let a = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &request)
        .await
        .unwrap();
    let cap = f
        .handle
        .issue_execution_window_credential(
            &f.token,
            a.status.window_id,
            1,
            "first-boot",
            a.status.expires_at_ms,
            &"e".repeat(64),
        )
        .await
        .unwrap();
    let bound = f
        .handle
        .bind_execution_window(&f.token, &cap)
        .await
        .unwrap();
    bound
        .activate_execution_window(cap.credential(), a.status.window_id, 1, "first-boot")
        .await
        .unwrap();
    let claim = bound
        .claim_next(
            &f.owner,
            &f.conversation,
            &binding.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    let run = bound
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "terminal-window-run",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = bound
        .claim_provider_dispatch(&run, "terminal-window-dispatch")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(dispatch) =
        bound.consume_execution(&reservation).await.unwrap()
    else {
        panic!()
    };
    let p = dispatch.provider();
    bound
        .append_provider_event(&f.owner, p, &observation(p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    let done = bound
        .append_provider_event(
            &f.owner,
            p,
            &observation(p, 2, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    bound
        .begin_execution_window_retirement(cap.credential(), a.status.window_id, 1, "first-boot")
        .await
        .unwrap();
    // Deterministic clock boundary, preserving the ledger's exact duration checks.
    sqlx::query("UPDATE execution_windows SET opened_at_ms=opened_at_ms-900001,work_deadline_ms=work_deadline_ms-900001,expires_at_ms=expires_at_ms-900001 WHERE id=?")
        .bind(a.status.window_id.to_string()).execute(&f.store.pool).await.unwrap();
    assert!(bound
        .retire_execution_window(
            cap.credential(),
            a.status.window_id,
            1,
            "first-boot",
            &p.run.run_id
        )
        .await
        .is_err());
    let status = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        status.phase,
        orkestr_v2_contracts::ExecutionPhase::AwaitingAcceptance
    );
    assert!(!f
        .store
        .execution_window_switch_ready_authenticated(&browser, &f.conversation)
        .await
        .unwrap());
    let called = std::sync::atomic::AtomicBool::new(false);
    assert!(bound
        .with_execution_fence(p, || {
            called.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
    f.store
        .accept_execution_authenticated(
            &browser,
            &f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: p.run.run_id.clone(),
                completion_event_id: done.event_id.clone(),
                expected_revision: status.revision,
                request_key: "post-expiry-owner-accept".into(),
            },
        )
        .await
        .unwrap();
    // Trusted teardown call models the server boundary after original reap proof;
    assert!(f
        .store
        .execution_window_switch_ready_authenticated(&browser, &f.conversation)
        .await
        .unwrap());
    // this Store test makes no native/process cleanup claim.
    bound
        .retire_terminal_supervisor(cap.credential(), &p.run.run_id)
        .await
        .unwrap();
    let (retired, handoff) = bound
        .retire_execution_window(
            cap.credential(),
            a.status.window_id,
            1,
            "first-boot",
            &p.run.run_id,
        )
        .await
        .unwrap();
    assert_eq!(handoff.credential(), cap.credential());
    assert_eq!(handoff.run_id(), &p.run.run_id);
    assert_eq!(handoff.outcome(), "accepted");
    let canonical: String =
        sqlx::query_scalar("SELECT event_id FROM production_acceptances WHERE run_id=?")
            .bind(p.run.run_id.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(handoff.terminal_event_id().to_string(), canonical);
    assert_ne!(handoff.terminal_event_id(), &done.event_id);
    // The manager replay reads exactly this committed decision back.
    assert_eq!(
        f.store
            .closed_execution_window_retirement_authenticated(
                &browser,
                &f.conversation,
                a.status.window_id,
                1,
            )
            .await
            .unwrap(),
        Some(ClosedExecutionWindowRetirement {
            outcome: orkestr_v2_contracts::ExecutionWindowTerminalOutcome::Accepted,
            run_id: p.run.run_id.clone(),
            terminal_event_id: handoff.terminal_event_id().clone(),
        })
    );
    assert_eq!(
        f.store
            .closed_execution_window_retirement_authenticated(
                &browser,
                &f.conversation,
                a.status.window_id,
                2,
            )
            .await
            .unwrap(),
        None
    );

    let mut next = input(&f, "second-window-source").await;
    next.expected_generation = 1;
    next.predecessor_window_id = Some(a.status.window_id);
    let b = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &next)
        .await
        .unwrap();
    let new_cap = retired
        .issue_execution_window_credential(
            handoff.credential(),
            b.status.window_id,
            2,
            "second-boot",
            b.status.expires_at_ms,
            &"f".repeat(64),
        )
        .await
        .unwrap();
    let config = fixtures::config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: retired.supervisor_incarnation().unwrap().into(),
    });
    let (new_store, metadata) = f
        .store
        .reattach_terminal_supervisor(new_cap.credential(), config, &p.run.run_id)
        .await
        .unwrap();
    assert_eq!(
        metadata.binding().native_session_id,
        p.binding.native_session_id
    );
    new_store
        .activate_execution_window(new_cap.credential(), b.status.window_id, 2, "second-boot")
        .await
        .unwrap();
    assert!(retired
        .mark_execution_window_uncertain(handoff.credential(), a.status.window_id, 1, "first-boot")
        .await
        .is_err());
}
