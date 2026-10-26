//! Windows the manager never admitted, and the reconcile log.
//!
//! Core makes an opening durable before manager IPC. When the manager then
//! refuses the admission (2026-10-26: a timer retry reused its failed
//! window's request key and got `idempotency_conflict`), Core's window has no
//! manager record at all. Every reconcile step asked the manager to retire
//! that exact window first, which it refuses (`window_generation`), so the
//! conversation stayed `reconciliation_required` forever.
//!
//! Such a window holds nothing of the manager's: no admission, no budget, no
//! credential (Core never issues one before a fresh manager acknowledgement).
//! Core's failed-open decision is committed locally, without the manager call,
//! only when the manager's own status proves that: its latest window for the
//! conversation is an earlier generation and retired (or it has none), and
//! Core's plan is a failed open whose credential was never issued.
use super::super::Controller;
use crate::window_runtime::manager_client::{ManagerReceipt, WindowState};
use orkestr_v2_contracts::{
    ExecutionWindowOpenFailureCause as Cause, ExecutionWindowStatus,
    ExecutionWindowTerminalOutcome as Outcome,
};
use orkestr_v2_store_sqlite::StrandedExecutionWindow;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

/// A manager admission in flight has a 5 s client deadline. Waiting well past
/// it before trusting "never admitted" keeps a slow reply from racing the
/// local close.
pub(super) const UNADMITTED_MIN_AGE_MS: i64 = 60_000;
/// One line per window and cause in this period; later repeats are counted.
const LOG_PERIOD: Duration = Duration::from_secs(600);

/// Whether a plan is the shape a never-admitted window can have: a failed
/// open naming no run, whose private credential was never issued.
pub(super) fn unadmitted_shape(plan: &StrandedExecutionWindow) -> bool {
    let (outcome, cause, run, event) = match plan {
        StrandedExecutionWindow::Pending(p) => (
            p.outcome,
            p.open_failure_cause,
            p.prior_run_id.is_some(),
            p.terminal_event_id.is_some(),
        ),
        StrandedExecutionWindow::Reconciled(r) => (
            r.outcome,
            r.open_failure_cause,
            r.prior_run_id.is_some(),
            r.terminal_event_id.is_some(),
        ),
    };
    outcome == Outcome::Failed && cause == Some(Cause::CredentialUnissued) && !run && !event
}

/// The manager's status proves it never admitted `window`: it has nothing
/// for the conversation, or its latest window is an earlier, retired one.
pub(super) fn never_admitted(receipt: &ManagerReceipt, window: &ExecutionWindowStatus) -> bool {
    match receipt {
        ManagerReceipt::Idle { .. } => true,
        ManagerReceipt::Window(r) => {
            r.window_id != window.window_id
                && r.generation < window.generation
                && r.state == WindowState::Retired
        }
    }
}

/// Core may commit this plan without the manager call. Any doubt (no
/// manager answer, a young window, another plan shape) keeps the ordinary
/// manager-first path.
pub(super) fn local_commit_allowed(
    plan: &StrandedExecutionWindow,
    window: &ExecutionWindowStatus,
    now_ms: i64,
    manager: Option<&ManagerReceipt>,
) -> bool {
    candidate(plan, window, now_ms)
        && manager.is_some_and(|receipt| never_admitted(receipt, window))
}

fn candidate(plan: &StrandedExecutionWindow, window: &ExecutionWindowStatus, now_ms: i64) -> bool {
    unadmitted_shape(plan) && window.opened_at_ms.saturating_add(UNADMITTED_MIN_AGE_MS) <= now_ms
}

impl Controller {
    /// Ask the manager whether it ever admitted this window (see
    /// `local_commit_allowed`). Only the never-admitted shape asks at all.
    pub(super) async fn manager_never_admitted(
        &self,
        window: &ExecutionWindowStatus,
        plan: &StrandedExecutionWindow,
        now_ms: i64,
    ) -> bool {
        if !candidate(plan, window, now_ms) {
            return false;
        }
        let Ok(manager) = self
            .manager
            .for_conversation(window.conversation_id.clone())
        else {
            return false;
        };
        let receipt = manager
            .status(
                &format!("unadmitted:{}", uuid::Uuid::new_v4()),
                Instant::now() + Duration::from_secs(5),
            )
            .await
            .ok();
        local_commit_allowed(plan, window, now_ms, receipt.as_ref())
    }
}

/// (window, cause) -> (last line, repeats suppressed since).
type Recent = HashMap<(uuid::Uuid, &'static str), (Instant, u64)>;
static RECENT: OnceLock<Mutex<Recent>> = OnceLock::new();

/// Warn about a reconcile step that was refused, at most once per window and
/// cause per period. Identifiers and closed static causes only.
pub(super) fn warn_refused(
    step: &'static str,
    window: &ExecutionWindowStatus,
    cause: &'static str,
) {
    if let Some(line) = rate_limited(window.window_id, cause, Instant::now()) {
        eprintln!(
            "WARN orkestr-v2-server window_reconcile_refused step={step} conversation={} window={} generation={} cause=\"{cause}\"{line}",
            window.conversation_id, window.window_id, window.generation,
        );
    }
}

/// `Some(suffix)` when a line is due; the suffix counts suppressed repeats.
fn rate_limited(window: uuid::Uuid, cause: &'static str, now: Instant) -> Option<String> {
    let mut recent = RECENT.get_or_init(Default::default).lock().ok()?;
    // Bounded: forget entries whose period ended.
    if recent.len() > 1024 {
        recent.retain(|_, (at, _)| now.duration_since(*at) < LOG_PERIOD);
    }
    match recent.get_mut(&(window, cause)) {
        Some((at, suppressed)) if now.duration_since(*at) < LOG_PERIOD => {
            *suppressed = suppressed.saturating_add(1);
            None
        }
        Some((at, suppressed)) => {
            let line = format!(" suppressed={suppressed}");
            *at = now;
            *suppressed = 0;
            Some(line)
        }
        None => {
            recent.insert((window, cause), (now, 0));
            Some(String::new())
        }
    }
}

#[cfg(test)]
#[path = "stranded_unadmitted_tests.rs"]
mod tests;
