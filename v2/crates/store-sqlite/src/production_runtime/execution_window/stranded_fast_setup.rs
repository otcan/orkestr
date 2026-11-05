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
        "SELECT count(*),coalesce(sum(CASE WHEN r.role='fast' AND r.state='cancelled' AND r.dispatch_state='reserved' AND EXISTS(SELECT 1 FROM production_terminal_evidence t JOIN production_run_lapses l ON l.run_id=t.run_id WHERE t.run_id=r.id AND t.terminal_kind='failed' AND t.event_id=r.event_id AND l.window_id=? AND l.cause='lease_expired_process_gone' AND l.prior_state='starting' AND l.evidence_event_id=r.event_id) AND NOT EXISTS(SELECT 1 FROM production_observations o WHERE o.run_id=r.id) THEN 1 ELSE 0 END),0) FROM production_runs r WHERE r.context_id=? AND r.incarnation_id=?",
    )
    .bind(window.to_string())
    .bind(context)
    .bind(incarnation)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    Ok(total == 1 && eligible == 1)
}
