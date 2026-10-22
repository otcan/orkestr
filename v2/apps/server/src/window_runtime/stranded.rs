//! Recovery of execution windows whose opening process incarnation is gone.
//!
//! The private window credential lives only in the opener's memory, so after
//! a restart `retire_execution_window` can never succeed and the window blocks
//! every later admission. This process owns at most the current conversation's
//! live task; any other unfinished window is stranded by construction.
//!
//! Order: Core negative mark -> Core read-only plan -> manager releases its
//! (already budget-less) record -> Core commits the audited decision. Manager
//! and Core steps are both idempotent, so a lost reply is retried safely and a
//! Core refusal never leaves Core closed while the manager still blocks.
//!
//! Besides proposals awaiting acceptance, Core also fails a Worker left
//! `cancel_requested` after its lease deadline, and closes a window whose open
//! failed before it ran anything as `failed` (restoring its retired
//! predecessor), so neither shape blocks the conversation any longer.
//!
//! Automatic recovery (`Actor::Startup`) runs on the first owner-authenticated
//! window request after start and only for windows past their hard deadline.
//! Core needs the owner's browser credential for every mutation, so there is
//! deliberately no credential-less boot-time path.
//!
//! A window whose open failed (for example a refused broker bind or Fast
//! setup) never ran anything of its own. The owner's next message to that
//! conversation is the owner's decision to continue: it closes exactly such a
//! failed open as `failed` (`Actor::Owner`, the same decision the explicit
//! endpoint records) instead of leaving the conversation blocked until the
//! hard deadline. Any other plan is left untouched for the deadline path.
use super::super::manager_client::{TerminalOutcome, Window};
use super::Controller;
use orkestr_v2_contracts::{
    ConversationId, ExecutionWindowReconciliation, ExecutionWindowReconciliationActor as Actor,
    ExecutionWindowReconciliationDecision as Decision, ExecutionWindowReconciliationRequest,
    ExecutionWindowState, ExecutionWindowStatus, ExecutionWindowTerminalOutcome as Outcome,
};
use orkestr_v2_store_sqlite::StrandedExecutionWindow;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Which plans a reconciliation attempt may carry out.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    /// Any plan Core allows for the actor.
    Any,
    /// Only a failed open (nothing of the window's own ever ran).
    FailedOpenOnly,
    /// Only a plan that abandons nothing the owner could still accept.
    NothingToAbandon,
}

pub(crate) enum ReconcileError {
    /// The current conversation's task in this process still owns the window.
    LiveOwner,
    NotFound,
    /// Core or manager refused; the window stays exactly as it was.
    Refused,
}

/// The operator alert for a committed failed open, in the `ALERT <source>
/// <kind> key=value` form the adapter's stall alerts use. Identifiers only:
/// never input text, tokens or paths. None for any other decision.
pub(in crate::window_runtime) fn open_failure_alert(
    receipt: &ExecutionWindowReconciliation,
    timer_retries: usize,
) -> Option<String> {
    let cause = receipt.open_failure_cause?;
    let actor = match receipt.actor {
        Actor::Startup => "startup",
        Actor::Owner => "owner",
    };
    Some(format!(
        "ALERT orkestr-v2-server window_open_failed conversation={} window={} generation={} cause={} actor={} released_inputs={} timer_retries={}",
        receipt.conversation_id,
        receipt.window_id,
        receipt.generation,
        cause.as_str(),
        actor,
        receipt.released_input_event_ids.len(),
        timer_retries,
    ))
}

