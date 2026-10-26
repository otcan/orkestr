//! Owner side (grants, list, cancel) and grant validation for the agent side.
use super::*;

fn grant_of(conversation: &ConversationId, row: Option<&SqliteRow>) -> R<ThreadAskGrant> {
    Ok(match row {
        None => ThreadAskGrant {
            conversation_id: conversation.clone(),
            issued: false,
            generation: 0,
            targets: None,
        },
        Some(row) => ThreadAskGrant {
            conversation_id: conversation.clone(),
            issued: row.get::<Option<String>, _>("grant_hash").is_some(),
            generation: row.get("generation"),
            targets: row
                .get::<Option<String>, _>("targets_json")
                .map(|t| serde_json::from_str(&t).map_err(unavailable))
                .transpose()?,
        },
    })
}
async fn grant_row(
    tx: &mut SqliteConnection,
    conversation: &ConversationId,
) -> R<Option<SqliteRow>> {
    sqlx::query("SELECT * FROM thread_ask_grants WHERE conversation_id=?")
        .bind(conversation.to_string())
        .fetch_optional(tx)
        .await
        .map_err(unavailable)
}
/// Grant check inside an existing transaction.
async fn caller_in(
    tx: &mut Transaction<'_, Sqlite>,
    grant: &str,
    conversation: &ConversationId,
) -> R<Caller> {
    let row = sqlx::query("SELECT owner_id,generation,targets_json FROM thread_ask_grants WHERE conversation_id=? AND grant_hash=?")
        .bind(conversation.to_string()).bind(grant_hash(grant))
        .fetch_optional(&mut **tx).await.map_err(unavailable)?
        .ok_or(ResourceError::Unauthorized)?;
    let owner = OwnerId(uuid(row.get("owner_id")).map_err(|_| ResourceError::Unauthorized)?);
    owned(tx, &owner, conversation).await?;
    let targets = row
        .get::<Option<String>, _>("targets_json")
        .map(|t| serde_json::from_str(&t).map_err(unavailable))
        .transpose()?;
    Ok(Caller {
        owner,
        generation: row.get("generation"),
        targets,
    })
}

impl Store {
    /// Validate the grant in a deferred read transaction. With `write`, the
    /// returned transaction is a fresh IMMEDIATE one that re-validated the
    /// grant, so an invalid grant can never take the write lock.
    pub(super) async fn thread_ask_scope(
        &self,
        grant: &str,
        conversation: &ConversationId,
        write: bool,
    ) -> R<(Transaction<'_, Sqlite>, Caller)> {
        if self.authority.is_some() || !hex64(grant) {
            return Err(ResourceError::Unauthorized);
        }
        if conversation.0.is_nil() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let caller = caller_in(&mut tx, grant, conversation).await?;
        if !write {
            return Ok((tx, caller));
        }
        tx.commit().await.map_err(unavailable)?;
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(unavailable)?;
        let caller = caller_in(&mut tx, grant, conversation).await?;
        Ok((tx, caller))
    }

