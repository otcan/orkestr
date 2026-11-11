//! Agent side of reply attachments (ORK-779): a running Deep turn stores
//! files of its own workspace in its OWN conversation's attachment store.
//!
//! Authority is the conversation's agent grant (the agent-timer grant): it
//! proves the caller is the Deep agent of this conversation, and it works
//! only while that conversation has a dispatched Deep run. Attaching a file
//! to the reply grants nothing beyond the reply itself: same conversation,
//! same audience, same turn. The conversation always comes from the grant and
//! the import's request key from `AGENT_ATTACHMENT_REQUEST_PREFIX`; the bytes
//! are stored exactly like an owner upload (sealed for the owner's browser
//! keys when enrolled). Idempotent per request key.
use super::*;
use crate::attachment_store::{import_in, validate_import, AttachmentError};
use orkestr_v2_contracts::{
    AttachmentImportReceipt, AttachmentImportRequest, AGENT_ATTACHMENT_REQUEST_PREFIX,
};

fn refused(error: AttachmentError) -> ResourceError {
    match error {
        AttachmentError::Invalid => ResourceError::Invalid,
        AttachmentError::Unauthorized => ResourceError::Unauthorized,
        AttachmentError::NotFound => ResourceError::NotFound,
        AttachmentError::EncryptionKeyRequired => {
            ResourceError::Conflict("attachment_encryption_key_required")
        }
        AttachmentError::Conflict | AttachmentError::Removed | AttachmentError::Inert => {
            ResourceError::Conflict("agent_attachment_conflict")
        }
        AttachmentError::Unavailable => ResourceError::Unavailable,
    }
}

impl Store {
    /// The owner of the grant's conversation, while a Deep turn of it runs.
    /// A read transaction, before the caller builds the import.
    pub async fn agent_attachment_owner(
        &self,
        grant: &str,
        conversation: &ConversationId,
    ) -> R<OwnerId> {
        let mut tx = self
            .agent_attachment_scope(grant, conversation, false)
            .await?;
        let owner = turn_owner(&mut tx, grant, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(owner)
    }

    /// Store the files in the grant's conversation. Returns the receipt and
    /// whether it replays an earlier upload with the same request key.
    pub async fn import_agent_attachments(
        &self,
        grant: &str,
        conversation: &ConversationId,
        request: &AttachmentImportRequest,
    ) -> R<(AttachmentImportReceipt, bool)> {
        if !request
            .request_key
            .strip_prefix(AGENT_ATTACHMENT_REQUEST_PREFIX)
            .is_some_and(|key| !key.is_empty())
        {
            return Err(ResourceError::Invalid);
        }
        let owner = request.target_manifest.owner_id.clone();
        // Hash and check the bytes before the write lock is taken.
        let valid = validate_import(request, &owner, conversation).map_err(refused)?;
        let mut tx = self
            .agent_attachment_scope(grant, conversation, true)
            .await?;
        if turn_owner(&mut tx, grant, conversation).await? != owner {
            return Err(ResourceError::NotFound);
        }
        let result = import_in(&mut tx, valid).await.map_err(refused)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    async fn agent_attachment_scope(
        &self,
        grant: &str,
        conversation: &ConversationId,
        write: bool,
    ) -> R<Transaction<'_, Sqlite>> {
        if self.authority.is_some() || !hex64(grant) {
            return Err(ResourceError::Unauthorized);
        }
        if conversation.0.is_nil() {
            return Err(ResourceError::Invalid);
        }
        self.pool
            .begin_with(if write { "BEGIN IMMEDIATE" } else { "BEGIN" })
            .await
            .map_err(unavailable)
    }
}

/// The grant's owner when its conversation is usable and has a running Deep
/// turn (Fast never satisfies this).
async fn turn_owner(
    tx: &mut Transaction<'_, Sqlite>,
    grant: &str,
    conversation: &ConversationId,
) -> R<OwnerId> {
    let caller = caller_in(tx, grant, conversation).await?;
    if unavailable_conversation(tx, &caller.owner, &conversation.to_string()).await? {
        return Err(ResourceError::Conflict(
            "agent_attachment_conversation_unavailable",
        ));
    }
    if running_deep(tx, &caller.owner, conversation)
        .await?
        .is_none()
    {
        return Err(ResourceError::Conflict("agent_attachment_no_running_turn"));
    }
    Ok(caller.owner)
}
