//! Append-only archived legacy history attached to an owned native conversation.
//! Never writes messages, events, inbox, outbox or execution rows.
mod digest;
mod read;
#[cfg(test)]
mod tests;

use crate::{history_import::HistoryError, Store};
pub use digest::{archived_checksum_next, archived_message_canonical, archived_message_digest};
use orkestr_v2_contracts::*;
use sqlx::{Row, Sqlite, Transaction};

type Result<T> = std::result::Result<T, HistoryError>;
fn unavailable(_: impl std::fmt::Display) -> HistoryError {
    HistoryError::Unavailable
}

struct Source {
    row: i64,
    cursor: i64,
    count: i64,
    checksum: String,
}

impl Store {
    /// Authenticates the exact credential for `owner` and checks conversation
    /// ownership inside the caller's transaction.
    async fn archived_transaction(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        write: bool,
    ) -> Result<Transaction<'_, Sqlite>> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(HistoryError::Unauthorized);
        }
        if conversation.0.is_nil() {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self
            .pool
            .begin_with(if write { "BEGIN IMMEDIATE" } else { "BEGIN" })
            .await
            .map_err(unavailable)?;
        let sessions: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()",
        )
        .bind(crate::digest(credential))
        .bind(owner.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if sessions != 1 {
            return Err(HistoryError::Unauthorized);
        }
        let owned: i64 =
            sqlx::query_scalar("SELECT count(*) FROM conversations WHERE id=? AND owner_id=?")
                .bind(conversation.to_string())
                .bind(owner.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?;
        if owned != 1 {
            return Err(HistoryError::NotFound);
        }
        Ok(tx)
    }

    /// One atomic batch. Same content is a duplicate; changed content, a taken
    /// position or a gap-filling late arrival is quarantined, never overwritten.
    pub async fn import_archived_history(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: &ArchivedImportRequest,
    ) -> Result<ArchivedImportReceipt> {
        if !request.is_valid() {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self
            .archived_transaction(credential, owner, conversation, true)
            .await?;
        let mut source = source(&mut tx, owner, conversation, request).await?;
        let (mut inserted, mut duplicates, mut quarantined) = (0u32, 0u32, Vec::new());
        for message in &request.messages {
            let digest = archived_message_digest(message);
            let by_id = sqlx::query("SELECT content_digest FROM archived_history_messages WHERE source_row=? AND source_message_id=?")
                .bind(source.row).bind(&message.source_message_id)
                .fetch_optional(&mut *tx).await.map_err(unavailable)?;
            let reason = match by_id {
                Some(row) if row.get::<String, _>("content_digest") == digest => {
                    duplicates += 1;
                    continue;
                }
                Some(_) => "content_changed",
                None => {
                    let taken: i64 = sqlx::query_scalar("SELECT count(*) FROM archived_history_messages WHERE source_row=? AND source_position=?")
                        .bind(source.row).bind(message.source_position)
                        .fetch_one(&mut *tx).await.map_err(unavailable)?;
                    if taken != 0 {
                        "position_conflict"
                    } else if message.source_position <= source.cursor {
                        "out_of_order"
                    } else {
                        insert(&mut tx, &source, message, &digest, &request.snapshot_id).await?;
                        source.cursor = message.source_position;
                        source.count += 1;
                        source.checksum = archived_checksum_next(&source.checksum, &digest);
                        inserted += 1;
                        continue;
                    }
                }
            };
            let payload = serde_json::to_string(message).map_err(unavailable)?;
            sqlx::query("INSERT OR IGNORE INTO archived_history_quarantine(source_row,source_message_id,source_position,reason,content_digest,payload,snapshot_id) VALUES(?,?,?,?,?,?,?)")
                .bind(source.row).bind(&message.source_message_id).bind(message.source_position)
                .bind(reason).bind(&digest).bind(payload).bind(&request.snapshot_id)
                .execute(&mut *tx).await.map_err(unavailable)?;
            quarantined.push(ArchivedQuarantine {
                source_message_id: message.source_message_id.clone(),
                source_position: message.source_position,
                reason: reason.into(),
            });
        }
        sqlx::query("UPDATE archived_history_sources SET cursor=?,message_count=?,checksum=?,last_snapshot_id=? WHERE row_sequence=?")
            .bind(source.cursor).bind(source.count).bind(&source.checksum)
            .bind(&request.snapshot_id).bind(source.row)
            .execute(&mut *tx).await.map_err(unavailable)?;
        let status = read::source_status(&mut tx, source.row).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(ArchivedImportReceipt {
            conversation_id: conversation.clone(),
            inserted,
            duplicates,
            quarantined,
            source: status,
        })
    }
}

async fn source(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    request: &ArchivedImportRequest,
) -> Result<Source> {
    sqlx::query("INSERT OR IGNORE INTO archived_history_sources(owner_id,conversation_id,source_instance,source_thread_id,last_snapshot_id) VALUES(?,?,?,?,?)")
        .bind(owner.to_string()).bind(conversation.to_string())
        .bind(&request.source_instance).bind(&request.source_thread_id).bind(&request.snapshot_id)
        .execute(&mut **tx).await.map_err(unavailable)?;
    let row = sqlx::query("SELECT row_sequence,cursor,message_count,checksum FROM archived_history_sources WHERE owner_id=? AND conversation_id=? AND source_instance=? AND source_thread_id=?")
        .bind(owner.to_string()).bind(conversation.to_string())
        .bind(&request.source_instance).bind(&request.source_thread_id)
        .fetch_one(&mut **tx).await.map_err(unavailable)?;
    Ok(Source {
        row: row.get("row_sequence"),
        cursor: row.get("cursor"),
        count: row.get("message_count"),
        checksum: row.get("checksum"),
    })
}

async fn insert(
    tx: &mut Transaction<'_, Sqlite>,
    source: &Source,
    message: &ArchivedMessage,
    digest: &str,
    snapshot: &str,
) -> Result<()> {
    let attachments = serde_json::to_string(&message.attachments).map_err(unavailable)?;
    sqlx::query("INSERT INTO archived_history_messages(source_row,source_message_id,source_position,source_cursor,role,phase,state,source_kind,created_at,updated_at,text,attachments,content_digest,snapshot_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(source.row).bind(&message.source_message_id).bind(message.source_position)
        .bind(message.source_cursor).bind(&message.role).bind(&message.phase).bind(&message.state)
        .bind(&message.source_kind).bind(&message.created_at).bind(&message.updated_at)
        .bind(&message.text).bind(attachments).bind(digest).bind(snapshot)
        .execute(&mut **tx).await.map_err(unavailable)?;
    Ok(())
}
