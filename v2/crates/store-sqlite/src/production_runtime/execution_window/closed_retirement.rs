//! Core's committed retirement of a closed window, for the manager replay.
//!
//! A window's ordinary close commits Core's retirement first and only then
//! asks the manager to retire the same window. When that manager call is
//! refused (2026-10-28: a Fast companion failed at the work deadline, so the
//! manager still owned its child, `owned_child_not_reaped`), the manager marks
//! the window uncertain while Core already holds it closed. No Core window is
//! then unfinished for it, so nothing ever reconciled the manager record, and
//! the manager refused every later admission of that conversation
//! (`previous_window_unretired`) — leaving Core's next window stuck
//! `reconciliation_required` with no credential.
//!
//! This read returns exactly the decision Core committed for that closed
//! window (`accepted` or `stopped`, its prior run and terminal event), so the
//! server can hand the manager the same decision. It never infers one: any
//! other close (an audited reconciliation or a failed open) returns None.
use super::*;
use orkestr_v2_contracts::ExecutionWindowTerminalOutcome as Outcome;

/// Core's committed retirement of one gracefully closed window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedExecutionWindowRetirement {
    pub outcome: Outcome,
    pub run_id: RunId,
    pub terminal_event_id: EventId,
}

impl Store {
    /// Owner-authenticated, read-only. `None` unless the exact window is
    /// closed by its own canonical retirement (never by reconciliation or as a
    /// failed open).
    pub async fn closed_execution_window_retirement_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        window: Uuid,
        generation: u64,
    ) -> Result<Option<ClosedExecutionWindowRetirement>> {
        if window.is_nil() || generation == 0 || generation >= 9_007_199_254_740_992 {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let row = sqlx::query("SELECT w.terminal_run_id AS run_id,t.event_id,t.terminal_kind FROM execution_windows w JOIN production_terminal_evidence t ON t.run_id=w.terminal_run_id JOIN production_retirement_provenance p ON p.prior_run_id=t.run_id AND p.terminal_event_id=t.event_id AND p.context_id=w.context_id AND p.incarnation_id=w.incarnation_id WHERE w.id=? AND w.owner_id=? AND w.conversation_id=? AND w.generation=? AND w.state='closed' AND w.credential_issued=1 AND w.credential_bound=1 AND NOT EXISTS(SELECT 1 FROM execution_window_reconciliations r WHERE r.window_id=w.id) AND NOT EXISTS(SELECT 1 FROM execution_window_open_failures f WHERE f.window_id=w.id)")
            .bind(window.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .bind(i64::try_from(generation).map_err(db)?)
            .fetch_optional(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        let Some(row) = row else {
            return Ok(None);
        };
        let outcome = match row.get::<&str, _>("terminal_kind") {
            "accepted" => Outcome::Accepted,
            "stopped" => Outcome::Stopped,
            _ => return Ok(None),
        };
        Ok(Some(ClosedExecutionWindowRetirement {
            outcome,
            run_id: RunId(row.get::<String, _>("run_id").parse().map_err(db)?),
            terminal_event_id: EventId(row.get::<String, _>("event_id").parse().map_err(db)?),
        }))
    }
}
