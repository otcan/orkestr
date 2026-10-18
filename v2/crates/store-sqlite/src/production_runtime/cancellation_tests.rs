use super::tests::{claim, ready, setup, snapshot, Case};
use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;
use std::time::Duration;
async fn admission(f: &Case) -> RunAdmissionResult {
    let b = ready(f).await;
    let c = claim(f, &b).await;
    f.handle
        .admit_run(&c, &b.session_id, b.generation, "cancel-run")
        .await
        .unwrap()
}
fn input(p: &ProviderAdmission, sequence: u64, event: ProviderEvent) -> ProviderEventInput {
    ProviderEventInput {
        run_id: p.run.run_id.clone(),
        session_id: p.run.session_id.clone(),
        sequence,
        lease_generation: p.run.lease_generation,
        dispatch_fence: p.run.dispatch_fence,
        event,
    }
}
async fn consume(f: &Case, run: &RunAdmissionResult) -> DispatchClaim {
    let DispatchClaimResult::Reserved(r) = f
        .handle
        .claim_provider_dispatch(run, "reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(matches!(
        f.handle.consume_execution(&r).await.unwrap(),
        ExecutionConsumption::Dispatch(_)
    ));
    *r
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_cancel_fences_execution_and_only_issued_control_confirms_stop() {
    let f = setup().await;
    let run = admission(&f).await;
    consume(&f, &run).await;
    let p = &run.provider;
    let started = input(p, 1, ProviderEvent::Started);
    let original = f
        .handle
        .append_provider_event(&f.owner, p, &started)
        .await
        .unwrap();
    let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&other).await.unwrap();
    let (a, b) = tokio::join!(
        f.handle.request_cancel(&f.owner, &p.run.run_id, "cancel"),
        attached.request_cancel(&f.owner, &p.run.run_id, "cancel")
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a, b);
    assert_eq!(a.state, RunState::CancelRequested);
    assert_eq!(a.inflight_status, InflightStatus::Unknown);
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .append_provider_event(
                &f.owner,
                p,
                &input(p, 2, ProviderEvent::CompletedProposal { synthetic: false })
            )
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, p, &started)
            .await
            .unwrap()
            .event_id,
        original.event_id
    );
    let mut control = p.clone();
    control.run = a.new_fenced_admission.clone();
    let mut calls = 0;
    assert!(matches!(
        f.handle.with_execution_fence(&control, || {
            calls += 1;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(calls, 0);
    let mut forged = control.clone();
    forged.run.lease_deadline_ms += 1;
    assert!(f
        .handle
        .append_provider_event(
            &f.owner,
            &forged,
            &input(&forged, 2, ProviderEvent::Stopped)
        )
        .await
        .is_err());
    assert_eq!(snapshot(&f.store).await, before);
    let stopped = input(&control, 2, ProviderEvent::Stopped);
    let receipt = f
        .handle
        .append_provider_event(&f.owner, &control, &stopped)
        .await
        .unwrap();
    assert_eq!(receipt.state, RunState::Cancelled);
    assert!(
        f.handle
            .append_provider_event(&f.owner, &control, &stopped)
            .await
            .unwrap()
            .duplicate
    );
    assert_eq!(
        f.handle
            .request_cancel(&f.owner, &p.run.run_id, "cancel")
            .await
            .unwrap(),
        a
    );
    let events = f
        .store
        .events(&f.owner, &f.conversation, 0, 100)
        .await
        .unwrap();
    assert_eq!(
        events.iter().map(|e| e.sse_name()).collect::<Vec<_>>(),
        vec![
            "message_accepted",
            "provider_observed",
            "cancellation_requested",
            "provider_stopped"
        ]
    );
    assert!(events.iter().all(|e| serde_json::to_value(e).is_ok()));
    let binding = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    assert_eq!(binding.state, SessionState::Ready);
    assert_eq!(binding.native_session_id, p.binding.native_session_id);
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "next-turn".into(),
                text: "next synthetic turn".into(),
            },
        )
        .await
        .unwrap();
    let claim = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let next = f
        .handle
        .admit_run(&claim, &binding.session_id, binding.generation, "next-run")
        .await
        .unwrap();
    assert_eq!(next.disposition, AdmissionDisposition::FreshCandidate);
    assert_ne!(next.provider.run.run_id, p.run.run_id);
    assert_eq!(next.provider.run.native_session_id, p.run.native_session_id);
    let stable = snapshot(&f.store).await;
    assert!(f
        .handle
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "competing-run"
        )
        .await
        .is_err());
    assert_eq!(snapshot(&f.store).await, stable);
}
#[tokio::test]
async fn undispatched_cancel_erases_locators_and_replay_survives_takeover() {
    for reserved in [false, true] {
        let f = setup().await;
        let run = admission(&f).await;
        let reservation = if reserved {
            let DispatchClaimResult::Reserved(r) = f
                .handle
                .claim_provider_dispatch(&run, "reserve")
                .await
                .unwrap()
            else {
                panic!()
            };
            Some(r)
        } else {
            None
        };
        let receipt = f
            .handle
            .request_cancel(&f.owner, &run.provider.run.run_id, "cancel")
            .await
            .unwrap();
        assert_eq!(receipt.state, RunState::Cancelled);
        assert_eq!(receipt.inflight_status, InflightStatus::NotDispatched);
        let before = snapshot(&f.store).await;
        assert!(f
            .handle
            .claim_provider_dispatch(&run, "retry")
            .await
            .is_err());
        if let Some(r) = reservation {
            assert!(f.handle.consume_execution(&r).await.is_err());
        }
        assert_eq!(snapshot(&f.store).await, before);
        sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0")
            .execute(&f.store.pool)
            .await
            .unwrap();
        let successor = f
            .store
            .authorize_supervisor(
                &f.token,
                super::tests::config(ProductionTakeover::ExpiredPredecessor {
                    incarnation_id: f.handle.supervisor_incarnation().unwrap().into(),
                }),
            )
            .await
            .unwrap();
        let before = snapshot(&f.store).await;
        assert_eq!(
            successor
                .request_cancel(&f.owner, &run.provider.run.run_id, "cancel")
                .await
                .unwrap(),
            receipt
        );
        assert!(matches!(
            successor
                .request_cancel(&f.owner, &run.provider.run.run_id, "changed")
                .await,
            Err(RuntimeStoreError::Fenced)
        ));
        assert_eq!(snapshot(&f.store).await, before);
    }
}
#[tokio::test]
async fn terminal_evidence_wins_cancel_race_without_relabelling() {
    let f = setup().await;
    let run = admission(&f).await;
    consume(&f, &run).await;
    let failed = input(&run.provider, 1, ProviderEvent::Failed);
    let receipt = f
        .handle
        .append_provider_event(&f.owner, &run.provider, &failed)
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .request_cancel(&f.owner, &run.provider.run.run_id, "cancel")
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &run.provider, &failed)
            .await
            .unwrap()
            .event_id,
        receipt.event_id
    );
    assert_eq!(snapshot(&f.store).await, before);
}
#[tokio::test]
async fn consume_cancel_race_has_exactly_one_durable_delivery_decision() {
    for _ in 0..4 {
        let f = setup().await;
        let run = admission(&f).await;
        let DispatchClaimResult::Reserved(reservation) = f
            .handle
            .claim_provider_dispatch(&run, "reserve")
            .await
            .unwrap()
        else {
            panic!()
        };
        let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
        let attached = f.handle.reattach_supervisor(&other).await.unwrap();
        let (delivery, cancel) = tokio::join!(
            attached.consume_execution(&reservation),
            f.handle
                .request_cancel(&f.owner, &run.provider.run.run_id, "cancel")
        );
        let cancel = cancel.unwrap();
        match delivery {
            Ok(ExecutionConsumption::Dispatch(_)) => {
                assert_eq!(cancel.state, RunState::CancelRequested);
                assert_eq!(cancel.inflight_status, InflightStatus::Unknown);
            }
            Err(RuntimeStoreError::Fenced) => {
                assert_eq!(cancel.state, RunState::Cancelled);
                assert_eq!(cancel.inflight_status, InflightStatus::NotDispatched);
            }
            _ => panic!("unexpected consume decision"),
        }
        let locators:i64=sqlx::query_scalar("SELECT count(*) FROM production_runs WHERE candidate_hash IS NOT NULL OR reservation_hash IS NOT NULL OR reserve_key IS NOT NULL").fetch_one(&f.store.pool).await.unwrap();
        assert_eq!(locators, 0);
    }
}
#[tokio::test]
async fn cancellation_and_ack_failures_rollback_complete_snapshots() {
    let f = setup().await;
    let run = admission(&f).await;
    consume(&f, &run).await;
    sqlx::query("CREATE TRIGGER fail_cancel BEFORE INSERT ON production_control_outbox BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END").execute(&f.store.pool).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.handle
            .request_cancel(&f.owner, &run.provider.run.run_id, "cancel")
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    sqlx::query("DROP TRIGGER fail_cancel")
        .execute(&f.store.pool)
        .await
        .unwrap();
    let receipt = f
        .handle
        .request_cancel(&f.owner, &run.provider.run.run_id, "cancel")
        .await
        .unwrap();
    let mut control = run.provider;
    control.run = receipt.new_fenced_admission;
    sqlx::query("CREATE TRIGGER fail_ack BEFORE UPDATE ON production_control_outbox BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END").execute(&f.store.pool).await.unwrap();
    let before = snapshot(&f.store).await;
    let stopped = input(&control, 1, ProviderEvent::Stopped);
    assert!(matches!(
        f.handle
            .append_provider_event(&f.owner, &control, &stopped)
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    sqlx::query("DROP TRIGGER fail_ack")
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(
        f.handle
            .append_provider_event(&f.owner, &control, &stopped)
            .await
            .unwrap()
            .state,
        RunState::Cancelled
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn control_callback_is_scoped_and_never_reusable_after_ack_or_revoke() {
    let f = setup().await;
    let run = admission(&f).await;
    consume(&f, &run).await;
    let receipt = f
        .handle
        .request_cancel(&f.owner, &run.provider.run.run_id, "cancel")
        .await
        .unwrap();
    let mut control = run.provider.clone();
    control.run = receipt.new_fenced_admission;
    let mut calls = 0;
    assert!(matches!(
        f.handle.with_cancellation_fence(&run.provider, || {
            calls += 1;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(
        f.handle
            .with_cancellation_fence(&control, || {
                calls += 1;
                Ok::<_, ()>(7)
            })
            .unwrap(),
        Ok(7)
    );
    f.handle
        .append_provider_event(
            &f.owner,
            &control,
            &input(&control, 1, ProviderEvent::Stopped),
        )
        .await
        .unwrap();
    assert!(matches!(
        f.handle.with_cancellation_fence(&control, || {
            calls += 1;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Fenced)
    ));
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(matches!(
        f.handle.with_cancellation_fence(&control, || {
            calls += 1;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(calls, 1);
}
#[tokio::test]
async fn admission_replay_after_cancel_returns_only_historical_execution_identity() {
    let f = setup().await;
    let binding = ready(&f).await;
    let claim = claim(&f, &binding).await;
    let run = f
        .handle
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "replay-run",
        )
        .await
        .unwrap();
    consume(&f, &run).await;
    let cancel = f
        .handle
        .request_cancel(&f.owner, &run.provider.run.run_id, "cancel")
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    let replay = f
        .handle
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "replay-run",
        )
        .await
        .unwrap();
    assert_eq!(replay.provider, run.provider);
    assert_eq!(
        replay.disposition,
        AdmissionDisposition::ReconciliationRequired
    );
    assert!(replay.candidate_key.is_none());
    let mut control = run.provider;
    control.run = cancel.new_fenced_admission;
    assert!(matches!(
        f.handle
            .append_provider_event(
                &f.owner,
                &replay.provider,
                &input(&replay.provider, 1, ProviderEvent::Started)
            )
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert_eq!(snapshot(&f.store).await, before);
    assert_eq!(
        f.handle
            .append_provider_event(
                &f.owner,
                &control,
                &input(&control, 1, ProviderEvent::Stopped)
            )
            .await
            .unwrap()
            .state,
        RunState::Cancelled
    );
}
