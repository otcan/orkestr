//! Canonical source selection is read-only and never claims the Deep inbox.
use super::*;
use orkestr_v2_contracts::{ConversationId, EventId, MessageId};

/// Locators only. Admission revalidates scope, holds, binding and uniqueness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FastSource {
    pub message_id: MessageId,
    pub event_id: EventId,
    pub sequence: i64,
}
impl Store {
    /// Exclusive journal-sequence cursor. Select the earliest immutable owner
    /// input not already scheduled as Fast and not held by Stop/timer authority.
    /// Timer inputs are presented too (the window's Fast lifecycle needs its
    /// input), but `consume_execution` gives Fast only a no-action note.
    /// Absence grants no readiness. A source selected before Stop can still be
    /// refused by admission; a caller must never convert that refusal to retry I/O.
    pub async fn next_fast_source(
        &self,
        credential: &str,
        conversation: &ConversationId,
        after_sequence: i64,
    ) -> Result<Option<FastSource>> {
        self.worker_credential(credential)?;
        if conversation.0.is_nil() || after_sequence < 0 {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let c = self.context()?;
        let mut tx = self.pool.begin().await.map_err(db)?;
        c.validate(&mut tx).await?;
        crate::runtime::scope(&mut tx, &c.owner, conversation).await?;
        let window = self
            .execution_window_input_in(&mut tx, conversation, None)
            .await?;
        let row = sqlx::query("SELECT e.id,e.message_id,e.sequence FROM events e JOIN messages m ON m.id=e.message_id WHERE e.owner_id=? AND e.conversation_id=? AND m.owner_id=e.owner_id AND m.conversation_id=e.conversation_id AND e.kind='message_accepted' AND m.actor_kind='owner' AND e.sequence>? AND (? IS NULL OR EXISTS(SELECT 1 FROM execution_window_inputs i WHERE i.window_id=? AND i.event_id=e.id)) AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.owner_id=e.owner_id AND r.event_id=e.id AND r.role='fast') AND NOT EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=e.id) ORDER BY e.sequence LIMIT 1")
            .bind(c.owner.to_string()).bind(conversation.to_string()).bind(after_sequence)
            .bind(&window).bind(&window)
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let result = row
            .map(|r| -> Result<_> {
                Ok(FastSource {
                    message_id: MessageId(r.get::<String, _>("message_id").parse().map_err(db)?),
                    event_id: EventId(r.get::<String, _>("id").parse().map_err(db)?),
                    sequence: r.get("sequence"),
                })
            })
            .transpose()?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
}
