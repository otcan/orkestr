//! An explicit owner decision changes provider continuity, never execution.
use super::*;
use orkestr_v2_contracts::{ProviderHandoffReceipt, ProviderHandoffRequest};

async fn existing(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    request: &ProviderHandoffRequest,
) -> Result<Option<ProviderHandoffReceipt>> {
    let row = sqlx::query("SELECT semantic_digest,receipt_json FROM conversation_provider_handoffs WHERE owner_id=? AND conversation_id=? AND request_key=?")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(&request.request_key)
        .fetch_optional(&mut *tx).await.map_err(db)?;
    match row {
        None => Ok(None),
        Some(row) => {
            if row.get::<String, _>("semantic_digest")
                != crate::digest(&serde_json::to_string(request).map_err(db)?)
            {
                return Err(RuntimeStoreError::Conflict);
            }
            Ok(Some(
                serde_json::from_str(row.get("receipt_json")).map_err(db)?,
            ))
        }
    }
}

impl Store {
    /// Read-only idempotency probe, authenticated before any receipt is exposed.
    pub async fn provider_handoff_existing_authenticated(
        &self,
        browser: &str,
        conversation: &ConversationId,
        request: &ProviderHandoffRequest,
    ) -> Result<Option<ProviderHandoffReceipt>> {
        if !request.is_valid() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, browser).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let receipt = existing(&mut tx, &owner, conversation, request).await?;
        tx.commit().await.map_err(db)?;
        Ok(receipt)
    }

    pub async fn provider_handoff_receipt_authenticated(
        &self,
        browser: &str,
        conversation: &ConversationId,
        request_key: &str,
    ) -> Result<Option<ProviderHandoffReceipt>> {
        if request_key.is_empty() || request_key.len() > 128 {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, browser).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let raw: Option<String> = sqlx::query_scalar("SELECT receipt_json FROM conversation_provider_handoffs WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(request_key)
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let receipt = raw
            .map(|s| serde_json::from_str(&s).map_err(db))
            .transpose()?;
        tx.commit().await.map_err(db)?;
        Ok(receipt)
    }

    /// Caller holds the controller admission fence and proved manager release.
    /// Every durable condition is repeated under this transaction's write lock.
    pub async fn handoff_provider_authenticated(
        &self,
        browser: &str,
        conversation: &ConversationId,
        request: &ProviderHandoffRequest,
    ) -> Result<ProviderHandoffReceipt> {
        if !request.is_valid() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, browser).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        if let Some(receipt) = existing(&mut tx, &owner, conversation, request).await? {
            tx.commit().await.map_err(db)?;
            return Ok(receipt);
        }
        let window = sqlx::query("SELECT w.*,s.namespace,s.supervisor_key FROM execution_windows w JOIN production_supervisors s ON s.context_id=w.context_id WHERE w.owner_id=? AND w.conversation_id=? ORDER BY w.generation DESC LIMIT 1")
            .bind(owner.to_string()).bind(conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
        let before = crate::conversation_resources::settings::current(&mut tx, conversation)
            .await
            .map_err(|_| RuntimeStoreError::Unavailable)?;
        if window.get::<String, _>("id") != request.window_id.to_string()
            || window.get::<i64, _>("generation") != request.generation as i64
            || window.get::<&str, _>("state") != "closed"
            || before.revision != request.expected_settings_revision
            || before.provider == request.target_provider
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
        let queued: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM reasoning_inbox WHERE conversation_id=? AND state='queued') + (SELECT count(*) FROM execution_window_queue WHERE owner_id=? AND conversation_id=? AND state='queued')")
            .bind(conversation.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        let unsafe_bindings: i64 = sqlx::query_scalar("SELECT count(*) FROM session_bindings WHERE owner_id=? AND conversation_id=? AND state IN ('busy','lost','blocked')")
            .bind(owner.to_string()).bind(conversation.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        let children: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_provider_delegations d WHERE d.owner_id=? AND d.conversation_id=? AND ((d.admitted_run_id IS NULL AND d.state='delegated') OR (d.admitted_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=d.admitted_run_id)))")
            .bind(owner.to_string()).bind(conversation.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        let prior: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM conversation_provider_handoffs WHERE window_id=?",
        )
        .bind(request.window_id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if queued + unsafe_bindings + children + prior != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        let receipt = ProviderHandoffReceipt {
            handoff_id: Uuid::new_v4(),
            conversation_id: conversation.clone(),
            window_id: request.window_id,
            generation: request.generation,
            from_provider: before.provider,
            to_provider: request.target_provider,
            settings_revision: before
                .revision
                .checked_add(1)
                .ok_or(RuntimeStoreError::Unavailable)?,
            provider_generation: before
                .provider_generation
                .checked_add(1)
                .ok_or(RuntimeStoreError::Unavailable)?,
            history_sha256: crate::digest(&request.history_summary),
            created_at_ms: now(&mut tx).await?,
        };
        sqlx::query("UPDATE session_bindings SET state='retired' WHERE owner_id=? AND conversation_id=? AND role IN ('fast','deep') AND state!='retired'")
            .bind(owner.to_string()).bind(conversation.to_string()).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO conversation_settings(conversation_id,owner_id,revision,provider,model,reasoning_effort,honor_no_reply,reply_prefix,reply_footer,provider_generation,updated_at_ms,review_before_accepting) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET revision=excluded.revision,provider=excluded.provider,model=excluded.model,reasoning_effort=excluded.reasoning_effort,provider_generation=excluded.provider_generation,updated_at_ms=excluded.updated_at_ms")
            .bind(conversation.to_string()).bind(owner.to_string()).bind(receipt.settings_revision)
            .bind(request.target_provider.as_str()).bind(&request.model).bind(&request.reasoning_effort)
            .bind(i64::from(before.honor_no_reply)).bind(&before.reply_prefix).bind(&before.reply_footer)
            .bind(receipt.provider_generation).bind(receipt.created_at_ms).bind(i64::from(before.review_before_accepting))
            .execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO conversation_provider_handoffs(id,owner_id,conversation_id,request_key,semantic_digest,window_id,window_generation,from_provider,to_provider,settings_revision,provider_generation,history_summary,history_sha256,created_at_ms,receipt_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(receipt.handoff_id.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .bind(&request.request_key).bind(crate::digest(&serde_json::to_string(request).map_err(db)?))
            .bind(request.window_id.to_string()).bind(request.generation as i64).bind(before.provider.as_str())
            .bind(request.target_provider.as_str()).bind(receipt.settings_revision).bind(receipt.provider_generation)
            .bind(&request.history_summary).bind(&receipt.history_sha256).bind(receipt.created_at_ms)
            .bind(serde_json::to_string(&receipt).map_err(db)?).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(receipt)
    }
}
