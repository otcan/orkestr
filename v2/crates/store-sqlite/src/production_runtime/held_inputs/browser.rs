//! Durable browser evidence, independent of the supervisor that recorded Stop.
use super::*;

impl Store {
    /// Authenticate the current owner session and conversation in the read
    /// transaction. No supervisor, window, dispatch or hold-release authority is
    /// reconstructed, including after clean retirement or a fresh Store open.
    pub async fn held_owner_inputs_for_browser(
        &self,
        credential: &str,
        conversation: &ConversationId,
        after_sequence: i64,
        limit: u32,
    ) -> Result<HeldOwnerInputPage> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if conversation.0.is_nil() || after_sequence < 0 || !(1..=100).contains(&limit) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner: String = sqlx::query_scalar(
            "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
        )
        .bind(crate::digest(credential))
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::Unauthorized)?;
        let owner = OwnerId(owner.parse().map_err(db)?);
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let page = projection(&mut tx, &owner, conversation, after_sequence, limit, None).await?;
        if !page.is_valid() {
            return Err(RuntimeStoreError::Unavailable);
        }
        tx.commit().await.map_err(db)?;
        Ok(page)
    }
}
