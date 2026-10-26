//! Ordinary durable schedule ledger. Claims are inert records, never execution admissions.
//! Core registers this child module and owns the authoritative SQL migration.
pub mod authority;
mod calendar;
pub mod calendar_timer;
mod claim;
mod control;
mod detail;
pub mod digest;
pub mod scan_action;
pub use calendar::local_time_label;
pub use detail::TimerDetail;
mod import;
pub mod input;
pub mod outcome;
pub mod policy;
mod policy_pause;
mod schedule;
mod target;
pub mod trigger;
pub use target::{TimerInputRecord, TimerListing, TimerTarget};
#[cfg(test)]
mod tests;
mod types;
mod zoned;

use super::{unavailable, HistoryError, Result};
use crate::Store;
pub use import::timer_source_digest;
use orkestr_v2_contracts::{ConversationId, OwnerId};
/// Deterministic delay of a timer's top-of-the-hour runs (see `schedule`).
pub use schedule::{spread_ms as timer_spread_ms, SPREAD_MAX_MS as TIMER_SPREAD_MAX_MS};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteRow, Row, Sqlite, Transaction};
pub use types::*;
use uuid::Uuid;

fn valid(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
async fn row(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
) -> Result<SqliteRow> {
    sqlx::query("SELECT * FROM dormant_timers WHERE owner_id=? AND namespace=?")
        .bind(owner.to_string())
        .bind(namespace.to_string())
        .fetch_optional(&mut **tx)
        .await
        .map_err(unavailable)?
        .ok_or(HistoryError::NotFound)
}
fn receipt(row: &SqliteRow) -> Result<TimerReceipt> {
    Ok(TimerReceipt {
        namespace: Uuid::parse_str(row.get("namespace")).map_err(unavailable)?,
        source_digest: row.get("source_digest"),
        state: TimerState::parse(row.get("state"))?,
        dormant_reason: row.get("dormant_reason"),
        revision: row.get("revision"),
        generation: row.get("generation"),
        next_due_ms: row.get("next_due_ms"),
    })
}
fn revision(value: i64) -> Result<i64> {
    value
        .checked_add(1)
        .filter(|v| *v > 0)
        .ok_or(HistoryError::Conflict)
}
async fn target(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<()> {
    if conversation.0.is_nil() {
        return Err(HistoryError::Invalid);
    }
    let exists: i64 =
        sqlx::query_scalar("SELECT count(*) FROM conversations WHERE id=? AND owner_id=?")
            .bind(conversation.to_string())
            .bind(owner.to_string())
            .fetch_one(&mut **tx)
            .await
            .map_err(unavailable)?;
    if exists != 1 {
        return Err(HistoryError::NotFound);
    }
    Ok(())
}
