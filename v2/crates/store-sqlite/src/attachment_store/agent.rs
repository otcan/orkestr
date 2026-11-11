//! Owner side of agent reply attachments (ORK-779): the manifest of a file
//! a running Deep turn of this conversation attached to its reply. Only a
//! manifest imported under `AGENT_ATTACHMENT_REQUEST_PREFIX` qualifies, so an
//! owner upload or a WhatsApp import is never mistaken for one.
use super::*;

impl Store {
    pub async fn agent_attachment_manifest_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        manifest: Uuid,
    ) -> Result<AttachmentManifest> {
        let mut tx = self
            .attachment_transaction(credential, owner, conversation, false)
            .await?;
        let agent: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM attachment_imports WHERE owner_id=? AND conversation_id=? AND manifest_id=? AND substr(request_key,1,?)=?",
        )
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .bind(manifest.to_string())
        .bind(AGENT_ATTACHMENT_REQUEST_PREFIX.len() as i64)
        .bind(AGENT_ATTACHMENT_REQUEST_PREFIX)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if agent != 1 {
            return Err(AttachmentError::NotFound);
        }
        let result = super::read::manifest_in(&mut tx, owner, conversation, manifest).await?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
}