impl Controller {
    /// Best-effort automatic path; the caller holds `self.opening`.
    pub(in crate::window_runtime) async fn reconcile_expired_locked(&self, browser: &str) {
        let Ok(windows) = self
            .store
            .unfinished_execution_windows_authenticated(browser)
            .await
        else {
            return;
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        for window in windows {
            if self.live_owner(&window.conversation_id).await {
                continue;
            }
            if window.expires_at_ms > now {
                // Before the deadline only a window whose task in this process
                // already ended with every original child reaped: its provider
                // is gone, so waiting for expiry only strands the conversation.
                if self.custody_released(&window.conversation_id).await {
                    let _ = self.reconcile_released(browser, &window).await;
                }
                continue;
            }
            // A refused window remains blocked exactly as before; the owner can
            // still use the explicit endpoint once the cause is understood.
            let _ = self
                .reconcile_one(
                    browser,
                    &window,
                    Decision::AbandonUnaccepted,
                    Actor::Startup,
                )
                .await;
        }
    }

    /// The owner's new message: close this conversation's failed open (and
    /// only a failed open) so this attempt can open the next window. The
    /// caller holds `self.opening`; a refusal leaves everything unchanged.
    pub(in crate::window_runtime) async fn reconcile_failed_open_locked(
        &self,
        browser: &str,
        conversation: &ConversationId,
    ) {
        if self.live_owner(conversation).await {
            return;
        }
        let Ok(Some(status)) = self
            .store
            .execution_window_status_authenticated(browser, conversation)
            .await
        else {
            return;
        };
        if status.state != ExecutionWindowState::ReconciliationRequired {
            return;
        }
        let _ = self
            .reconcile_planned(
                browser,
                &status,
                Decision::AbandonUnaccepted,
                Actor::Owner,
                Scope::FailedOpenOnly,
            )
            .await;
    }

    /// Whether this process ran (or observed) the conversation's window and
    /// now provably holds nothing of it.
    async fn custody_released(&self, conversation: &ConversationId) -> bool {
        match self.existing(conversation) {
            Some(entry) => entry.custody_released().await && entry.released_attempt_due(),
            None => false,
        }
    }

    /// Immediate reconciliation of a window whose provider is provably gone
    /// (this process's task ended and reaped every original child). The
    /// manager first closes the window's egress and reports it uncertain, so
    /// lapsed runs settle and its custody check passes; then Core may close it
    /// at once, but only when that abandons nothing the owner could still
    /// accept. Anything else keeps waiting for the owner or the deadline.
    async fn reconcile_released(
        &self,
        browser: &str,
        window: &ExecutionWindowStatus,
    ) -> Result<ExecutionWindowReconciliation, &'static str> {
        let manager = self
            .manager
            .for_conversation(window.conversation_id.clone())
            .map_err(|_| "manager scope refused")?;
        // Idempotent; a window the manager already retired or marked keeps
        // its committed state.
        let _ = manager
            .uncertain(
                &format!("released:{}", uuid::Uuid::new_v4()),
                &Window {
                    window_id: window.window_id,
                    generation: window.generation,
                },
                super::super::manager_client::Uncertainty::RuntimeRefused,
                Instant::now() + Duration::from_secs(5),
            )
            .await;
        self.reconcile_planned(
            browser,
            window,
            Decision::AbandonUnaccepted,
            Actor::Owner,
            Scope::NothingToAbandon,
        )
        .await
    }

    /// Owner-authenticated explicit decision (HTTP). Never touches a window
    /// that this process's current task still owns.
    pub(crate) async fn reconcile_owner(
        &self,
        browser: &str,
        conversation: &ConversationId,
        request: &ExecutionWindowReconciliationRequest,
    ) -> Result<ExecutionWindowReconciliation, ReconcileError> {
        let _opening = self.opening.lock().await;
        if self.live_owner(conversation).await {
            return Err(ReconcileError::LiveOwner);
        }
        let status = self
            .store
            .execution_window_status_authenticated(browser, conversation)
            .await
            .map_err(|_| ReconcileError::Refused)?
            .ok_or(ReconcileError::NotFound)?;
        if status.window_id != request.window_id || status.generation != request.generation {
            return Err(ReconcileError::NotFound);
        }
        self.reconcile_one(browser, &status, request.decision, Actor::Owner)
            .await
            .map_err(|_| ReconcileError::Refused)
    }

    async fn live_owner(&self, conversation: &ConversationId) -> bool {
        match self.existing(conversation) {
            Some(entry) => {
                // Observe a task that already ended (for example after its
                // Fast companion failed) before reporting it as the live
                // owner; otherwise the window could never be reconciled
                // without a restart. The result only says whether it needs
                // reconciliation, which is what follows.
                let _ = entry.refresh().await;
                entry.has_local_task().await
            }
            None => false,
        }
    }

