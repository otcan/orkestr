//! Bounded extracted evidence may await late Sent-mail thread provenance.
//! This never replays terminal drops or evidence from a superseded source.
use super::{apply::apply_one, Result};
use crate::conversation_resources::{now_ms, unavailable, ResourceError};
use orkestr_v2_contracts::*;
use sqlx::{Row, Sqlite, Transaction};

pub(super) const PENDING_MAX: i64 = 1000;
const RECONSIDER_MAX: i64 = 128;

pub(super) async fn save(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    event: &TrackerEventInput,
) -> Result<bool> {
    let json = super::retention::minimized(event)?;
    if json.len() > 16384 {
        return Err(ResourceError::Invalid);
    }
    let digest = crate::digest(&json);
    let reference = event.message_ref.as_deref().ok_or(ResourceError::Invalid)?;
    let existing: i64 = sqlx::query_scalar("SELECT count(*) FROM tracker_unresolved_events WHERE owner_id=? AND conversation_id=? AND message_ref=? AND event_digest=?")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(reference).bind(&digest)
        .fetch_one(&mut **tx).await.map_err(unavailable)?;
    if existing != 0 {
        return Ok(false);
    }
    expire(tx, owner, conversation).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tracker_unresolved_events WHERE owner_id=? AND conversation_id=? AND state='pending'")
        .bind(owner.to_string()).bind(conversation.to_string()).fetch_one(&mut **tx).await.map_err(unavailable)?;
    let full = count >= PENDING_MAX;
    if full {
        retire(
            tx,
            owner,
            conversation,
            "evicted",
            "unresolved_capacity",
            i64::MAX,
            1,
        )
        .await?;
    }
    sqlx::query("INSERT INTO tracker_unresolved_events(owner_id,conversation_id,message_ref,event_digest,event_json,source_revision,state,reason,recorded_ms) SELECT ?,?,?,?,?,source_revision,'pending','missing_known_thread',? FROM trackers WHERE owner_id=? AND conversation_id=?")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(reference).bind(&digest).bind(json)
        .bind(now_ms()).bind(owner.to_string()).bind(conversation.to_string())
        .execute(&mut **tx).await.map_err(unavailable)?;
    Ok(full)
}

