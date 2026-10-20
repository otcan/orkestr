//! Verified reads. A stored row whose content no longer matches its digest is
//! reported as a conflict instead of being displayed.
use super::*;

const SOURCES_MAX: i64 = 1000;

pub(super) async fn source_status(
    tx: &mut Transaction<'_, Sqlite>,
    row: i64,
) -> Result<ArchivedSourceStatus> {
    let source = sqlx::query("SELECT s.source_instance,s.source_thread_id,s.last_snapshot_id,s.cursor,s.message_count,s.checksum,(SELECT count(*) FROM archived_history_messages m WHERE m.source_row=s.row_sequence) AS stored,(SELECT count(*) FROM archived_history_quarantine q WHERE q.source_row=s.row_sequence) AS quarantined FROM archived_history_sources s WHERE s.row_sequence=?")
        .bind(row).fetch_one(&mut **tx).await.map_err(unavailable)?;
    let count: i64 = source.get("message_count");
    if count != source.get::<i64, _>("stored") {
        return Err(HistoryError::Conflict);
    }
    Ok(ArchivedSourceStatus {
        source_instance: source.get("source_instance"),
        source_thread_id: source.get("source_thread_id"),
        last_snapshot_id: source.get("last_snapshot_id"),
        cursor: source.get("cursor"),
        message_count: count as u64,
        quarantined: source.get::<i64, _>("quarantined") as u64,
        checksum: source.get("checksum"),
    })
}

impl Store {
    pub async fn archived_history_status(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<ArchivedHistoryStatus> {
        let mut tx = self
            .archived_transaction(credential, owner, conversation, false)
            .await?;
        let rows: Vec<i64> = sqlx::query_scalar("SELECT row_sequence FROM archived_history_sources WHERE owner_id=? AND conversation_id=? ORDER BY row_sequence LIMIT ?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(SOURCES_MAX)
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        let mut sources = Vec::with_capacity(rows.len());
        for row in rows {
            sources.push(source_status(&mut tx, row).await?);
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(ArchivedHistoryStatus {
            conversation_id: conversation.clone(),
            sources,
        })
    }

    pub async fn archived_history_page(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        after: i64,
        limit: u32,
    ) -> Result<ArchivedHistoryPage> {
        if after < 0 || !(1..=ARCHIVED_PAGE_MAX).contains(&limit) {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self
            .archived_transaction(credential, owner, conversation, false)
            .await?;
        let mut rows = sqlx::query("SELECT m.*,s.source_instance,s.source_thread_id FROM archived_history_messages m JOIN archived_history_sources s ON s.row_sequence=m.source_row WHERE s.owner_id=? AND s.conversation_id=? AND m.archive_sequence>? ORDER BY m.archive_sequence LIMIT ?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(after).bind(limit + 1)
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let entries = rows.iter().map(entry).collect::<Result<Vec<_>>>()?;
        Ok(ArchivedHistoryPage {
            conversation_id: conversation.clone(),
            next_after: if more {
                entries.last().map(|e| e.archive_sequence)
            } else {
                None
            },
            entries,
        })
    }
}

fn entry(row: &sqlx::sqlite::SqliteRow) -> Result<ArchivedEntry> {
    let attachments: String = row.get("attachments");
    let message = ArchivedMessage {
        source_message_id: row.get("source_message_id"),
        source_position: row.get("source_position"),
        source_cursor: row.get("source_cursor"),
        role: row.get("role"),
        phase: row.get("phase"),
        state: row.get("state"),
        source_kind: row.get("source_kind"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        text: row.get("text"),
        attachments: serde_json::from_str(&attachments).map_err(|_| HistoryError::Conflict)?,
    };
    if !message.is_valid()
        || archived_message_digest(&message) != row.get::<String, _>("content_digest")
    {
        return Err(HistoryError::Conflict);
    }
    Ok(ArchivedEntry {
        archive_sequence: row.get("archive_sequence"),
        source_instance: row.get("source_instance"),
        source_thread_id: row.get("source_thread_id"),
        snapshot_id: row.get("snapshot_id"),
        message,
    })
}
