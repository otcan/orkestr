//! A Worker left `cancel_requested` after its lease deadline: its deadline
//! cancellation was issued but the process died before the acknowledgement.
//! Planned as FAILED (`cancel_unacknowledged`), never stopped or accepted.
use super::*;

/// A Worker whose deadline cancellation was never acknowledged.
pub(super) struct Fail {
    pub(super) run: String,
    pub(super) session: String,
    pub(super) binding_generation: i64,
    pub(super) cancellation: String,
    pub(super) lease_deadline: i64,
}

/// A Worker whose deadline cancellation was requested but never acknowledged.
/// Its lease deadline has passed, so Core already refuses every effect of the
/// lost child; only the exact issued cancellation receipt is evidence.
pub(super) async fn failed_worker(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    context: &str,
    r: &SqliteRow,
    clock: i64,
) -> Result<Fail> {
    let run: String = r.get("id");
    let lease_deadline: i64 = r.get("lease_deadline_ms");
    if r.get::<&str, _>("state") != "cancel_requested"
        || r.get::<&str, _>("dispatch_state") != "delivery_unknown"
        || r.get::<String, _>("owner_id") != owner.to_string()
        || r.get::<String, _>("conversation_id") != conversation.to_string()
        || lease_deadline > clock
    {
        return Err(RuntimeStoreError::Fenced);
    }
    let cancellation: String = sqlx::query_scalar("SELECT pc.event_id FROM production_cancellations pc JOIN events e ON e.id=pc.event_id WHERE pc.run_id=? AND pc.receipt_state='cancel_requested' AND pc.inflight_status='unknown' AND pc.lease_generation=? AND pc.dispatch_fence=? AND e.owner_id=? AND e.conversation_id=?")
        .bind(&run).bind(r.get::<i64, _>("lease_generation")).bind(r.get::<i64, _>("dispatch_fence"))
        .bind(owner.to_string()).bind(conversation.to_string())
        .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
    let lineage: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_provider_delegations d JOIN session_bindings b ON b.id=d.worker_session_id WHERE d.admitted_run_id=? AND d.context_id=? AND d.worker_session_id=? AND b.role='worker' AND b.generation=? AND b.state!='retired'")
        .bind(&run).bind(context).bind(r.get::<String, _>("session_id"))
        .bind(r.get::<i64, _>("binding_generation"))
        .fetch_one(&mut *tx).await.map_err(db)?;
    if lineage != 1 {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(Fail {
        run,
        session: r.get("session_id"),
        binding_generation: r.get("binding_generation"),
        cancellation,
        lease_deadline,
    })
}

/// `descendants_clear`, except for the Workers this plan will fail: their
/// unacknowledged control and their own pending tool effects (none allowed)
/// are rechecked by the commit's post-condition.
pub(super) async fn descendants_clear_except(
    tx: &mut SqliteConnection,
    context: &str,
    fail: &[Fail],
) -> Result<bool> {
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_tasks WHERE context_id=? AND (state IN ('queued','claimed') OR claim_hash IS NOT NULL)")
        .bind(context).fetch_one(&mut *tx).await.map_err(db)?;
    let tools: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_tool_delegations d WHERE d.context_id=? AND NOT ((d.state IN ('completed','failed') AND d.outcome_digest IS NOT NULL) OR (d.state='cancelled' AND EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=d.parent_run_id AND t.terminal_kind='stopped')))")
        .bind(context).fetch_one(&mut *tx).await.map_err(db)?;
    let results: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_tool_results x JOIN worker_tool_delegations d ON d.id=x.delegation_id WHERE d.context_id=? AND (x.state!='delivered' OR x.written_bytes=0)")
        .bind(context).fetch_one(&mut *tx).await.map_err(db)?;
    let controls: Vec<String> = sqlx::query_scalar("SELECT o.run_id FROM production_control_outbox o JOIN production_runs r ON r.id=o.run_id WHERE r.context_id=? AND o.state!='acknowledged'")
        .bind(context).fetch_all(&mut *tx).await.map_err(db)?;
    Ok(pending == 0
        && tools == 0
        && results == 0
        && controls
            .iter()
            .all(|run| fail.iter().any(|f| &f.run == run)))
}