    async fn reconcile_one(
        &self,
        browser: &str,
        window: &ExecutionWindowStatus,
        decision: Decision,
        actor: Actor,
    ) -> Result<ExecutionWindowReconciliation, &'static str> {
        self.reconcile_planned(browser, window, decision, actor, Scope::Any)
            .await
    }

    /// `scope` limits which planned decision may be carried out; a refused
    /// scope stops before any manager or Core decision.
    async fn reconcile_planned(
        &self,
        browser: &str,
        window: &ExecutionWindowStatus,
        decision: Decision,
        actor: Actor,
        scope: Scope,
    ) -> Result<ExecutionWindowReconciliation, &'static str> {
        let conversation = &window.conversation_id;
        if window.state != ExecutionWindowState::Closed
            && window.state != ExecutionWindowState::ReconciliationRequired
        {
            // Same negative-only mark a fresh process applies on status reads.
            self.store
                .reconcile_execution_window_authenticated(
                    browser,
                    conversation,
                    window.window_id,
                    window.generation,
                )
                .await
                .map_err(|_| "window reconciliation mark refused")?;
        }
        // Runs whose lease passed with their process gone become terminal
        // first, so a parent proposal waiting on them stays acceptable. This
        // process holds no custody (the caller checked); the manager must also
        // report no live budget for the window. A refusal changes nothing.
        if self.manager_released(window).await {
            let _ = self
                .store
                .settle_lapsed_runs_authenticated(
                    browser,
                    conversation,
                    window.window_id,
                    window.generation,
                    actor,
                )
                .await;
        }
        let plan = self
            .store
            .plan_stranded_execution_window_authenticated(
                browser,
                conversation,
                window.window_id,
                window.generation,
                decision,
                actor,
            )
            .await
            .map_err(|_| "stranded window plan refused")?;
        if scope == Scope::FailedOpenOnly
            && matches!(&plan, StrandedExecutionWindow::Pending(p) if p.open_failure_cause.is_none())
        {
            return Err("window ran turns; only its deadline or the owner decides");
        }
        if scope == Scope::NothingToAbandon
            && matches!(&plan, StrandedExecutionWindow::Pending(p) if !p.abandoned_run_ids.is_empty())
        {
            return Err("an acceptable proposal remains; only its deadline or the owner decides");
        }
        let (outcome, run, event) = match &plan {
            StrandedExecutionWindow::Pending(p) => (
                p.outcome,
                p.prior_run_id.clone(),
                p.terminal_event_id.clone(),
            ),
            StrandedExecutionWindow::Reconciled(r) => (
                r.outcome,
                r.prior_run_id.clone(),
                r.terminal_event_id.clone(),
            ),
        };
        let manager_outcome = match outcome {
            Outcome::Accepted => TerminalOutcome::Accepted,
            Outcome::Stopped => TerminalOutcome::Stopped,
            Outcome::Abandoned => TerminalOutcome::Abandoned,
            Outcome::Failed => TerminalOutcome::Failed,
        };
        // A failed open names no run; every other window names exactly one.
        let run = match (run, event) {
            (Some(run), Some(event)) => Some((run.0, event)),
            (None, None) => None,
            _ => return Err("stranded window plan is inconsistent"),
        };
        self.manager
            .for_conversation(conversation.clone())
            .map_err(|_| "manager scope refused")?
            .reconcile(
                &format!("reconcile:{}", uuid::Uuid::new_v4()),
                &Window {
                    window_id: window.window_id,
                    generation: window.generation,
                },
                manager_outcome,
                run,
                Instant::now() + Duration::from_secs(5),
            )
            .await
            .map_err(|_| "manager reconciliation refused")?;
        let receipt = match plan {
            StrandedExecutionWindow::Reconciled(receipt) => receipt,
            // Core commits only the exact decision the manager just recorded.
            StrandedExecutionWindow::Pending(p) => self
                .store
                .reconcile_stranded_execution_window_authenticated(browser, &p, decision, actor)
                .await
                .map_err(|_| "stranded window reconciliation refused")?,
        };
        if receipt.open_failure_cause.is_some() && !receipt.duplicate {
            // Every failed open, whatever opened the window, reaches the
            // operator once: the committed decision is the single place
            // that knows it. Timer occurrences queued again are named.
            let retried = match self
                .store
                .execution_window_queue_authenticated(browser, Some(conversation))
                .await
            {
                Ok(rows) => rows
                    .iter()
                    .filter(|row| {
                        receipt
                            .released_input_event_ids
                            .contains(&row.input_event_id)
                    })
                    .count(),
                Err(_) => 0,
            };
            if let Some(alert) = open_failure_alert(&receipt, retried) {
                eprintln!("{alert}");
            }
        }
        self.reset_current_if(conversation)?;
        Ok(receipt)
    }

    /// The manager holds no live budget (or custody) for this exact window.
    async fn manager_released(&self, window: &ExecutionWindowStatus) -> bool {
        let Ok(manager) = self
            .manager
            .for_conversation(window.conversation_id.clone())
        else {
            return false;
        };
        match manager
            .status(
                &format!("lapse:{}", uuid::Uuid::new_v4()),
                Instant::now() + Duration::from_secs(5),
            )
            .await
        {
            Ok(super::super::manager_client::ManagerReceipt::Window(receipt)) => {
                receipt.window_id == window.window_id
                    && receipt.generation == window.generation
                    && !matches!(
                        receipt.state,
                        super::super::manager_client::WindowState::Active
                            | super::super::manager_client::WindowState::Draining
                    )
            }
            _ => false,
        }
    }

    /// This conversation's local controller may be poisoned/released from
    /// observing the stranded window. Its window is now closed, so drop the
    /// entry: the next request builds a fresh idle controller (new handles,
    /// fresh one-shot authority). Queued intents may now be admitted.
    fn reset_current_if(&self, conversation: &ConversationId) -> Result<(), &'static str> {
        self.forget(conversation)?;
        self.queue.wake();
        Ok(())
    }
}

#[cfg(test)]
#[path = "stranded_alert_tests.rs"]
mod alert_tests;
