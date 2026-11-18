//! Conversation snapshot pages. A client reconciles forward from a cursor
//! (`IntakeStore::snapshot`); a chat that shows only its newest messages reads
//! the newest page below a cursor instead (`Store::snapshot_before`), so
//! opening a long conversation never reads its whole history first.
use crate::intake::message_origin;
use crate::{db, parse, Store};
use orkestr_v2_application::{Result, StoreError};
use orkestr_v2_contracts::*;
use sqlx::{sqlite::SqliteRow, Row};

/// The visible messages of one conversation in `(lower, upper]`, in sequence
/// order. `newest_first` reads from the upper end; callers that return a
/// page reverse those rows back to sequence order.
pub(crate) fn snapshot_sql(newest_first: bool) -> String {
    // An attempt retired for re-admission is shown once, as its successor.
    format!(
        "SELECT m.id,m.sequence,m.actor_kind,m.text,m.request_key,r.reply_to,{},{} FROM messages m LEFT JOIN message_reply_to r ON r.message_id=m.id {} WHERE m.conversation_id=? AND m.owner_id=? AND m.sequence>? AND m.sequence<=? AND {} ORDER BY m.sequence{} LIMIT ?",
        crate::message_revisions::SNAPSHOT_COLUMNS,
        crate::message_retries::COLUMN,
        crate::message_revisions::SNAPSHOT_JOINS,
        crate::message_retries::VISIBLE,
        if newest_first { " DESC" } else { "" },
    )
}

/// One snapshot row as the contract message.
pub(crate) fn snapshot_message(r: &SqliteRow) -> Result<Message> {
    Ok(Message {
        message_id: MessageId(parse(r.get("id"))?),
        sequence: r.get("sequence"),
        actor_kind: r.get("actor_kind"),
        text: r.get("text"),
        reply_to: r
            .get::<Option<String>, _>("reply_to")
            .and_then(|json| serde_json::from_str(&json).ok()),
        origin: Some(message_origin(r.get("request_key")).into()),
        revisions: crate::message_revisions::snapshot_state(r),
        retry_of: r
            .get::<Option<String>, _>("retry_of")
            .map(|id| parse(id).map(MessageId))
            .transpose()?,
    })
}

impl Store {
    /// The newest `limit` (1..=100) visible messages with a sequence below
    /// `before`, oldest first. `before` above the conversation's watermark
    /// reads up to the watermark, so `i64::MAX` is the newest page.
    ///
    /// The page never carries a `next_cursor`: it ends at `before` or at the
    /// watermark (`last_sequence`, the cursor a live stream continues from).
    /// A full page means older messages may exist; read them with the first
    /// message's sequence as the next `before`.
    pub async fn snapshot_before(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        before: i64,
        limit: u32,
    ) -> Result<ConversationSnapshot> {
        let (scope, last_sequence) = self.scope(owner, conversation).await?;
        if before < 1 {
            return Err(StoreError::Invalid);
        }
        let limit = limit.clamp(1, 100);
        let upper = (before - 1).min(last_sequence);
        let mut rows = sqlx::query(&snapshot_sql(true))
            .bind(conversation.to_string())
            .bind(owner.to_string())
            .bind(0_i64)
            .bind(upper)
            .bind(limit)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?;
        rows.reverse();
        Ok(ConversationSnapshot {
            conversation_id: conversation.clone(),
            scope,
            messages: rows
                .iter()
                .map(snapshot_message)
                .collect::<Result<Vec<_>>>()?,
            next_cursor: None,
            last_sequence,
        })
    }
}

#[cfg(test)]
#[path = "snapshot_page_tests.rs"]
mod tests;
