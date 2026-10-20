//! Actual Fast native lifecycle; no reconstructed grants or synthetic observations.
// This target exercises ordinary Fast lifecycle; window-only entry points are
// compiled and checked with the production server library.
#[path = "../src/fast_execution/mod.rs"]
#[allow(dead_code)]
mod fast_execution;
#[path = "support/fast_process.rs"]
mod fixture;
#[path = "../../../crates/orkestr-runtime/src/execution/reuse/host_identity.rs"]
mod host_identity;
use fast_execution::{FastStart, LiveFast, PreparingFast};
use fixture::Case;
use orkestr_v2_application::runtime::{ProductionTakeover, RuntimeStore};
use orkestr_v2_contracts::ExecutionPhase;
use orkestr_v2_server::control_dispatch::{self, StopProgress};
use std::time::{Duration, Instant};

fn live(start: FastStart) -> Box<LiveFast> {
    match start {
        FastStart::Live(live) => live,
        _ => panic!("fresh Fast dispatch required"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_fast_reuses_child_renews_and_recovers_only_after_verified_reap() {
    let mut case = Case::new("continuation-recovery").await;
    let ready = case.ready(None).await;
    let first = case.source(1).await;
    let mut active = live(ready.dispatch(&case.token, &first).await.unwrap());
    case.drive(&mut active, ExecutionPhase::Running).await;
    let first_run = active.run_id().clone();
    let original_inbox =
        case.query("SELECT event_id,state,admitted_run_id FROM reasoning_inbox ORDER BY sequence");
    assert!(active.renewal_quiescent() && active.pending().is_none());
    let prior_deadline = active.lease_deadline_ms();
    case.bound.heartbeat_supervisor().await.unwrap();
    active.renew().await.unwrap();
    assert!(active.lease_deadline_ms() >= prior_deadline);
    assert_eq!(
        case.query("SELECT lease_generation FROM production_runs WHERE role='fast'"),
        serde_json::json!([[2]])
    );
    assert!(!case.native[0].gone());
    case.release(1);
    case.drive(&mut active, ExecutionPhase::AwaitingAcceptance)
        .await;
    assert_eq!(
        case.query("SELECT count(*) FROM production_acceptances"),
        serde_json::json!([[0]])
    );
    assert_eq!(
        case.query("SELECT event_id,state,admitted_run_id FROM reasoning_inbox ORDER BY sequence"),
        original_inbox
    );
    let second = case.source(2).await;
    assert!(
        case.bound.admit_fast(&case.token, &second).await.is_err(),
        "proposal cannot release Fast binding"
    );
    case.accept(&first_run).await;
    let second = case.selected().await;
    let mut active = live(
        active
            .continue_accepted(&case.token, &second)
            .await
            .unwrap(),
    );
    assert_ne!(active.run_id(), &first_run);
    case.drive(&mut active, ExecutionPhase::Running).await;
    assert!(!case.native[0].gone());
    assert_eq!(
        case.trace()
            .iter()
            .filter(|row| row["kind"] == "spawn")
            .count(),
        1
    );
    assert_eq!(
        case.trace()
            .iter()
            .filter(|row| row["kind"] == "thread/start")
            .count(),
        1
    );
    assert_eq!(
        case.trace()
            .iter()
            .filter(|row| row["kind"] == "turn")
            .count(),
        2
    );
    case.release(2);
    case.drive(&mut active, ExecutionPhase::AwaitingAcceptance)
        .await;
    let second_run = active.run_id().clone();
    case.accept(&second_run).await;
    let proof = case
        .reaped(
            active.retire_accepted(&case.token).await.unwrap(),
            &second_run,
        )
        .await;
    assert_eq!(proof.scope().run(), second_run.to_string());
    case.bound
        .retire_terminal_supervisor(&case.token, &second_run)
        .await
        .unwrap();
    let (prior, incarnation) = case
        .store
        .terminal_supervisor_candidate(
            &case.token,
            &Case::config(ProductionTakeover::First),
            &case.conversation,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(prior, second_run);
    let (bound, grant) = case
        .store
        .reattach_terminal_supervisor(
            &case.token,
            Case::config(ProductionTakeover::ExpiredPredecessor {
                incarnation_id: incarnation,
            }),
            &prior,
        )
        .await
        .unwrap();
    case.bound = bound;
    let ready = case.ready(Some(grant)).await;
    let third = case.source(3).await;
    let mut active = live(ready.dispatch(&case.token, &third).await.unwrap());
    case.drive(&mut active, ExecutionPhase::Running).await;
    assert_eq!(
        case.trace()
            .iter()
            .filter(|row| row["kind"] == "spawn")
            .count(),
        2
    );
    assert_eq!(
        case.trace()
            .iter()
            .filter(|row| row["kind"] == "thread/resume")
            .count(),
        1
    );
    assert!(case.native[0].gone() && !case.native[1].gone());
    case.release(3);
    case.drive(&mut active, ExecutionPhase::AwaitingAcceptance)
        .await;
    let third_run = active.run_id().clone();
    case.accept(&third_run).await;
    case.reaped(
        active.retire_accepted(&case.token).await.unwrap(),
        &third_run,
    )
    .await;
    assert_eq!(case.query("SELECT count(DISTINCT native_session_id),count(DISTINCT session_id),count(*) FROM production_runs WHERE role='fast'"), serde_json::json!([[1,1,3]]));
    assert_eq!(
        case.query(
            "SELECT count(*) FROM reasoning_inbox WHERE state='queued' AND admitted_run_id IS NULL"
        ),
        serde_json::json!([[3]])
    );
    assert_eq!(
        case.query("SELECT count(*) FROM production_runs WHERE role!='fast'"),
        serde_json::json!([[0]])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renewed_fast_stop_requires_real_terminal_and_reaps_owned_child() {
    stop_case(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fast_ack_only_never_becomes_settlement_or_recovery() {
    stop_case(true).await;
}

async fn stop_case(ack_only: bool) {
    let mut case = Case::new(if ack_only { "ack-only" } else { "stop" }).await;
    if ack_only {
        std::fs::write(case.root.join("workspace/ack-only"), b"").unwrap();
    }
    let ready = case.ready(None).await;
    let input = case.source(1).await;
    let mut active = live(ready.dispatch(&case.token, &input).await.unwrap());
    case.drive(&mut active, ExecutionPhase::Running).await;
    case.bound.heartbeat_supervisor().await.unwrap();
    active.renew().await.unwrap();
    let run = active.run_id().clone();
    let (sender, mut receiver) = control_dispatch::mailbox(
        case.bound.clone(),
        case.owner.clone(),
        case.conversation.clone(),
        run.clone(),
    )
    .unwrap();
    let receipt = case
        .bound
        .request_cancel(&case.owner, &run, "fast-stop")
        .await
        .unwrap();
    sender.publish(receipt.clone()).unwrap();
    let mut stopping = active.stopping(receiver.take().unwrap().unwrap()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let outcome = loop {
        let outcome = stopping.tick().await;
        if matches!(
            outcome,
            StopProgress::Stopped | StopProgress::ReconciliationRequired
        ) {
            break outcome;
        }
        assert!(Instant::now() < deadline, "Fast Stop deadline");
        tokio::time::sleep(Duration::from_millis(2)).await;
    };
    if ack_only {
        assert_ne!(outcome, StopProgress::Stopped);
        assert!(stopping.retire_broker().is_err());
        case.gone().await;
        assert_eq!(
            case.query("SELECT state FROM production_runs"),
            serde_json::json!([["cancel_requested"]])
        );
        assert_eq!(
            case.query("SELECT count(*) FROM production_observations WHERE kind='stopped'"),
            serde_json::json!([[0]])
        );
    } else {
        assert_eq!(outcome, StopProgress::Stopped);
        let proof = case.reaped(stopping.retire_broker().unwrap(), &run).await;
        assert_eq!(proof.scope().run(), run.to_string());
        case.bound
            .retire_terminal_supervisor(&case.token, &run)
            .await
            .unwrap();
        assert_eq!(case.query("SELECT count(*) FROM production_stopped_retirements g JOIN production_runs r ON r.id=g.prior_run_id JOIN production_observations o ON o.run_id=r.id AND o.event_id=g.stopped_event_id WHERE r.role='fast' AND r.state='cancelled' AND g.context_id=r.context_id AND g.incarnation_id=r.incarnation_id AND g.session_id=r.session_id AND g.binding_generation=r.binding_generation+1 AND o.kind='stopped'"), serde_json::json!([[1]]));
        assert_eq!(
            case.query("SELECT count(*) FROM production_graceful_retirements"),
            serde_json::json!([[0]])
        );
        let (prior, _) = case
            .store
            .terminal_supervisor_candidate(
                &case.token,
                &Case::config(ProductionTakeover::First),
                &case.conversation,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(prior, run);
        drop(proof);
        assert_eq!(
            case.query("SELECT state FROM production_runs"),
            serde_json::json!([["cancelled"]])
        );
    }
    if ack_only {
        assert!(
            case.bound
                .retire_terminal_supervisor(&case.token, &run)
                .await
                .is_err(),
            "interrupt acknowledgement is not canonical Stopped evidence"
        );
        assert_eq!(
            case.query("SELECT count(*) FROM production_stopped_retirements"),
            serde_json::json!([[0]])
        );
    }
    sender.publish(receipt).unwrap();
    assert!(receiver.take().unwrap().is_none());
    assert_eq!(
        case.trace()
            .iter()
            .filter(|row| row["kind"] == "interrupt")
            .count(),
        1
    );
    assert_eq!(
        case.query("SELECT count(*) FROM production_acceptances"),
        serde_json::json!([[0]])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoked_fast_cannot_renew_or_deliver_its_pending_result() {
    let mut case = Case::new("revoked").await;
    let ready = case.ready(None).await;
    let source = case.source(1).await;
    let mut active = live(ready.dispatch(&case.token, &source).await.unwrap());
    case.drive(&mut active, ExecutionPhase::Running).await;
    case.bound.heartbeat_supervisor().await.unwrap();
    active.renew().await.unwrap();
    case.store.revoke_session(&case.token).await.unwrap();
    case.release(1);
    assert!(active.renew().await.is_err());
    active.quarantine();
    drop(active);
    case.gone().await;
    assert_eq!(
        case.query("SELECT count(*) FROM production_acceptances"),
        serde_json::json!([[0]])
    );
    assert_eq!(case.query("SELECT count(*) FROM production_observations WHERE kind IN ('completed_proposal','stopped')"), serde_json::json!([[0]]));
    assert_eq!(
        case.trace()
            .iter()
            .filter(|row| row["kind"] == "turn")
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proposal_alone_refuses_continuation_and_cleans_up_without_new_input() {
    let mut case = Case::new("unaccepted").await;
    let ready = case.ready(None).await;
    let source = case.source(1).await;
    let mut active = live(ready.dispatch(&case.token, &source).await.unwrap());
    case.release(1);
    case.drive(&mut active, ExecutionPhase::AwaitingAcceptance)
        .await;
    let next = case.source(2).await;
    assert!(active.continue_accepted(&case.token, &next).await.is_err());
    case.gone().await;
    assert_eq!(
        case.trace()
            .iter()
            .filter(|row| row["kind"] == "turn")
            .count(),
        1
    );
    assert_eq!(
        case.query("SELECT count(*) FROM production_runs"),
        serde_json::json!([[1]])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_fast_cannot_spend_next_input_on_a_deep_binding() {
    let mut case = Case::new("wrong-binding").await;
    let ready = case.ready(None).await;
    let source = case.source(1).await;
    let mut active = live(ready.dispatch(&case.token, &source).await.unwrap());
    case.release(1);
    case.drive(&mut active, ExecutionPhase::AwaitingAcceptance)
        .await;
    case.accept(active.run_id()).await;
    let mut next = case.source(2).await;
    let deep = case
        .bound
        .ensure_role_bindings(&case.owner, &case.conversation)
        .await
        .unwrap()
        .deep;
    next.fast_binding_id = deep.session_id;
    next.expected_binding_generation = deep.generation;
    assert!(active.continue_accepted(&case.token, &next).await.is_err());
    case.gone().await;
    assert_eq!(
        case.trace()
            .iter()
            .filter(|row| row["kind"] == "turn")
            .count(),
        1
    );
    assert_eq!(
        case.query("SELECT count(*) FROM production_runs"),
        serde_json::json!([[1]])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fast_setup_refuses_a_deep_grant_before_any_native_spawn() {
    let case = Case::new("wrong-role").await;
    let deep = case
        .bound
        .ensure_role_bindings(&case.owner, &case.conversation)
        .await
        .unwrap()
        .deep;
    let grant = case.bound.authorize_session_metadata(&deep).await.unwrap();
    let directories = orkestr_runtime::containment::ChildDirectories::new(
        &case.root.join("workspace"),
        &case.root.join("home"),
        &case.root.join("tmp"),
    )
    .unwrap();
    assert!(PreparingFast::open_retained(
        case.bound.clone(),
        grant,
        &case.root.join("launcher"),
        &case.root.join("workspace"),
        directories,
        Box::new(())
    )
    .is_err());
    assert!(case.trace().is_empty());
    assert_eq!(
        case.query("SELECT count(*) FROM production_runs"),
        serde_json::json!([[0]])
    );
}
