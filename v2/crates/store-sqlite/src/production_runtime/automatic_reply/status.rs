use super::*;

impl Store {
    /// Observed owner policy only. This read never issues producer/send authority.
    pub async fn automatic_reply_permissions_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        after_id: Option<Uuid>,
        limit: u16,
    ) -> Result<AutomaticReplyPermissionPage> {
        if !(1..=32).contains(&limit) || after_id.is_some_and(|id| id.is_nil()) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        owner_in(self, &mut tx, credential, conversation).await?;
        let rows = sqlx::query("SELECT id,generation,permission_revision,enabled FROM automatic_reply_routes WHERE conversation_id=? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?")
            .bind(conversation.to_string()).bind(after_id.map(|id| id.to_string()))
            .bind(after_id.map(|id| id.to_string())).bind(i64::from(limit)+1)
            .fetch_all(&mut *tx).await.map_err(db)?;
        let more = rows.len() > usize::from(limit);
        let routes = rows
            .iter()
            .take(usize::from(limit))
            .map(|row| {
                Ok(AutomaticReplyPermissionStatus {
                    route_id: row.get::<String, _>("id").parse().map_err(db)?,
                    route_generation: row.get("generation"),
                    permission_revision: row.get("permission_revision"),
                    enabled: row.get::<i64, _>("enabled") == 1,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let observed_at_ms =
            sqlx::query_scalar("SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)")
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        let next_after = if more {
            routes.last().map(|r| r.route_id)
        } else {
            None
        };
        tx.commit().await.map_err(db)?;
        Ok(AutomaticReplyPermissionPage {
            conversation_id: conversation.clone(),
            observed_at_ms,
            routes,
            next_after,
        })
    }
}
