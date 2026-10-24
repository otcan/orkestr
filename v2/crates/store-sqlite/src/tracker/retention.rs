//! Minimized durable intake evidence and visible retention/overflow counters.
use super::Result;
use crate::conversation_resources::{now_ms, unavailable};
use orkestr_v2_contracts::*;
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

pub(super) fn evidence_hash(value: Option<&str>) -> Option<String> {
    value.map(|value| {
        if value
            .strip_prefix("sha256:")
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            value.to_ascii_lowercase()
        } else {
            format!("sha256:{}", crate::digest(value))
        }
    })
}

pub(super) fn minimized(event: &TrackerEventInput) -> Result<String> {
    let mut event = event.clone();
    event.evidence = evidence_hash(event.evidence.as_deref());
    serde_json::to_string(&event).map_err(unavailable)
}

pub(super) async fn audit(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    event: &TrackerEventInput,
    reason: &str,
) -> Result<()> {
    let json = minimized(event)?;
    audit_digest(
        tx,
        owner,
        conversation,
        event.message_ref.as_deref(),
        &crate::digest(&json),
        Some(&json),
        reason,
    )
    .await
}

pub(super) async fn audit_digest(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    reference: Option<&str>,
    digest: &str,
    event_json: Option<&str>,
    reason: &str,
) -> Result<()> {
    sqlx::query("INSERT OR IGNORE INTO tracker_intake_audit(id,owner_id,conversation_id,message_ref,event_digest,event_json,reason,recorded_ms) VALUES(?,?,?,?,?,?,?,?)")
        .bind(Uuid::new_v4().to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .bind(reference).bind(digest).bind(event_json).bind(reason).bind(now_ms())
        .execute(&mut **tx).await.map_err(unavailable)?;
    Ok(())
}

pub(super) async fn backlog(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<TrackerBacklog> {
    let (o, c) = (owner.to_string(), conversation.to_string());
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM tracker_unresolved_events WHERE owner_id=? AND conversation_id=? AND state='pending'")
        .bind(&o).bind(&c).fetch_one(&mut **tx).await.map_err(unavailable)?;
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM tracker_rows r WHERE owner_id=? AND conversation_id=? AND NOT EXISTS(SELECT 1 FROM tracker_row_merges m WHERE m.absorb_id=r.id AND m.owner_id=r.owner_id AND m.conversation_id=r.conversation_id)")
        .bind(&o).bind(&c).fetch_one(&mut **tx).await.map_err(unavailable)?;
    let mut counts = Vec::new();
    for reason in ["unresolved_expired", "unresolved_capacity", "row_limit"] {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tracker_intake_audit WHERE owner_id=? AND conversation_id=? AND reason=?")
            .bind(&o).bind(&c).bind(reason).fetch_one(&mut **tx).await.map_err(unavailable)?;
        counts.push(count as u64);
    }
    Ok(TrackerBacklog {
        pending: pending as u32,
        expired: counts[0],
        evicted: counts[1],
        overflow: counts[2],
        full: pending >= super::unresolved::PENDING_MAX || active >= TRACKER_ROWS_MAX as i64,
    })
}
