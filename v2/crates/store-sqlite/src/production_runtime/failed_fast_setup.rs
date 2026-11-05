//! A reserved Fast admission can lapse before the provider receives it.
//! This is failed setup, not a completed turn or an unknown provider outcome.
//! Keep the run and its existing terminal/lapse evidence; never re-execute it.
use super::*;

pub(super) async fn only_lapsed_reservation(
    tx: &mut SqliteConnection,
    context: &str,
    incarnation: &str,
    window: Uuid,
) -> Result<bool> {
    // Deliberately narrow: one Fast, still reserved, no provider observation,
    // failed by the ordinary process-gone settlement from its starting state.
    // Any consumed dispatch, proposal, Deep/Worker or other run shape uses the
    // normal turn reconciliation path and cannot be relabeled as setup.
    let (total, eligible): (i64, i64) = sqlx::query_as(
        "SELECT count(*),coalesce(sum(CASE WHEN r.role='fast' AND r.state='cancelled' AND r.dispatch_state='reserved' AND EXISTS(SELECT 1 FROM production_terminal_evidence t JOIN production_run_lapses l ON l.run_id=t.run_id WHERE t.run_id=r.id AND t.terminal_kind='failed' AND t.event_id=r.event_id AND l.window_id=? AND l.cause='lease_expired_process_gone' AND l.prior_state='starting' AND l.evidence_event_id=r.event_id AND l.lease_generation=r.lease_generation AND l.dispatch_fence=r.dispatch_fence AND l.lease_deadline_ms=r.lease_deadline_ms AND l.binding_generation=r.binding_generation+1) AND NOT EXISTS(SELECT 1 FROM production_observations o WHERE o.run_id=r.id) THEN 1 ELSE 0 END),0) FROM production_runs r WHERE r.context_id=? AND r.incarnation_id=?",
    )
    .bind(window.to_string())
    .bind(context)
    .bind(incarnation)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    Ok(total == 1 && eligible == 1)
}

/// The already-reconciled setup may leave its unconsumed owner input queued.
/// Retirement preserves every failed run/lapse/window record. Derive the proof
/// from immutable Core rows, never from a caller-supplied assertion.
pub(super) async fn retirable_input(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &orkestr_v2_contracts::ConversationId,
    message: &orkestr_v2_contracts::MessageId,
    event: &str,
) -> Result<bool> {
    let proof = sqlx::query("SELECT w.id,w.context_id,w.incarnation_id FROM execution_windows w JOIN execution_window_open_failures f ON f.window_id=w.id AND f.owner_id=w.owner_id AND f.conversation_id=w.conversation_id AND f.generation=w.generation AND f.context_id=w.context_id AND f.failed_incarnation_id=w.incarnation_id JOIN execution_window_open_failure_inputs i ON i.failure_id=f.id AND i.window_id=w.id AND i.owner_id=w.owner_id AND i.conversation_id=w.conversation_id JOIN production_runs r ON r.context_id=w.context_id AND r.incarnation_id=w.incarnation_id AND r.owner_id=w.owner_id AND r.conversation_id=w.conversation_id AND r.event_id=i.event_id AND r.message_id=i.message_id WHERE w.owner_id=? AND w.conversation_id=? AND i.message_id=? AND i.event_id=? AND w.state='closed' AND w.terminal_run_id IS NULL AND f.cause='setup_incomplete' AND NOT EXISTS(SELECT 1 FROM execution_windows live WHERE live.owner_id=w.owner_id AND live.conversation_id=w.conversation_id AND live.state!='closed') AND NOT EXISTS(SELECT 1 FROM execution_window_queue q WHERE q.owner_id=w.owner_id AND q.conversation_id=w.conversation_id AND q.state NOT IN ('dispatched','withdrawn'))")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(message.to_string()).bind(event)
        .fetch_all(&mut *tx).await.map_err(db)?;
    if proof.len() != 1 {
        return Ok(false);
    }
    let row = &proof[0];
    let window: Uuid = row.get::<String, _>("id").parse().map_err(db)?;
    let context: String = row.get("context_id");
    let incarnation: String = row.get("incarnation_id");
    Ok(
        only_lapsed_reservation(tx, &context, &incarnation, window).await?
            && super::terminal_retirement::descendants_clear(tx, &context).await?,
    )
}

/// A first opening may retain its never-dispatched Fast failure. That evidence
/// is not a turn to resume. Every post-reset run must belong to exactly one
/// closed, audited failed opening and satisfy the same immutable lapse proof.
pub(super) async fn bootstrap_runs_clear(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &orkestr_v2_contracts::ConversationId,
    floor: i64,
) -> Result<bool> {
    let scopes: Vec<(String, String)> = sqlx::query_as("SELECT DISTINCT r.context_id,r.incarnation_id FROM production_runs r WHERE r.owner_id=? AND r.conversation_id=? AND NOT EXISTS(SELECT 1 FROM execution_windows w WHERE w.context_id=r.context_id AND w.incarnation_id=r.incarnation_id AND w.generation<=?)")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(floor)
        .fetch_all(&mut *tx).await.map_err(db)?;
    for (context, incarnation) in scopes {
        let windows: Vec<String> = sqlx::query_scalar("SELECT w.id FROM execution_windows w JOIN execution_window_open_failures f ON f.window_id=w.id AND f.owner_id=w.owner_id AND f.conversation_id=w.conversation_id AND f.generation=w.generation AND f.context_id=w.context_id AND f.failed_incarnation_id=w.incarnation_id WHERE w.owner_id=? AND w.conversation_id=? AND w.context_id=? AND w.incarnation_id=? AND w.generation>? AND w.state='closed' AND w.terminal_run_id IS NULL AND f.restored_window_id IS NULL AND f.cause='setup_incomplete'")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&context).bind(&incarnation).bind(floor)
            .fetch_all(&mut *tx).await.map_err(db)?;
        if windows.len() != 1 {
            return Ok(false);
        }
        let window = windows[0].parse().map_err(db)?;
        if !only_lapsed_reservation(tx, &context, &incarnation, window).await?
            || !super::terminal_retirement::descendants_clear(tx, &context).await?
        {
            return Ok(false);
        }
    }
    Ok(true)
}
