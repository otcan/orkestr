//! Owner side: issue, read and revoke the conversation's local-files grant.
//! Same design as the agent-timer grant: shown once, only the hash stored, a
//! new issue rotates, revoke clears the hash and the generation never
//! decreases. Revoking also fails every unfinished request of the
//! conversation, so the tab never performs one the agent can no longer see.
use super::*;

fn grant_of(conversation: &ConversationId, row: Option<&SqliteRow>) -> LocalFileGrant {
    match row {
        None => LocalFileGrant {
            conversation_id: conversation.clone(),
            issued: false,
            generation: 0,
        },
        Some(row) => LocalFileGrant {
            conversation_id: conversation.clone(),
            issued: row.get::<Option<String>, _>("grant_hash").is_some(),
            generation: row.get("generation"),
        },
    }
}
pub(super) async fn grant_row(
    tx: &mut SqliteConnection,
    conversation: &ConversationId,
) -> R<Option<SqliteRow>> {
    sqlx::query("SELECT * FROM local_file_grants WHERE conversation_id=?")
        .bind(conversation.to_string())
        .fetch_optional(tx)
        .await
        .map_err(unavailable)
}
pub(super) async fn grant_state(
    tx: &mut SqliteConnection,
    conversation: &ConversationId,
) -> R<LocalFileGrant> {
    let row = grant_row(tx, conversation).await?;
    Ok(grant_of(conversation, row.as_ref()))
}

impl Store {
    pub async fn local_file_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<LocalFileGrant> {
        let mut tx = self
            .local_files_scope(credential, owner, conversation, false, OWNER_KINDS)
            .await?;
        let grant = grant_state(&mut tx, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(grant)
    }

    /// Issue or rotate the conversation's grant. Shown once; the hash is stored.
    pub async fn issue_local_file_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<LocalFileGrantIssued> {
        let mut tx = self
            .local_files_scope(credential, owner, conversation, true, OWNER_KINDS)
            .await?;
        if unavailable_conversation(&mut tx, owner, &conversation.to_string()).await? {
            return Err(ResourceError::Conflict(
                "local_files_conversation_unavailable",
            ));
        }
        let grant = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        sqlx::query("INSERT INTO local_file_grants(conversation_id,owner_id,grant_hash,generation,issued_ms) VALUES(?,?,?,1,?) ON CONFLICT(conversation_id) DO UPDATE SET grant_hash=excluded.grant_hash,generation=local_file_grants.generation+1,issued_ms=excluded.issued_ms")
            .bind(conversation.to_string()).bind(owner.to_string()).bind(grant_hash(&grant)).bind(now_ms())
            .execute(&mut *tx).await.map_err(unavailable)?;
        let binding = grant_state(&mut tx, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(LocalFileGrantIssued { grant, binding })
    }

    pub async fn revoke_local_file_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<LocalFileGrant> {
        let mut tx = self
            .local_files_scope(credential, owner, conversation, true, OWNER_KINDS)
            .await?;
        sqlx::query("UPDATE local_file_grants SET grant_hash=NULL WHERE conversation_id=?")
            .bind(conversation.to_string())
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        fail_open(
            &mut tx,
            &conversation.to_string(),
            "local_files_grant_revoked",
            now_ms(),
        )
        .await?;
        let row = grant_row(&mut tx, conversation)
            .await?
            .ok_or(ResourceError::NotFound)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(grant_of(conversation, Some(&row)))
    }
}
