//! Owner-wide bindings, independent of the selected conversation.
use super::{unavailable, ResourceError, Result};
use crate::Store;
use orkestr_v2_contracts::{ConversationId, DesktopResourceBinding, OwnerId};
use sqlx::Row;
impl Store {
    pub async fn desktop_resource_bindings(
        &self,
        credential: &str,
        owner: &OwnerId,
    ) -> Result<Vec<DesktopResourceBinding>> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(ResourceError::Unauthorized);
        }
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let valid: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(crate::digest(credential)).bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(unavailable)?;
        if valid != 1 {
            return Err(ResourceError::Unauthorized);
        }
        let rows = sqlx::query("SELECT b.conversation_id,b.desktop_slugs,coalesce(d.name,b.conversation_id) AS name FROM desktop_bindings b JOIN conversations c ON c.id=b.conversation_id AND c.owner_id=b.owner_id LEFT JOIN conversation_directory d ON d.conversation_id=b.conversation_id AND d.owner_id=b.owner_id WHERE b.owner_id=? ORDER BY name LIMIT 1001")
            .bind(owner.to_string()).fetch_all(&mut *tx).await.map_err(unavailable)?;
        if rows.len() > 1000 {
            return Err(ResourceError::Unavailable);
        }
        let result = rows
            .into_iter()
            .map(|row| {
                Ok(DesktopResourceBinding {
                    conversation_id: ConversationId(
                        row.get::<String, _>("conversation_id")
                            .parse()
                            .map_err(unavailable)?,
                    ),
                    name: row.get("name"),
                    desktop_slugs: serde_json::from_str(
                        row.get::<String, _>("desktop_slugs").as_str(),
                    )
                    .map_err(unavailable)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use crate::conversation_resources::tests_settings::Case;
    use orkestr_v2_contracts::{DesktopBindingRequest, OwnerId};
    #[tokio::test]
    async fn inventory_bindings_span_chats_but_require_the_current_owner() {
        let f = Case::new().await;
        let second = f.conversation("second").await;
        for (id, thread, slug) in [
            (&f.conversation, "thread-a", "desk-a"),
            (&second, "thread-b", "desk-b"),
        ] {
            f.store
                .bind_desktops(
                    &f.token,
                    &f.owner,
                    id,
                    &DesktopBindingRequest {
                        expected_revision: 0,
                        v1_thread_id: thread.into(),
                        desktop_slugs: vec![slug.into()],
                    },
                )
                .await
                .unwrap();
        }
        let rows = f
            .store
            .desktop_resource_bindings(&f.token, &f.owner)
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.conversation_id == second));
        assert!(f
            .store
            .desktop_resource_bindings("wrong", &f.owner)
            .await
            .is_err());
        assert!(f
            .store
            .desktop_resource_bindings(&f.token, &OwnerId(uuid::Uuid::new_v4()))
            .await
            .is_err());
        f.store.revoke_session(&f.token).await.unwrap();
        assert!(f
            .store
            .desktop_resource_bindings(&f.token, &f.owner)
            .await
            .is_err());
        f.finish().await;
    }
}
