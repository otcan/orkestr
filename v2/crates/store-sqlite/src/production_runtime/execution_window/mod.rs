//! Finite private execution authority; the root manager alone reserves bytes/attempts.
use super::*;
use orkestr_v2_contracts::{
    ConversationId, EventId, ExecutionWindowAdmission, ExecutionWindowLimits,
    ExecutionWindowRequest, ExecutionWindowState, ExecutionWindowStatus, MessageId, RunId,
};
use sqlx::sqlite::SqliteRow;
mod admission;
mod bootstrap;
pub use bootstrap::ExecutionWindowBootstrap;
mod credential;
mod guard;
mod lifecycle;
pub use credential::{ExecutionWindowCredential, ExecutionWindowRetirement};
#[cfg(test)]
mod tests;

fn state(value: &str) -> Result<ExecutionWindowState> {
    Ok(match value {
        "opening" => ExecutionWindowState::Opening,
        "active" => ExecutionWindowState::Active,
        "retiring" => ExecutionWindowState::Retiring,
        "closed" => ExecutionWindowState::Closed,
        "reconciliation_required" => ExecutionWindowState::ReconciliationRequired,
        _ => return Err(RuntimeStoreError::Unavailable),
    })
}
fn status(row: &SqliteRow) -> Result<ExecutionWindowStatus> {
    Ok(ExecutionWindowStatus {
        window_id: row.get::<String, _>("id").parse().map_err(db)?,
        conversation_id: ConversationId(
            row.get::<String, _>("conversation_id")
                .parse()
                .map_err(db)?,
        ),
        generation: u64::try_from(row.get::<i64, _>("generation")).map_err(db)?,
        state: state(row.get("state"))?,
        input_message_id: MessageId(
            row.get::<String, _>("input_message_id")
                .parse()
                .map_err(db)?,
        ),
        input_event_id: EventId(row.get::<String, _>("input_event_id").parse().map_err(db)?),
        predecessor_window_id: row
            .get::<Option<String>, _>("predecessor_window_id")
            .map(|s| s.parse().map_err(db))
            .transpose()?,
        opened_at_ms: row.get("opened_at_ms"),
        work_deadline_ms: row.get("work_deadline_ms"),
        expires_at_ms: row.get("expires_at_ms"),
        limits: ExecutionWindowLimits::default(),
    })
}
async fn browser_owner(
    store: &Store,
    tx: &mut SqliteConnection,
    credential: &str,
) -> Result<OwnerId> {
    if store.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
        return Err(RuntimeStoreError::Unauthorized);
    }
    let owner: String = sqlx::query_scalar("SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch() AND NOT EXISTS(SELECT 1 FROM execution_windows w WHERE w.credential_hash=auth_sessions.token_hash)")
        .bind(crate::digest(credential)).fetch_optional(tx).await.map_err(db)?
        .ok_or(RuntimeStoreError::Unauthorized)?;
    Ok(OwnerId(owner.parse().map_err(db)?))
}
async fn window_in(
    tx: &mut SqliteConnection,
    c: &Context,
    window: Uuid,
    generation: u64,
) -> Result<SqliteRow> {
    if window.is_nil() || generation == 0 || generation >= 9_007_199_254_740_992 {
        return Err(RuntimeStoreError::InvalidInput);
    }
    sqlx::query("SELECT * FROM execution_windows WHERE id=? AND generation=? AND owner_id=?")
        .bind(window.to_string())
        .bind(generation as i64)
        .bind(c.owner.to_string())
        .fetch_optional(tx)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::NotFound)
}

#[cfg(test)]
mod terminal_tests;

#[cfg(test)]
mod bootstrap_tests;

mod retired_context;
pub use retired_context::RetiredExecutionWindowContext;

#[cfg(test)]
mod retired_process_tests;