    pub async fn thread_ask_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<ThreadAskGrant> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let row = grant_row(&mut tx, conversation).await?;
        let result = grant_of(conversation, row.as_ref())?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    /// Issue or rotate the conversation's grant. Shown once; the hash is stored.
    pub async fn issue_thread_ask_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: &ThreadAskGrantRequest,
    ) -> R<ThreadAskGrantIssued> {
        if !request.is_valid(conversation) {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        if unavailable_conversation(&mut tx, owner, &conversation.to_string()).await? {
            return Err(ResourceError::Conflict(
                "thread_ask_conversation_unavailable",
            ));
        }
        for target in request.targets.iter().flatten() {
            if owned(&mut tx, owner, target).await.is_err() {
                return Err(ResourceError::Conflict("thread_ask_target_not_found"));
            }
        }
        let grant = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let targets = request
            .targets
            .as_ref()
            .map(|t| serde_json::to_string(t).map_err(unavailable))
            .transpose()?;
        sqlx::query("INSERT INTO thread_ask_grants(conversation_id,owner_id,grant_hash,generation,targets_json,issued_ms) VALUES(?,?,?,1,?,?) ON CONFLICT(conversation_id) DO UPDATE SET grant_hash=excluded.grant_hash,generation=thread_ask_grants.generation+1,targets_json=excluded.targets_json,issued_ms=excluded.issued_ms")
            .bind(conversation.to_string()).bind(owner.to_string()).bind(grant_hash(&grant))
            .bind(targets).bind(now_ms())
            .execute(&mut *tx).await.map_err(unavailable)?;
        let row = grant_row(&mut tx, conversation).await?;
        let binding = grant_of(conversation, row.as_ref())?;
        tx.commit().await.map_err(unavailable)?;
        Ok(ThreadAskGrantIssued { grant, binding })
    }

    pub async fn revoke_thread_ask_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<ThreadAskGrant> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        sqlx::query("UPDATE thread_ask_grants SET grant_hash=NULL WHERE conversation_id=?")
            .bind(conversation.to_string())
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        let row = grant_row(&mut tx, conversation)
            .await?
            .ok_or(ResourceError::NotFound)?;
        let result = grant_of(conversation, Some(&row))?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    /// Owner-visible requests sent from or received by this conversation,
    /// newest first. Answers are not repeated here.
    pub async fn thread_asks_for_owner(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        limit: u16,
    ) -> R<ThreadAskList> {
        if !(1..=50).contains(&limit) {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let rows = sqlx::query("SELECT * FROM thread_asks WHERE owner_id=?1 AND (source_conversation_id=?2 OR target_conversation_id=?2) ORDER BY created_ms DESC,rowid DESC LIMIT ?3")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(i64::from(limit))
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        let mut asks = Vec::with_capacity(rows.len());
        for row in &rows {
            asks.push(view(&mut tx, row, None).await?);
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(ThreadAskList { asks })
    }

    /// Owner cancels an unsettled request sent from or to this conversation.
    /// It fails as `cancelled_by_owner`; an input no run took is retired.
    /// A settled request is returned unchanged.
    pub async fn cancel_thread_ask(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        ask: Uuid,
    ) -> R<ThreadAskView> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let row = sqlx::query("SELECT * FROM thread_asks WHERE id=?1 AND owner_id=?2 AND (source_conversation_id=?3 OR target_conversation_id=?3)")
            .bind(ask.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or(ResourceError::NotFound)?;
        if row.get::<Option<String>, _>("outcome").is_none() {
            let observed = observe(&mut tx, &row).await?;
            let decided = if observed.state.terminal() {
                observed
            } else {
                Observed {
                    state: ThreadAskState::Failed,
                    detail: Some("cancelled_by_owner"),
                    run: observed.run,
                    answer: None,
                }
            };
            settle_with(&mut tx, &row, decided).await?;
        }
        let row = ask_row(&mut tx, &ask.to_string()).await?;
        let result = view(&mut tx, &row, None).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    /// Returned outcomes admitted into this conversation after `after`, in
    /// sequence order. Read-only; a delivery adapter exports the follow-up
    /// turn of each (the owner sees the asking thread's use of the answer).
    pub async fn thread_ask_reply_inputs(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        after: i64,
        limit: u16,
    ) -> R<ThreadAskReplyInputs> {
        if after < 0 || !(1..=50).contains(&limit) {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let last_sequence: i64 =
            sqlx::query_scalar("SELECT sequence FROM conversations WHERE id=?")
                .bind(conversation.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?;
        let rows = sqlx::query("SELECT a.id,a.target_conversation_id,a.outcome,a.reply_message_id,a.reply_event_id,m.sequence FROM thread_asks a JOIN messages m ON m.id=a.reply_message_id WHERE a.owner_id=?1 AND a.source_conversation_id=?2 AND a.return_path='input' AND m.sequence>?3 ORDER BY m.sequence LIMIT ?4")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(after).bind(i64::from(limit))
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        let mut inputs = Vec::with_capacity(rows.len());
        for row in &rows {
            inputs.push(ThreadAskReplyInput {
                sequence: row.get("sequence"),
                message_id: uuid(row.get("reply_message_id"))?,
                event_id: uuid(row.get("reply_event_id"))?,
                ask_id: uuid(row.get("id"))?,
                target_name: name(&mut tx, row.get("target_conversation_id")).await?,
                state: match row.get::<&str, _>("outcome") {
                    "answered" => ThreadAskState::Answered,
                    _ => ThreadAskState::Failed,
                },
            });
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(ThreadAskReplyInputs {
            inputs,
            last_sequence,
        })
    }

    /// Every conversation of the owner with its grant state, for provisioning.
    /// Never returns a grant value.
    pub async fn thread_ask_grant_directory(
        &self,
        credential: &str,
        owner: &OwnerId,
    ) -> R<ThreadAskGrantDirectory> {
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
            conversations.push(ThreadAskGrantEntry {
                name: name(&mut tx, &id).await?,
                eligible: !unavailable_conversation(&mut tx, owner, &id).await?,
                grant: grant_of(&conversation, row.as_ref())?,
                conversation_id: conversation,
            });
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(ThreadAskGrantDirectory { conversations })
    }

    /// The recorded verified author of one input, if any (diagnostics).
    pub async fn message_author(&self, owner: &OwnerId, message: &MessageId) -> R<Option<String>> {
        sqlx::query_scalar("SELECT a.author FROM message_authors a JOIN messages m ON m.id=a.message_id WHERE a.message_id=? AND m.owner_id=?")
            .bind(message.to_string())
            .bind(owner.to_string())
            .fetch_optional(&self.pool)
            .await
            .map_err(unavailable)
    }
}
