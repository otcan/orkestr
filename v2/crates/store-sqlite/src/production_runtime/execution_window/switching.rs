//! Read-only precondition for an ordinary owned task shutdown on thread switch.
//! This is never a retirement witness: Runtime must still reap every original.
use super::*;

impl Store {
    /// Validate the current caller and intent before closing another thread.
    /// A historical identical receipt is read evidence, never launch authority.
    /// Admission still repeats all predicates under its write transaction.
    pub async fn inspect_execution_window_request_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<Option<ExecutionWindowAdmission>> {
        if !input.is_valid() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let digest = crate::digest(&serde_json::to_string(input).map_err(db)?);
        if let Some(row) = sqlx::query("SELECT semantic_digest,receipt_json FROM execution_window_inputs WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&input.request_key)
            .fetch_optional(&mut *tx).await.map_err(db)? {
            if row.get::<String, _>("semantic_digest") != digest { return Err(RuntimeStoreError::Conflict); }
            let mut receipt: ExecutionWindowAdmission = serde_json::from_str(row.get("receipt_json")).map_err(db)?;
            receipt.duplicate = true;
            tx.commit().await.map_err(db)?;
            return Ok(Some(receipt));
        }
        admission::source_in(&mut tx, &owner, conversation, input).await?;
        let latest = sqlx::query("SELECT * FROM execution_windows WHERE owner_id=? AND conversation_id=? ORDER BY generation DESC LIMIT 1")
            .bind(owner.to_string()).bind(conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let generation = latest
            .as_ref()
            .map(|row| row.get::<i64, _>("generation") as u64)
            .unwrap_or(0);
        if input.expected_generation != generation {
            return Err(RuntimeStoreError::Conflict);
        }
        match (&latest, input.window_id) {
            (None, None) if input.predecessor_window_id.is_none() => {}
            (Some(row), None)
                if row.get::<&str, _>("state") == "closed"
                    && input.predecessor_window_id.map(|id| id.to_string())
                        == Some(row.get("id")) => {}
            (Some(row), Some(id))
                if row.get::<&str, _>("state") == "active"
                    && row.get::<String, _>("id") == id.to_string()
                    && row.get::<i64, _>("work_deadline_ms") > now(&mut tx).await? => {}
            _ => return Err(RuntimeStoreError::Fenced),
        }
        tx.commit().await.map_err(db)?;
        Ok(None)
    }

    pub async fn execution_window_switch_ready_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
    ) -> Result<bool> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let row = sqlx::query("SELECT * FROM execution_windows WHERE owner_id=? AND conversation_id=? ORDER BY generation DESC LIMIT 1")
            .bind(owner.to_string()).bind(conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let Some(row) = row else { return Ok(true) };
        if row.get::<&str, _>("state") == "closed" {
            return Ok(true);
        }
        if !matches!(row.get::<&str, _>("state"), "active" | "retiring") {
            return Ok(false);
        }
        let (Some(context), Some(incarnation)) = (
            row.get::<Option<String>, _>("context_id"),
            row.get::<Option<String>, _>("incarnation_id"),
        ) else {
            return Ok(false);
        };
        let terminal_deep: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r JOIN production_terminal_evidence t ON t.run_id=r.id WHERE r.context_id=? AND r.incarnation_id=? AND r.role='deep'")
            .bind(&context).bind(&incarnation).fetch_one(&mut *tx).await.map_err(db)?;
        let unresolved: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r WHERE r.context_id=? AND r.incarnation_id=? AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id)")
            .bind(&context).bind(&incarnation).fetch_one(&mut *tx).await.map_err(db)?;
        let queued: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_window_inputs w JOIN reasoning_inbox i ON i.event_id=w.event_id WHERE w.window_id=? AND i.state IN ('queued','claimed') AND NOT EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=i.event_id)")
            .bind(row.get::<String, _>("id")).fetch_one(&mut *tx).await.map_err(db)?;
        let ready = terminal_deep > 0
            && unresolved == 0
            && queued == 0
            && super::super::terminal_retirement::descendants_clear(&mut tx, &context).await?;
        tx.commit().await.map_err(db)?;
        Ok(ready)
    }
}
