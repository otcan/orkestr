//! Owner side: issue, read, revoke and list agent-timer grants. Same design
//! as thread-ask grants (#341): shown once, only the hash stored, a new issue
//! rotates, revoke clears the hash and the generation never decreases.
use super::*;

fn grant_of(conversation: &ConversationId, row: Option<&SqliteRow>) -> AgentTimerGrant {
    match row {
        None => AgentTimerGrant {
            conversation_id: conversation.clone(),
            issued: false,
            generation: 0,
        },
        Some(row) => AgentTimerGrant {
            conversation_id: conversation.clone(),
            issued: row.get::<Option<String>, _>("grant_hash").is_some(),
            generation: row.get("generation"),
        },
    }
}
async fn grant_row(
    tx: &mut SqliteConnection,
    conversation: &ConversationId,
) -> R<Option<SqliteRow>> {
    sqlx::query("SELECT * FROM agent_timer_grants WHERE conversation_id=?")
        .bind(conversation.to_string())
        .fetch_optional(tx)
        .await
        .map_err(unavailable)
}

impl Store {
    pub async fn agent_timer_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<AgentTimerGrant> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let row = grant_row(&mut tx, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(grant_of(conversation, row.as_ref()))
    }

    /// Issue or rotate the conversation's grant. Shown once; the hash is stored.
    pub async fn issue_agent_timer_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<AgentTimerGrantIssued> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        if unavailable_conversation(&mut tx, owner, &conversation.to_string()).await? {
            return Err(ResourceError::Conflict(
                "agent_timer_conversation_unavailable",
            ));
        }
        let grant = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        sqlx::query("INSERT INTO agent_timer_grants(conversation_id,owner_id,grant_hash,generation,issued_ms) VALUES(?,?,?,1,?) ON CONFLICT(conversation_id) DO UPDATE SET grant_hash=excluded.grant_hash,generation=agent_timer_grants.generation+1,issued_ms=excluded.issued_ms")
            .bind(conversation.to_string()).bind(owner.to_string()).bind(grant_hash(&grant)).bind(now_ms())
            .execute(&mut *tx).await.map_err(unavailable)?;
        let row = grant_row(&mut tx, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(AgentTimerGrantIssued {
            grant,
            binding: grant_of(conversation, row.as_ref()),
        })
    }

    pub async fn revoke_agent_timer_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<AgentTimerGrant> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        sqlx::query("UPDATE agent_timer_grants SET grant_hash=NULL WHERE conversation_id=?")
            .bind(conversation.to_string())
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        let row = grant_row(&mut tx, conversation)
            .await?
            .ok_or(ResourceError::NotFound)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(grant_of(conversation, Some(&row)))
    }

    /// Every conversation of the owner with its grant state, for provisioning.
    /// Never returns a grant value.
    pub async fn agent_timer_grant_directory(
        &self,
        credential: &str,
        owner: &OwnerId,
    ) -> R<AgentTimerGrantDirectory> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(ResourceError::Unauthorized);
        }
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(crate::digest(credential)).bind(owner.to_string())
            .fetch_one(&mut *tx).await.map_err(unavailable)?;
        if sessions != 1 {
            return Err(ResourceError::Unauthorized);
        }
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM conversations WHERE owner_id=? ORDER BY rowid LIMIT 1000",
        )
        .bind(owner.to_string())
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        let mut conversations = Vec::with_capacity(ids.len());
        for id in ids {
            let conversation = ConversationId(uuid(&id)?);
            let row = grant_row(&mut tx, &conversation).await?;
            conversations.push(AgentTimerGrantEntry {
                name: name(&mut tx, &id).await?,
                eligible: !unavailable_conversation(&mut tx, owner, &id).await?,
                grant: grant_of(&conversation, row.as_ref()),
                conversation_id: conversation,
            });
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(AgentTimerGrantDirectory { conversations })
    }
}
