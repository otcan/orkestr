//! Immutable reconciliation receipt, rebuilt from audit rows for replays.
use super::*;

fn parse(value: &str) -> Result<Uuid> {
    value.parse::<Uuid>().map_err(db)
}

fn actor(row: &SqliteRow) -> Result<Actor> {
    match row.get::<&str, _>("actor") {
        "startup" => Ok(Actor::Startup),
        "owner" => Ok(Actor::Owner),
        _ => Err(RuntimeStoreError::Unavailable),
    }
}

fn decision(row: &SqliteRow) -> Result<Decision> {
    match row.get::<&str, _>("decision") {
        "abandon_unaccepted" => Ok(Decision::AbandonUnaccepted),
        "retire_resolved" => Ok(Decision::RetireResolved),
        _ => Err(RuntimeStoreError::Unavailable),
    }
}

async fn ids(tx: &mut SqliteConnection, sql: &str, id: &str) -> Result<Vec<Uuid>> {
    let rows: Vec<String> = sqlx::query_scalar(sql)
        .bind(id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
    rows.iter().map(|s| parse(s)).collect()
}

pub(super) async fn receipt_in(
    tx: &mut SqliteConnection,
    window: &str,
    duplicate: bool,
) -> Result<ExecutionWindowReconciliation> {
    if let Some(row) = sqlx::query("SELECT * FROM execution_window_open_failures WHERE window_id=?")
        .bind(window)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
    {
        return open_receipt_in(tx, window, &row, duplicate).await;
    }
    let row = sqlx::query("SELECT * FROM execution_window_reconciliations WHERE window_id=?")
        .bind(window)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    let id: String = row.get("id");
    let abandoned = ids(
        tx,
        "SELECT run_id FROM production_run_abandonments WHERE reconciliation_id=? ORDER BY run_id",
        &id,
    )
    .await?;
    let failed = ids(
        tx,
        "SELECT run_id FROM production_run_failures WHERE reconciliation_id=? ORDER BY run_id",
        &id,
    )
    .await?;
    let released = ids(tx, "SELECT event_id FROM execution_window_released_inputs WHERE reconciliation_id=? ORDER BY event_id", &id).await?;
    Ok(ExecutionWindowReconciliation {
        reconciliation_id: parse(&id)?,
        window_id: parse(window)?,
        conversation_id: ConversationId(parse(row.get("conversation_id"))?),
        generation: u64::try_from(row.get::<i64, _>("generation")).map_err(db)?,
        actor: actor(&row)?,
        decision: decision(&row)?,
        outcome: Outcome::parse(row.get("outcome")).ok_or(RuntimeStoreError::Unavailable)?,
        prior_run_id: Some(RunId(parse(row.get("prior_run_id"))?)),
        terminal_event_id: Some(EventId(parse(row.get("terminal_event_id"))?)),
        abandoned_run_ids: abandoned.into_iter().map(RunId).collect(),
        failed_run_ids: failed.into_iter().map(RunId).collect(),
        open_failure_cause: None,
        restored_window_id: None,
        released_input_event_ids: released.into_iter().map(EventId).collect(),
        reconciled_at_ms: row.get("reconciled_at_ms"),
        duplicate,
    })
}

async fn open_receipt_in(
    tx: &mut SqliteConnection,
    window: &str,
    row: &SqliteRow,
    duplicate: bool,
) -> Result<ExecutionWindowReconciliation> {
    let id: String = row.get("id");
    let released = ids(tx, "SELECT event_id FROM execution_window_open_failure_inputs WHERE failure_id=? ORDER BY event_id", &id).await?;
    Ok(ExecutionWindowReconciliation {
        reconciliation_id: parse(&id)?,
        window_id: parse(window)?,
        conversation_id: ConversationId(parse(row.get("conversation_id"))?),
        generation: u64::try_from(row.get::<i64, _>("generation")).map_err(db)?,
        actor: actor(row)?,
        decision: decision(row)?,
        outcome: Outcome::Failed,
        prior_run_id: None,
        terminal_event_id: None,
        abandoned_run_ids: Vec::new(),
        failed_run_ids: Vec::new(),
        open_failure_cause: Some(
            Cause::parse(row.get("cause")).ok_or(RuntimeStoreError::Unavailable)?,
        ),
        restored_window_id: row
            .get::<Option<String>, _>("restored_window_id")
            .map(|s| parse(&s))
            .transpose()?,
        released_input_event_ids: released.into_iter().map(EventId).collect(),
        reconciled_at_ms: row.get("reconciled_at_ms"),
        duplicate,
    })
}
