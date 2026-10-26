//! The local failed-open commit is allowed only for a window the manager
//! provably never admitted. Pure decisions over synthetic receipts.
use super::*;
use crate::window_runtime::manager_client::{TerminalOutcome, WindowReceipt};
use orkestr_v2_contracts::{
    ConversationId, EventId, ExecutionWindowLimits, ExecutionWindowState, MessageId, OwnerId, RunId,
};
use orkestr_v2_store_sqlite::StrandedExecutionWindowPlan;
use uuid::Uuid;

const NOW: i64 = 10_000_000;

fn window(generation: u64, opened_at_ms: i64) -> ExecutionWindowStatus {
    ExecutionWindowStatus {
        window_id: Uuid::from_u128(30 + u128::from(generation)),
        conversation_id: ConversationId(Uuid::from_u128(2)),
        generation,
        state: ExecutionWindowState::ReconciliationRequired,
        input_message_id: MessageId(Uuid::from_u128(5)),
        input_event_id: EventId(Uuid::from_u128(6)),
        predecessor_window_id: Some(Uuid::from_u128(30 + u128::from(generation) - 1)),
        opened_at_ms,
        work_deadline_ms: opened_at_ms + 870_000,
        expires_at_ms: opened_at_ms + 900_000,
        limits: ExecutionWindowLimits::default(),
    }
}

fn plan(cause: Option<Cause>, run: bool) -> StrandedExecutionWindow {
    StrandedExecutionWindow::Pending(StrandedExecutionWindowPlan {
        window_id: Uuid::from_u128(32),
        conversation_id: ConversationId(Uuid::from_u128(2)),
        generation: 2,
        outcome: Outcome::Failed,
        prior_run_id: run.then(|| RunId(Uuid::from_u128(7))),
        terminal_event_id: run.then(|| EventId(Uuid::from_u128(8))),
        abandoned_run_ids: Vec::new(),
        failed_run_ids: Vec::new(),
        open_failure_cause: cause,
        restored_window_id: None,
        hard_deadline_passed: false,
    })
}

fn manager(window_id: Uuid, generation: u64, state: WindowState) -> ManagerReceipt {
    let retired = state == WindowState::Retired;
    ManagerReceipt::Window(Box::new(WindowReceipt {
        owner_id: OwnerId(Uuid::from_u128(1)),
        conversation_id: ConversationId(Uuid::from_u128(2)),
        window_id,
        generation,
        state,
        attempts: 0,
        reserved_bytes: 0,
        boot_id: Uuid::from_u128(4),
        opened_at_ms: 1000,
        work_deadline_ms: 871_000,
        expires_at_ms: 901_000,
        limits: ExecutionWindowLimits::default(),
        reason: retired.then(|| "runtime_refused".into()),
        outcome: retired.then_some(TerminalOutcome::Failed),
        run_id: None,
        terminal_event_id: None,
    }))
}

#[test]
fn a_window_the_manager_never_admitted_is_committed_locally() {
    // 2026-10-26: generation 1 failed at Fast setup and retired at the
    // manager; generation 2 was refused at admission and has no credential.
    let stuck = window(2, NOW - UNADMITTED_MIN_AGE_MS);
    let unissued = plan(Some(Cause::CredentialUnissued), false);
    let previous = manager(Uuid::from_u128(31), 1, WindowState::Retired);
    assert!(local_commit_allowed(
        &unissued,
        &stuck,
        NOW,
        Some(&previous)
    ));
    let idle = ManagerReceipt::Idle {
        owner_id: OwnerId(Uuid::from_u128(1)),
        conversation_id: ConversationId(Uuid::from_u128(2)),
    };
    assert!(local_commit_allowed(&unissued, &stuck, NOW, Some(&idle)));
}

#[test]
fn any_doubt_keeps_the_manager_first_path() {
    let stuck = window(2, NOW - UNADMITTED_MIN_AGE_MS);
    let unissued = plan(Some(Cause::CredentialUnissued), false);
    let retired = manager(Uuid::from_u128(31), 1, WindowState::Retired);
    // No manager answer.
    assert!(!local_commit_allowed(&unissued, &stuck, NOW, None));
    // An admission may still be in flight for a young window.
    assert!(!local_commit_allowed(
        &unissued,
        &window(2, NOW - 1),
        NOW,
        Some(&retired)
    ));
    // The manager admitted this very window, or a later or unretired one.
    for receipt in [
        manager(stuck.window_id, 2, WindowState::Reconciliation),
        manager(stuck.window_id, 2, WindowState::Retired),
        manager(Uuid::from_u128(99), 2, WindowState::Retired),
        manager(Uuid::from_u128(31), 1, WindowState::Reconciliation),
        manager(Uuid::from_u128(31), 1, WindowState::Expired),
    ] {
        assert!(!local_commit_allowed(
            &unissued,
            &stuck,
            NOW,
            Some(&receipt)
        ));
    }
    // A credential was issued (so the manager acknowledged), or a run exists.
    for shape in [
        plan(Some(Cause::CredentialUnbound), false),
        plan(Some(Cause::SetupIncomplete), false),
        plan(Some(Cause::CredentialUnissued), true),
        plan(None, false),
    ] {
        assert!(!local_commit_allowed(&shape, &stuck, NOW, Some(&retired)));
    }
}

#[test]
fn refused_reconcile_steps_are_logged_once_per_period() {
    let window = Uuid::from_u128(77);
    let start = Instant::now();
    assert_eq!(rate_limited(window, "cause", start).as_deref(), Some(""));
    assert_eq!(
        rate_limited(window, "cause", start + Duration::from_secs(1)),
        None
    );
    assert_eq!(
        rate_limited(window, "cause", start + Duration::from_secs(2)),
        None
    );
    // Another cause for the same window is its own line.
    assert!(rate_limited(window, "other", start + Duration::from_secs(2)).is_some());
    assert_eq!(
        rate_limited(window, "cause", start + LOG_PERIOD + Duration::from_secs(1)).as_deref(),
        Some(" suppressed=2")
    );
}
