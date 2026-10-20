//! Immutable reconciliation receipt, rebuilt from audit rows for replays.
use super::*;

pub(super) async fn receipt_in(
    tx: &mut SqliteConnection,
    window: &str,
    duplicate: bool,
) -> Result<ExecutionWindowReconciliation> {
    let row = sqlx::query("SELECT * FROM execution_window_reconciliations WHERE window_id=?")
        .bind(window)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    let id: String = row.get("id");
    let abandoned: Vec<String> = sqlx::query_scalar(
        "SELECT run_id FROM production_run_abandonments WHERE reconciliation_id=? ORDER BY run_id",
    )
    .bind(&id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;
    let released: Vec<String> = sqlx::query_scalar("SELECT event_id FROM execution_window_released_inputs WHERE reconciliation_id=? ORDER BY event_id")
        .bind(&id).fetch_all(&mut *tx).await.map_err(db)?;
    let parse = |s: &str| s.parse::<Uuid>().map_err(db);
    Ok(ExecutionWindowReconciliation {
        reconciliation_id: parse(&id)?,
        window_id: parse(window)?,
        conversation_id: ConversationId(parse(row.get("conversation_id"))?),
        generation: u64::try_from(row.get::<i64, _>("generation")).map_err(db)?,
        actor: match row.get::<&str, _>("actor") {
            "startup" => Actor::Startup,
            "owner" => Actor::Owner,
            _ => return Err(RuntimeStoreError::Unavailable),
        },
        decision: match row.get::<&str, _>("decision") {
            "abandon_unaccepted" => Decision::AbandonUnaccepted,
            "retire_resolved" => Decision::RetireResolved,
            _ => return Err(RuntimeStoreError::Unavailable),
        },
        outcome: Outcome::parse(row.get("outcome")).ok_or(RuntimeStoreError::Unavailable)?,
        prior_run_id: RunId(parse(row.get("prior_run_id"))?),
        terminal_event_id: EventId(parse(row.get("terminal_event_id"))?),
        abandoned_run_ids: abandoned
            .iter()
            .map(|s| Ok(RunId(parse(s)?)))
            .collect::<Result<_>>()?,
        released_input_event_ids: released
            .iter()
            .map(|s| Ok(EventId(parse(s)?)))
            .collect::<Result<_>>()?,
        reconciled_at_ms: row.get("reconciled_at_ms"),
        duplicate,
    })
}
