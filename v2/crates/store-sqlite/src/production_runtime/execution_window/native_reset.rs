//! Explicit fresh-Claude lineage. No dispatch, replay or replacement history.
use super::*;
use orkestr_v2_contracts::{ClaudeNativeResetReceipt, ClaudeNativeResetRequest};

/// The last closed window whose native continuity the owner explicitly reset.
pub(super) async fn floor(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<i64> {
    sqlx::query_scalar("SELECT coalesce(max(window_generation),0) FROM conversation_native_resets WHERE owner_id=? AND conversation_id=?")
        .bind(owner.to_string()).bind(conversation.to_string())
        .fetch_one(tx).await.map_err(db)
}

impl Store {
    /// The caller has already proved no task/manager custody. Core repeats all
    /// durable fences atomically: current owner, exact latest CLOSED window,
    /// fully retired scopes, no unfinished run or queued window intent.
    pub async fn reset_claude_native_authenticated(
        &self,
        browser: &str,
        conversation: &ConversationId,
        request: &ClaudeNativeResetRequest,
    ) -> Result<ClaudeNativeResetReceipt> {
        if !request.is_valid() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, browser).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let digest = crate::digest(&serde_json::to_string(request).map_err(db)?);
        if let Some(row) = sqlx::query("SELECT semantic_digest,receipt_json FROM conversation_native_resets WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&request.request_key)
            .fetch_optional(&mut *tx).await.map_err(db)? {
            if row.get::<String,_>("semantic_digest") != digest {
                return Err(RuntimeStoreError::Conflict);
            }
            let receipt = serde_json::from_str(row.get("receipt_json")).map_err(db)?;
            tx.commit().await.map_err(db)?;
            return Ok(receipt);
        }
        let window = sqlx::query("SELECT w.*,s.namespace,s.supervisor_key,s.provider_kind FROM execution_windows w JOIN production_supervisors s ON s.context_id=w.context_id WHERE w.owner_id=? AND w.conversation_id=? ORDER BY w.generation DESC LIMIT 1")
            .bind(owner.to_string()).bind(conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
        let launch = crate::conversation_resources::settings::turn_launch(&mut tx, conversation)
            .await
            .map_err(|_| RuntimeStoreError::Unavailable)?;
        if window.get::<String, _>("id") != request.window_id.to_string()
            || window.get::<i64, _>("generation") != request.generation as i64
            || window.get::<&str, _>("state") != "closed"
            || window.get::<&str, _>("provider_kind") != "claude"
            || launch.provider != orkestr_v2_contracts::ConversationProvider::Claude
        {
            return Err(RuntimeStoreError::Fenced);
        }
        retired_context::all_prior_retired(
            &mut tx,
            &owner,
            conversation,
            window.get("namespace"),
            window.get("supervisor_key"),
            None,
        )
        .await?;
        let queued: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_window_queue WHERE owner_id=? AND conversation_id=? AND state='queued'")
            .bind(owner.to_string()).bind(conversation.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        let unsafe_bindings: i64 = sqlx::query_scalar("SELECT count(*) FROM session_bindings WHERE owner_id=? AND conversation_id=? AND role IN ('fast','deep') AND state!='retired' AND (state='busy' OR provider_kind!='claude')")
            .bind(owner.to_string()).bind(conversation.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        let already: i64 =
            sqlx::query_scalar("SELECT count(*) FROM conversation_native_resets WHERE window_id=?")
                .bind(request.window_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if queued != 0 || unsafe_bindings != 0 || already != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        let receipt = ClaudeNativeResetReceipt {
            reset_id: Uuid::new_v4(),
            conversation_id: conversation.clone(),
            window_id: request.window_id,
            generation: request.generation,
            reset_at_ms: now(&mut tx).await?,
        };
        // Keep every native ID, observation, payload, input and delivery receipt.
        // Retiring a binding fences its old generation; new setup gets new IDs.
        sqlx::query("UPDATE session_bindings SET state='retired' WHERE owner_id=? AND conversation_id=? AND role IN ('fast','deep') AND state!='retired'")
            .bind(owner.to_string()).bind(conversation.to_string())
            .execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO conversation_native_resets(id,owner_id,conversation_id,request_key,semantic_digest,window_id,window_generation,reset_at_ms,receipt_json) VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(receipt.reset_id.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .bind(&request.request_key).bind(digest).bind(request.window_id.to_string())
            .bind(request.generation as i64).bind(receipt.reset_at_ms)
            .bind(serde_json::to_string(&receipt).map_err(db)?)
            .execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(receipt)
    }
}
