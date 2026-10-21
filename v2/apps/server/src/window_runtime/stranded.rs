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
use super::super::manager_client::{TerminalOutcome, Window};
use super::Controller;
use orkestr_v2_contracts::{
    ConversationId, ExecutionWindowReconciliation, ExecutionWindowReconciliationActor as Actor,
    ExecutionWindowReconciliationDecision as Decision, ExecutionWindowReconciliationRequest,
    ExecutionWindowState, ExecutionWindowStatus, ExecutionWindowTerminalOutcome as Outcome,
};
use orkestr_v2_store_sqlite::StrandedExecutionWindow;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) enum ReconcileError {
    /// The current conversation's task in this process still owns the window.
    LiveOwner,
    NotFound,
    /// Core or manager refused; the window stays exactly as it was.
    Refused,
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
            if window.expires_at_ms > now || self.live_owner(&window.conversation_id).await {
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
