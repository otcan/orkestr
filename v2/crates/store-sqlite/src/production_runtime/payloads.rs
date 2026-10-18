//! Payload reads/removal never grant runtime or effect authority.
use super::*;
use orkestr_v2_contracts::{ConversationId, PayloadId, ProviderPayload, RunId};
impl Store {
    /// The HTTP boundary supplies its authenticated owner; never trust a body owner.
    pub async fn provider_payload(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        id: &PayloadId,
    ) -> Result<ProviderPayload> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        crate::runtime::scope(&mut tx, owner, conversation).await?;
        if let Some(context) = &self.authority {
            if context.owner != *owner {
                return Err(RuntimeStoreError::Unauthorized);
            }
            context.authenticate(&mut tx).await?;
        }
        let row = sqlx::query("SELECT run_id,text FROM production_payloads WHERE id=? AND owner_id=? AND conversation_id=?")
            .bind(id.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
        Ok(ProviderPayload {
            payload_id: id.clone(),
            conversation_id: conversation.clone(),
            run_id: RunId(row.get::<String, _>("run_id").parse().map_err(db)?),
            text: row.get("text"),
        })
    }
    /// Idempotent logical removal. Canonical receipts/digests remain for replay.
    /// This is not a forensic-erasure promise for filesystem/WAL/backups.
    pub async fn remove_provider_payload(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        id: &PayloadId,
    ) -> Result<()> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        crate::runtime::scope(&mut tx, owner, conversation).await?;
        if let Some(context) = &self.authority {
            if context.owner != *owner {
                return Err(RuntimeStoreError::Unauthorized);
            }
            context.authenticate(&mut tx).await?;
        }
        let changed = sqlx::query("UPDATE production_payloads SET text=NULL WHERE id=? AND owner_id=? AND conversation_id=?")
            .bind(id.to_string()).bind(owner.to_string()).bind(conversation.to_string()).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::NotFound);
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }
}
