//! Mail intake bookkeeping: the configured mail source, the reader cursor
//! and recording one scan's classified messages in a single transaction
//! (ledger-checked, so concurrent or repeated scans never double-record).
use super::apply::{apply_one, ledger_has, ledger_record};
use super::{config, Result, TrackerCaller, TrackerConfig};
use crate::conversation_resources::{now_ms, unavailable, ResourceError};
use crate::Store;
use orkestr_v2_contracts::*;

/// One message of a scan, already classified by the recipe's rule pack.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ScannedMessage {
    pub message_ref: String,
    /// Events to record, or the reason the message was dropped.
    pub outcome: std::result::Result<Vec<TrackerEventInput>, String>,
}

/// What a recorded scan did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanRecord {
    pub changes: Vec<TrackerChange>,
    pub labelled: usize,
    pub dropped: usize,
    pub duplicates: usize,
}

const SOURCE_MAX: usize = 16_000;
const CURSOR_MAX: usize = 8_000_000;

impl Store {
    /// The tracker configuration (mail source, cursor) for a scan.
    pub async fn tracker_config(
        &self,
        caller: TrackerCaller<'_>,
        conversation: &ConversationId,
    ) -> Result<TrackerConfig> {
        let (mut tx, owner) = self.tracker_scope(caller, conversation, false).await?;
        let value = config(&mut tx, &owner, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }

    /// Set (or clear) the mail source; a changed source restarts the cursor.
    pub async fn set_tracker_source(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        source_json: Option<&str>,
    ) -> Result<TrackerConfig> {
        if source_json.is_some_and(|s| {
            s.len() > SOURCE_MAX || serde_json::from_str::<serde_json::Value>(s).is_err()
        }) {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let before = config(&mut tx, owner, conversation).await?;
        if before.source_json.as_deref() != source_json {
            let revision = before
                .source_revision
                .checked_add(1)
                .ok_or(ResourceError::Unavailable)?;
            sqlx::query("UPDATE tracker_unresolved_events SET state='quarantined' WHERE owner_id=? AND conversation_id=? AND state='pending'")
                .bind(owner.to_string()).bind(conversation.to_string()).execute(&mut *tx).await.map_err(unavailable)?;
            sqlx::query("UPDATE tracker_ledger SET outcome='quarantined_source' WHERE owner_id=? AND conversation_id=? AND outcome='unresolved'")
                .bind(owner.to_string()).bind(conversation.to_string()).execute(&mut *tx).await.map_err(unavailable)?;
            sqlx::query("UPDATE trackers SET source_json=?,source_revision=?,cursor_json=NULL,updated_ms=? WHERE owner_id=? AND conversation_id=?")
                .bind(source_json)
                .bind(revision)
                .bind(now_ms())
                .bind(owner.to_string())
                .bind(conversation.to_string())
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
        }
        let value = config(&mut tx, owner, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }

    /// Record one scan: every message is checked against the ledger inside
    /// this transaction, labelled ones become events, dropped ones are
    /// remembered with their reason; then the cursor and summary are saved.
    pub async fn record_tracker_scan(
        &self,
        caller: TrackerCaller<'_>,
        conversation: &ConversationId,
        expected_source_revision: i64,
        messages: &[ScannedMessage],
        cursor_json: &str,
        summary_json: &str,
    ) -> Result<ScanRecord> {
        if matches!(caller, TrackerCaller::Grant(_)) {
            return Err(ResourceError::Unauthorized);
        }
        validate(messages, cursor_json, summary_json)?;
        let (mut tx, owner) = self.tracker_scope(caller, conversation, true).await?;
        let record = record_in_transaction(
            &mut tx,
            &owner,
            conversation,
            expected_source_revision,
            messages,
            cursor_json,
            summary_json,
        )
        .await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(record)
    }
}

pub(crate) fn validate(
    messages: &[ScannedMessage],
    cursor_json: &str,
    summary_json: &str,
) -> Result<()> {
    if cursor_json.len() > CURSOR_MAX
        || summary_json.len() > SOURCE_MAX
        || serde_json::from_str::<serde_json::Value>(cursor_json).is_err()
        || serde_json::from_str::<serde_json::Value>(summary_json).is_err()
        || messages.len() > 500
        || messages.iter().any(|m| {
            m.message_ref.len() != 24
                || !m.message_ref.bytes().all(|b| b.is_ascii_hexdigit())
                || m.outcome.as_ref().is_ok_and(|events| {
                    events.is_empty()
                        || events.len() > TRACKER_EVENTS_PER_REQUEST
                        || events.iter().any(|e| {
                            !super::authority::valid_intake(e)
                                || e.message_ref.as_deref() != Some(m.message_ref.as_str())
                        })
                })
        })
    {
        return Err(ResourceError::Invalid);
    }
    Ok(())
}

/// Shared atomic writer. The caller supplies its independently authenticated
/// transaction and repeats its action/source/Stop/lease fences before commit.
pub(crate) async fn record_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    expected_source_revision: i64,
    messages: &[ScannedMessage],
    cursor_json: &str,
    summary_json: &str,
) -> Result<ScanRecord> {
    let config = config(tx, owner, conversation).await?;
    if config.source_revision != expected_source_revision {
        return Err(ResourceError::Conflict("tracker_source_revision_mismatch"));
    }
    let mut record = ScanRecord::default();
    for message in messages {
        if ledger_has(tx, owner, conversation, &message.message_ref).await? {
            record.duplicates += 1;
            continue;
        }
        match &message.outcome {
            Ok(events) => {
                record.labelled += 1;
                for event in events {
                    let change =
                        apply_one(tx, owner, conversation, &config.notify_on, event).await?;
                    record.changes.push(change);
                }
                ledger_record(tx, owner, conversation, &message.message_ref, "event").await?;
            }
            Err(reason) => {
                record.dropped += 1;
                ledger_record(tx, owner, conversation, &message.message_ref, reason).await?;
            }
        }
    }
    record
        .changes
        .extend(super::unresolved::reconsider(tx, owner, conversation, &config.notify_on).await?);
    let now = now_ms();
    sqlx::query("UPDATE trackers SET cursor_json=?,last_scan_ms=?,last_scan_json=?,updated_ms=? WHERE owner_id=? AND conversation_id=?")
            .bind(cursor_json)
            .bind(now)
            .bind(summary_json)
            .bind(now)
            .bind(owner.to_string())
            .bind(conversation.to_string())
            .execute(&mut **tx)
            .await
            .map_err(unavailable)?;
    Ok(record)
}
