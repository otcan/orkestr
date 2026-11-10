//! One authenticated conversation's V1 link, without sidebar activity/previews.
use super::*;

impl Store {
    /// Whether any of the owner's conversations stands for this V1 thread:
    /// its lineage, or the source the sidebar reports (first archived source,
    /// else the "New WhatsApp chat" provision). Per-conversation keyed reads
    /// only, without the sidebar's activity, unread counts or previews.
    pub async fn v1_thread_linked(
        &self,
        credential: &str,
        owner: &OwnerId,
        thread: &str,
    ) -> Result<bool> {
        let mut tx = self.sidebar_scope(credential, owner, false).await?;
        let linked: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM conversation_directory d
             LEFT JOIN conversation_lineage l ON l.owner_id=d.owner_id AND l.conversation_id=d.conversation_id
             WHERE d.owner_id=?1 AND (l.source_thread_id=?2 OR coalesce(
              (SELECT s.source_thread_id FROM archived_history_sources s
               WHERE s.conversation_id=d.conversation_id AND s.owner_id=d.owner_id ORDER BY s.row_sequence LIMIT 1),
              (SELECT p.v1_thread_id FROM whatsapp_chat_provisions p
               WHERE p.owner_id=d.owner_id AND p.conversation_id=d.conversation_id))=?2))",
        )
        .bind(owner.to_string())
        .bind(thread)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(linked)
    }

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
