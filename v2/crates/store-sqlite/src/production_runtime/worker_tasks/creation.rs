use super::*;

impl Store {
    /// Browser input creates bounded durable intent, never a dispatch locator.
    /// Current browser authorization is checked before both fresh and replay.
    pub async fn create_worker_task_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        request: &WorkerTaskCreateRequest,
    ) -> Result<WorkerTaskReceipt> {
        if !request.is_valid() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let context = self.context()?;
        let digest = request_digest(request);
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.task_browser_in(&mut tx, credential, conversation)
            .await?;
        if let Some(row) = sqlx::query(
            "SELECT * FROM worker_tasks WHERE owner_id=? AND parent_run_id=? AND request_key=?",
        )
        .bind(context.owner.to_string())
        .bind(request.parent_run_id.to_string())
        .bind(&request.request_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        {
            if row.get::<&str, _>("conversation_id") != conversation.to_string() {
                return Err(RuntimeStoreError::NotFound);
            }
            if row.get::<&str, _>("request_digest") != digest {
                return Err(RuntimeStoreError::Conflict);
            }
            let result = receipt(&row)?;
            tx.commit().await.map_err(db)?;
            return Ok(result);
        }
        let parent = self
            .worker_parent_current_in(&mut tx, &request.parent_run_id)
            .await?;
        if parent.get::<&str, _>("conversation_id") != conversation.to_string() {
            return Err(RuntimeStoreError::NotFound);
        }
        let revision: i64 =
            sqlx::query_scalar("SELECT revision FROM production_control_revisions WHERE run_id=?")
                .bind(request.parent_run_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if revision != request.expected_control_revision {
            return Err(RuntimeStoreError::Conflict);
        }
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM worker_tasks WHERE parent_run_id=?")
                .bind(request.parent_run_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if count >= MAX_WORKER_TASKS_PER_PARENT as i64 {
            return Err(RuntimeStoreError::Busy);
        }
        let id = Uuid::new_v4();
        let clock = now(&mut tx).await?;
        let row = sqlx::query("INSERT INTO worker_tasks(id,owner_id,conversation_id,parent_run_id,context_id,incarnation_id,parent_control_revision,source_message_id,source_event_id,request_key,request_digest,lifetime_ms,created_at_ms,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'queued') RETURNING *")
            .bind(id.to_string()).bind(context.owner.to_string()).bind(conversation.to_string())
            .bind(request.parent_run_id.to_string()).bind(&context.id).bind(&context.incarnation)
            .bind(revision).bind(parent.get::<&str,_>("message_id")).bind(parent.get::<&str,_>("event_id"))
            .bind(&request.request_key).bind(digest).bind(i64::from(request.lifetime_ms)).bind(clock)
            .fetch_one(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO worker_task_payloads(task_id,title,instructions) VALUES(?,?,?)")
            .bind(id.to_string())
            .bind(&request.title)
            .bind(&request.instructions)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let result = receipt(&row)?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }

    /// Hold unissued work. An admitted native run must use the existing exact
    /// run Stop path; this method cannot claim to interrupt it.
    pub async fn hold_worker_task_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        task: &TaskId,
    ) -> Result<()> {
        let context = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.task_browser_in(&mut tx, credential, conversation)
            .await?;
        let state: String = sqlx::query_scalar(
            "SELECT state FROM worker_tasks WHERE id=? AND owner_id=? AND conversation_id=?",
        )
        .bind(task.to_string())
        .bind(context.owner.to_string())
        .bind(conversation.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::NotFound)?;
        match state.as_str() {
            "delegated" => return Err(RuntimeStoreError::Busy),
            "queued" | "claimed" | "held" => {}
            _ => return Err(RuntimeStoreError::Unavailable),
        }
        sqlx::query("UPDATE worker_tasks SET state='held',claim_hash=NULL WHERE id=?")
            .bind(task.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)
    }

    /// Remove raw subtask data, retaining metadata and evidence. Deletion stops
    /// future consumption; it does not retract input already sent to a provider.
    pub async fn delete_worker_task_payload_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        task: &TaskId,
    ) -> Result<()> {
        let context = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.task_browser_in(&mut tx, credential, conversation)
            .await?;
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM worker_tasks WHERE id=? AND owner_id=? AND conversation_id=?",
        )
        .bind(task.to_string())
        .bind(context.owner.to_string())
        .bind(conversation.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if count != 1 {
            return Err(RuntimeStoreError::NotFound);
        }
        sqlx::query("DELETE FROM worker_task_payloads WHERE task_id=?")
            .bind(task.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("UPDATE worker_tasks SET state='held',claim_hash=NULL WHERE id=? AND state IN ('queued','claimed')")
            .bind(task.to_string()).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)
    }
}