pub(super) async fn reconsider(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    notify_on: &[TrackerEventKind],
) -> Result<Vec<TrackerChange>> {
    expire(tx, owner, conversation).await?;
    let rows = sqlx::query("SELECT u.message_ref,u.event_digest,u.event_json FROM tracker_unresolved_events u JOIN trackers t ON t.owner_id=u.owner_id AND t.conversation_id=u.conversation_id AND t.source_revision=u.source_revision WHERE u.owner_id=? AND u.conversation_id=? AND u.state='pending' ORDER BY u.attempt_order,u.recorded_ms,u.event_digest LIMIT ?")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(RECONSIDER_MAX)
        .fetch_all(&mut **tx).await.map_err(unavailable)?;
    let mut changes = Vec::new();
    let mut attempt: i64 = sqlx::query_scalar("SELECT coalesce(max(attempt_order),0) FROM tracker_unresolved_events WHERE owner_id=? AND conversation_id=?")
        .bind(owner.to_string()).bind(conversation.to_string()).fetch_one(&mut **tx).await.map_err(unavailable)?;
    for row in rows {
        let raw: String = row.get("event_json");
        let digest: String = row.get("event_digest");
        if crate::digest(&raw) != digest {
            return Err(ResourceError::Unavailable);
        }
        let event: TrackerEventInput = serde_json::from_str(&raw).map_err(unavailable)?;
        if !event.is_valid() || !event.requires_thread {
            return Err(ResourceError::Unavailable);
        }
        let change = apply_one(tx, owner, conversation, notify_on, &event).await?;
        if change.row_id.is_none() {
            attempt = attempt.checked_add(1).ok_or(ResourceError::Unavailable)?;
            sqlx::query("UPDATE tracker_unresolved_events SET attempt_order=? WHERE owner_id=? AND conversation_id=? AND message_ref=? AND event_digest=? AND state='pending'")
                .bind(attempt).bind(owner.to_string()).bind(conversation.to_string())
                .bind(row.get::<String,_>("message_ref")).bind(&digest)
                .execute(&mut **tx).await.map_err(unavailable)?;
            continue;
        }
        let row_id = change.row_id.ok_or(ResourceError::Unavailable)?;
        let evidence: String = sqlx::query_scalar("SELECT id FROM tracker_events WHERE owner_id=? AND conversation_id=? AND row_id=? AND message_ref IS ? AND kind=? AND occurred_ms=? AND classifier=? ORDER BY recorded_ms DESC,id DESC LIMIT 1")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(row_id.to_string())
            .bind(&event.message_ref).bind(event.kind.as_str()).bind(event.occurred_ms).bind(&event.classifier)
            .fetch_one(&mut **tx).await.map_err(unavailable)?;
        let won = sqlx::query("UPDATE tracker_unresolved_events SET state='resolved',resolved_event_id=? WHERE owner_id=? AND conversation_id=? AND message_ref=? AND event_digest=? AND state='pending'")
            .bind(evidence).bind(owner.to_string()).bind(conversation.to_string())
            .bind(row.get::<String,_>("message_ref")).bind(digest)
            .execute(&mut **tx).await.map_err(unavailable)?.rows_affected();
        if won != 1 {
            return Err(ResourceError::Conflict("tracker_unresolved_conflict"));
        }
        sqlx::query("UPDATE tracker_ledger SET outcome='event' WHERE owner_id=? AND conversation_id=? AND message_ref=? AND outcome='unresolved' AND NOT EXISTS(SELECT 1 FROM tracker_unresolved_events u WHERE u.owner_id=tracker_ledger.owner_id AND u.conversation_id=tracker_ledger.conversation_id AND u.message_ref=tracker_ledger.message_ref AND u.state='pending')")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(row.get::<String,_>("message_ref"))
            .execute(&mut **tx).await.map_err(unavailable)?;
        changes.push(change);
    }
    Ok(changes)
}

/// At most 128 old items retire per transaction; pending payloads are bounded to 1000.
async fn expire(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<()> {
    retire(
        tx,
        owner,
        conversation,
        "expired",
        "unresolved_expired",
        now_ms().saturating_sub(30 * 24 * 60 * 60 * 1000),
        RECONSIDER_MAX,
    )
    .await
}

async fn retire(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    state: &str,
    reason: &str,
    before: i64,
    limit: i64,
) -> Result<()> {
    let rows = sqlx::query("SELECT message_ref,event_digest FROM tracker_unresolved_events WHERE owner_id=? AND conversation_id=? AND state='pending' AND recorded_ms<? ORDER BY recorded_ms,message_ref,event_digest LIMIT ?")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(before).bind(limit)
        .fetch_all(&mut **tx).await.map_err(unavailable)?;
    for row in rows {
        let reference: String = row.get("message_ref");
        let digest: String = row.get("event_digest");
        super::retention::audit_digest(
            tx,
            owner,
            conversation,
            Some(&reference),
            &digest,
            None,
            reason,
        )
        .await?;
        sqlx::query("UPDATE tracker_unresolved_events SET state=? WHERE owner_id=? AND conversation_id=? AND message_ref=? AND event_digest=? AND state='pending'")
            .bind(state).bind(owner.to_string()).bind(conversation.to_string()).bind(&reference).bind(digest)
            .execute(&mut **tx).await.map_err(unavailable)?;
        sqlx::query("UPDATE tracker_ledger SET outcome=? WHERE owner_id=? AND conversation_id=? AND message_ref=? AND outcome='unresolved' AND NOT EXISTS(SELECT 1 FROM tracker_unresolved_events u WHERE u.owner_id=tracker_ledger.owner_id AND u.conversation_id=tracker_ledger.conversation_id AND u.message_ref=tracker_ledger.message_ref AND u.state='pending')")
            .bind(reason).bind(owner.to_string()).bind(conversation.to_string()).bind(reference)
            .execute(&mut **tx).await.map_err(unavailable)?;
    }
    Ok(())
}
