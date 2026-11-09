//! One authenticated conversation's V1 link, without sidebar activity/previews.
use super::*;

impl Store {
    /// Same lineage/archive/provision precedence as `conversation_v1_links`,
    /// scoped to one current owner and conversation in one transaction.
    pub async fn conversation_v1_link(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<Option<String>> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let link: Option<Option<String>> = sqlx::query_scalar(
            "SELECT coalesce(l.source_thread_id,
             (SELECT s.source_thread_id FROM archived_history_sources s
              WHERE s.conversation_id=d.conversation_id AND s.owner_id=d.owner_id ORDER BY s.row_sequence LIMIT 1),
             (SELECT p.v1_thread_id FROM whatsapp_chat_provisions p
              WHERE p.owner_id=d.owner_id AND p.conversation_id=d.conversation_id))
             FROM conversation_directory d
             LEFT JOIN conversation_lineage l ON l.owner_id=d.owner_id AND l.conversation_id=d.conversation_id
             WHERE d.owner_id=? AND d.conversation_id=?",
        )
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(link.flatten())
    }
}
