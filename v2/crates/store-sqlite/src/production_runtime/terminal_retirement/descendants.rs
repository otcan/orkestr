//! Negative ledger gate only. Native-tree reap witnesses remain the trusted
//! server's obligation, including setup children with no durable run yet.
use super::*;

pub(in crate::production_runtime) async fn descendants_clear(
    tx: &mut sqlx::SqliteConnection,
    context: &str,
) -> Result<bool> {
    // Parent terminal triggers must have persisted pending tasks as held and
    // erased claim authority. Historical delegated tasks never become queued.
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_tasks WHERE context_id=? AND (state IN ('queued','claimed') OR claim_hash IS NOT NULL)")
        .bind(context).fetch_one(&mut *tx).await.map_err(db)?;
    if pending != 0 {
        return Ok(false);
    }
    // A blocked, never-admitted grant has no remaining dispatch locator. Every
    // admitted descendant requires its own exact canonical terminal evidence.
    let grants: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_provider_delegations d WHERE d.context_id=? AND NOT ((d.state='blocked' AND d.grant_hash IS NULL AND d.admitted_run_id IS NULL) OR (d.state IN ('admitted','blocked') AND d.grant_hash IS NULL AND EXISTS(SELECT 1 FROM production_runs r JOIN production_terminal_evidence t ON t.run_id=r.id WHERE r.id=d.admitted_run_id AND r.worker_delegation_id=d.id AND r.context_id=d.context_id AND r.session_id=d.worker_session_id)))")
        .bind(context).fetch_one(&mut *tx).await.map_err(db)?;
    if grants != 0 {
        return Ok(false);
    }
    // Confirmed Worker setup without a terminal run is unresolved even if its
    // binding later became Lost. Binding labels/expiry are not cleanup proof.
    let setup: i64 = sqlx::query_scalar("SELECT count(*) FROM production_readiness rd JOIN session_bindings b ON b.id=rd.session_id WHERE rd.context_id=? AND b.role='worker' AND NOT EXISTS(SELECT 1 FROM worker_task_failures f WHERE f.setup_session_id=b.id AND b.state='lost') AND NOT EXISTS(SELECT 1 FROM production_runs r JOIN production_terminal_evidence t ON t.run_id=r.id WHERE r.session_id=b.id AND r.context_id=rd.context_id AND b.generation=r.binding_generation+1)")
        .bind(context).fetch_one(&mut *tx).await.map_err(db)?;
    if setup != 0 {
        return Ok(false);
    }
    // Tool finish and cancellation acknowledgement are distinct sealed writers.
    // Expired, blocked, unconsumed and unknown tool effects cannot be promoted.
    let tools: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_tool_delegations d WHERE d.context_id=? AND NOT ((d.state IN ('completed','failed') AND d.outcome_digest IS NOT NULL) OR (d.state='cancelled' AND EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=d.parent_run_id AND t.terminal_kind='stopped')))")
        .bind(context).fetch_one(&mut *tx).await.map_err(db)?;
    if tools != 0 {
        return Ok(false);
    }
    // Even a completed sandbox can leave a native response suffix unresolved.
    // Only the sealed finish writer establishes full delivery, never a receipt.
    let results: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_tool_results x JOIN worker_tool_delegations d ON d.id=x.delegation_id WHERE d.context_id=? AND (x.state!='delivered' OR x.written_bytes=0)")
        .bind(context).fetch_one(&mut *tx).await.map_err(db)?;
    if results != 0 {
        return Ok(false);
    }
    // A Worker failed by audited reconciliation keeps its never-acknowledged
    // control as history; its process and lease are gone, nothing will answer.
    let controls: i64 = sqlx::query_scalar("SELECT count(*) FROM production_control_outbox o JOIN production_runs r ON r.id=o.run_id WHERE r.context_id=? AND o.state!='acknowledged' AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=o.run_id AND t.terminal_kind='failed')")
        .bind(context).fetch_one(&mut *tx).await.map_err(db)?;
    Ok(controls == 0)
}
