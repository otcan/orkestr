use super::*;
impl Store {
    /// Trusted connector configuration only. No HTTP/provider caller may invoke
    /// route issuance. Replacement increments generation and disables permission.
    pub async fn bind_automatic_reply_route(
        &self,
        credential: &str,
        conversation: &ConversationId,
        route: Uuid,
        account_scope: &str,
        expected_generation: i64,
    ) -> Result<AutomaticReplyProducer> {
        if route.is_nil() || !text(account_scope, 512) || expected_generation < 0 {
            return Err(RuntimeStoreError::InvalidInput);
        }
        self.worker_credential(credential)?;
        let c = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        let scope: i64 =
            sqlx::query_scalar("SELECT count(*) FROM conversations WHERE id=? AND owner_id=?")
                .bind(conversation.to_string())
                .bind(c.owner.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if scope != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        let generation = expected_generation
            .checked_add(1)
            .ok_or(RuntimeStoreError::InvalidInput)?;
        if expected_generation == 0 {
            let exists: i64 =
                sqlx::query_scalar("SELECT count(*) FROM automatic_reply_routes WHERE id=?")
                    .bind(route.to_string())
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(db)?;
            if exists != 0 {
                return Err(RuntimeStoreError::Conflict);
            }
            sqlx::query("INSERT INTO automatic_reply_routes(id,owner_id,conversation_id,context_id,incarnation_id,account_scope,generation) VALUES(?,?,?,?,?,?,1)")
                .bind(route.to_string()).bind(c.owner.to_string()).bind(conversation.to_string()).bind(&c.id).bind(&c.incarnation).bind(account_scope).execute(&mut *tx).await.map_err(db)?;
        } else {
            let changed=sqlx::query("UPDATE automatic_reply_routes SET context_id=?,incarnation_id=?,account_scope=?,generation=?,enabled=0,permission_revision=permission_revision+1 WHERE id=? AND owner_id=? AND conversation_id=? AND generation=?")
                .bind(&c.id).bind(&c.incarnation).bind(account_scope).bind(generation).bind(route.to_string()).bind(c.owner.to_string()).bind(conversation.to_string()).bind(expected_generation).execute(&mut *tx).await.map_err(db)?.rows_affected();
            if changed != 1 {
                return Err(RuntimeStoreError::Conflict);
            }
        }
        tx.commit().await.map_err(db)?;
        Ok(AutomaticReplyProducer {
            context: c.clone(),
            conversation: conversation.clone(),
            route,
            generation,
            account_scope: account_scope.into(),
        })
    }
    pub async fn set_automatic_reply_permission_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        request: &AutomaticReplyPermissionRequest,
    ) -> Result<AutomaticReplyPermissionReceipt> {
        if request.route_id.is_nil()
            || request.expected_route_generation <= 0
            || request.expected_permission_revision < 0
            || !text(&request.request_key, 128)
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = owner_in(self, &mut tx, credential, conversation).await?;
        let valid:i64=sqlx::query_scalar("SELECT count(*) FROM automatic_reply_routes WHERE id=? AND owner_id=? AND conversation_id=?").bind(request.route_id.to_string()).bind(owner.to_string()).bind(conversation.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if valid != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        let json = serde_json::to_string(request).map_err(db)?;
        let old:Option<(String,String)>=sqlx::query_as("SELECT request_json,receipt_json FROM automatic_reply_permissions WHERE route_id=? AND request_key=?").bind(request.route_id.to_string()).bind(&request.request_key).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some((input, output)) = old {
            if input != json {
                return Err(RuntimeStoreError::Conflict);
            }
            return serde_json::from_str(&output).map_err(db);
        }
        let revision = request
            .expected_permission_revision
            .checked_add(1)
            .ok_or(RuntimeStoreError::InvalidInput)?;
        let changed=sqlx::query("UPDATE automatic_reply_routes SET enabled=?,permission_revision=? WHERE id=? AND generation=? AND permission_revision=?")
            .bind(request.enabled).bind(revision).bind(request.route_id.to_string()).bind(request.expected_route_generation).bind(request.expected_permission_revision).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Conflict);
        }
        let receipt = AutomaticReplyPermissionReceipt {
            conversation_id: conversation.clone(),
            route_id: request.route_id,
            route_generation: request.expected_route_generation,
            permission_revision: revision,
            enabled: request.enabled,
            request_key: request.request_key.clone(),
        };
        sqlx::query("INSERT INTO automatic_reply_permissions VALUES(?,?,?,?)")
            .bind(request.route_id.to_string())
            .bind(&request.request_key)
            .bind(json)
            .bind(serde_json::to_string(&receipt).map_err(db)?)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(receipt)
    }
}
