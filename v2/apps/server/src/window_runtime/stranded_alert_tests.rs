use super::{open_failure_alert, Actor, Decision, ExecutionWindowReconciliation, Outcome};
use orkestr_v2_contracts::{ConversationId, EventId, ExecutionWindowOpenFailureCause, RunId};
use uuid::Uuid;

fn receipt(cause: Option<ExecutionWindowOpenFailureCause>) -> ExecutionWindowReconciliation {
    ExecutionWindowReconciliation {
        reconciliation_id: Uuid::from_u128(1),
        window_id: Uuid::from_u128(2),
        conversation_id: ConversationId(Uuid::from_u128(3)),
        generation: 10,
        actor: Actor::Startup,
        decision: Decision::AbandonUnaccepted,
        outcome: if cause.is_some() {
            Outcome::Failed
        } else {
            Outcome::Abandoned
        },
        prior_run_id: cause.is_none().then(|| RunId(Uuid::from_u128(4))),
        terminal_event_id: cause.is_none().then(|| EventId(Uuid::from_u128(5))),
        abandoned_run_ids: Vec::new(),
        failed_run_ids: Vec::new(),
        open_failure_cause: cause,
        restored_window_id: None,
        released_input_event_ids: vec![EventId(Uuid::from_u128(6))],
        reconciled_at_ms: 1,
        duplicate: false,
    }
}

/// Every failed open (a timer window at 04:43Z/05:43Z, or any other) gives
/// the operator one alert line naming only identifiers and the cause.
#[test]
fn a_failed_open_alerts_the_operator_with_identifiers_only() {
    let alert = open_failure_alert(
        &receipt(Some(ExecutionWindowOpenFailureCause::SetupIncomplete)),
        1,
    )
    .unwrap();
    assert_eq!(
        alert,
        format!(
            "ALERT orkestr-v2-server window_open_failed conversation={} window={} generation=10 cause=setup_incomplete actor=startup released_inputs=1 timer_retries=1",
            Uuid::from_u128(3),
            Uuid::from_u128(2)
        )
    );
}

#[test]
fn a_reconciled_turn_window_is_not_an_open_failure_alert() {
    assert_eq!(open_failure_alert(&receipt(None), 0), None);
}
