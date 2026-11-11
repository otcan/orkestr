//! One message per re-admitted owner input (ORK-780).
//!
//! The delivery adapter re-admits an owner input whose window ended before
//! anything of it ran: Core first retires that attempt for re-admission
//! (`owner_input_retirements`, reason `adapter_readmit`), then the adapter
//! admits the same input again under fresh keys and names the retired attempt
//! (`MessageRequest::retry_of`). Messages stay append-only; lists hide the
//! retired attempt instead:
//!
//! - The snapshot omits an attempt retired for re-admission once any later
//!   owner message exists (its successor, from the adapter's own retirement
//!   record, not from equal text). That also collapses attempts admitted
//!   before this link existed. An attempt whose successor never arrived
//!   stays visible.
//! - A successor names its link (`Message::retry_of`), so a live timeline
//!   that already shows the earlier attempt removes it.
//!
//! Two identical messages the owner really sent twice are never retired for
//! re-admission, so both stay.
use crate::Store;
use orkestr_v2_application::StoreError;
use orkestr_v2_contracts::{ConversationId, MessageId, OwnerId};

/// The retirement reason the adapter's re-admission records.
pub(crate) const READMISSION_REASON: &str = "adapter_readmit";

/// Snapshot filter on `messages m`: not an attempt superseded by re-admission.
pub(crate) const VISIBLE: &str = "NOT EXISTS(SELECT 1 FROM owner_input_retirements x WHERE x.message_id=m.id AND x.owner_id=m.owner_id AND x.reason='adapter_readmit' AND EXISTS(SELECT 1 FROM messages later WHERE later.conversation_id=m.conversation_id AND later.owner_id=m.owner_id AND later.actor_kind='owner' AND later.sequence>m.sequence))";

/// Snapshot column: the earlier attempt this message re-admits, if linked.
pub(crate) const COLUMN: &str =
    "(SELECT y.retry_of FROM message_retries y WHERE y.message_id=m.id) AS retry_of";

impl Store {
    /// Records that `message` re-admits `retry_of`. Only an exact earlier
    /// owner message of the same conversation that Core retired for
    /// re-admission qualifies; anything else records nothing. Idempotent: a
    /// replayed admission links once, and an attempt is retried at most once.
    pub async fn link_message_retry(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        message: &MessageId,
        retry_of: &MessageId,
    ) -> Result<bool, StoreError> {
        let linked = sqlx::query("INSERT OR IGNORE INTO message_retries(message_id,retry_of,owner_id,conversation_id,created_at_ms)
             SELECT n.id,p.id,n.owner_id,n.conversation_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
             FROM messages n JOIN messages p ON p.owner_id=n.owner_id AND p.conversation_id=n.conversation_id
             JOIN owner_input_retirements r ON r.message_id=p.id AND r.owner_id=p.owner_id AND r.conversation_id=p.conversation_id AND r.reason=?
             WHERE n.id=? AND p.id=? AND n.owner_id=? AND n.conversation_id=?
               AND n.actor_kind='owner' AND p.actor_kind='owner' AND p.sequence<n.sequence")
            .bind(READMISSION_REASON)
            .bind(message.to_string())
            .bind(retry_of.to_string())
            .bind(owner.to_string())
            .bind(conversation.to_string())
            .execute(&self.pool)
            .await
            .map_err(crate::db)?
            .rows_affected();
        Ok(linked == 1)
    }
}

#[cfg(test)]
#[path = "message_retries_tests.rs"]
mod tests;
