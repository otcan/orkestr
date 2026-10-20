use super::*;

impl Store {
    /// Bounded owner history read. Revoked provider authority makes uncompleted
    /// tasks Held; it does not prevent a current owner from inspecting evidence.
    pub async fn worker_tasks_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        parent: &RunId,
    ) -> Result<WorkerTaskList> {
        self.worker_task_list_in(credential, &self.context()?.owner, conversation, parent)
            .await
    }

    /// Durable current-browser history without a supervisor or scheduler.
    /// Missing live authority holds pending tasks and never grants creation.
    pub async fn worker_task_history_authenticated(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        parent: &RunId,
    ) -> Result<WorkerTaskList> {
        if self.authority.is_some() {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if owner.0.is_nil() || conversation.0.is_nil() || parent.0.is_nil() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        self.worker_task_list_in(credential, owner, conversation, parent)
            .await
    }

    async fn worker_task_list_in(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        parent: &RunId,
    ) -> Result<WorkerTaskList> {
        if credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let authorized: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(crate::digest(credential)).bind(owner.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        if authorized != 1 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        crate::runtime::scope(&mut tx, owner, conversation).await?;
        let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs WHERE id=? AND owner_id=? AND conversation_id=? AND role='deep'")
            .bind(parent.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        if exists != 1 {
            return Err(RuntimeStoreError::NotFound);
        }
        let eligible = self.authority.is_some()
            && match self.worker_parent_current_in(&mut tx, parent).await {
                Ok(_) => true,
                Err(
                    RuntimeStoreError::Unauthorized
                    | RuntimeStoreError::Fenced
                    | RuntimeStoreError::StaleLease
                    | RuntimeStoreError::Expired
                    | RuntimeStoreError::NotFound,
                ) => false,
                Err(error) => return Err(error),
            };
        let rows = sqlx::query("SELECT t.*,CASE WHEN length(CAST(p.title AS BLOB))<=160 THEN p.title END AS title,p.task_id AS payload_present,d.admitted_run_id,r.state AS run_state,tf.cause AS failure_cause FROM worker_tasks t LEFT JOIN worker_task_payloads p ON p.task_id=t.id LEFT JOIN worker_task_failures tf ON tf.task_id=t.id LEFT JOIN worker_provider_delegations d ON d.id=t.delegation_id LEFT JOIN production_runs r ON r.id=d.admitted_run_id WHERE t.owner_id=? AND t.conversation_id=? AND t.parent_run_id=? ORDER BY t.ordinal LIMIT 33")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(parent.to_string())
            .fetch_all(&mut *tx).await.map_err(db)?;
        if rows.len() > MAX_WORKER_TASKS_PER_PARENT {
            return Err(RuntimeStoreError::Unavailable);
        }
        let mut tasks = Vec::with_capacity(rows.len());
        for row in rows {
            let task = receipt(&row)?;
            let run_id = row
                .get::<Option<String>, _>("admitted_run_id")
                .map(|id| id.parse().map(RunId).map_err(db))
                .transpose()?;
            let available = row.get::<Option<String>, _>("payload_present").is_some();
            // Creation remains Running-only. A consumed child instead reports
            // its own current authority, including a retained parent proposal.
            let current = if self.authority.is_none() {
                Err(RuntimeStoreError::Fenced)
            } else if let Some(run) = run_id.as_ref().filter(|_| {
                matches!(
                    row.get::<Option<&str>, _>("run_state"),
                    Some("starting" | "running")
                )
            }) {
                self.task_run_current_in(&mut tx, run).await
            } else {
                self.task_parent_in(&mut tx, &row).await.map(|_| ())
            };
            let live = match current {
                Ok(_) => true,
                Err(
                    RuntimeStoreError::Unauthorized
                    | RuntimeStoreError::Fenced
                    | RuntimeStoreError::StaleLease
                    | RuntimeStoreError::Expired
                    | RuntimeStoreError::NotFound,
                ) => false,
                Err(error) => return Err(error),
            };
            let phase = match row.get::<Option<&str>, _>("run_state") {
                Some("succeeded") => WorkerTaskPhase::Completed,
                Some("cancelled") => WorkerTaskPhase::Cancelled,
                Some("cancel_requested") => WorkerTaskPhase::CancelRequested,
                Some("awaiting_acceptance") => WorkerTaskPhase::AwaitingAcceptance,
                Some("failed") => WorkerTaskPhase::Failed,
                Some("blocked") => WorkerTaskPhase::Held,
                Some("running") if live => WorkerTaskPhase::Running,
                Some("starting") if live => WorkerTaskPhase::Preparing,
                Some("running" | "starting") => WorkerTaskPhase::Held,
                None if row.get::<Option<&str>, _>("failure_cause").is_some() => {
                    WorkerTaskPhase::Failed
                }
                None => match (row.get::<&str, _>("state"), live && available) {
                    ("queued", true) => WorkerTaskPhase::Queued,
                    ("claimed" | "delegated", true) => WorkerTaskPhase::Claimed,
                    ("queued" | "claimed" | "delegated" | "held", _) => WorkerTaskPhase::Held,
                    _ => return Err(RuntimeStoreError::Unavailable),
                },
                _ => return Err(RuntimeStoreError::Unavailable),
            };
            tasks.push(WorkerTaskStatus {
                task,
                phase,
                title: row.get("title"),
                instructions_available: available,
                run_id,
                failure_cause: match row.get::<Option<&str>, _>("failure_cause") {
                    None => None,
                    Some("parent_left_running_during_setup") => {
                        Some(WorkerTaskFailureCause::ParentLeftRunningDuringSetup)
                    }
                    Some(_) => return Err(RuntimeStoreError::Unavailable),
                },
            });
        }
        tx.commit().await.map_err(db)?;
        let result = WorkerTaskList {
            schema_version: 1,
            conversation_id: conversation.clone(),
            parent_run_id: parent.clone(),
            can_create: eligible && tasks.len() < MAX_WORKER_TASKS_PER_PARENT,
            tasks,
        };
        if !result.is_valid() {
            return Err(RuntimeStoreError::Unavailable);
        }
        Ok(result)
    }
    async fn task_run_current_in(&self, tx: &mut SqliteConnection, run: &RunId) -> Result<()> {
        let context = self.context()?;
        let row = sqlx::query("SELECT * FROM production_runs WHERE id=? AND owner_id=? AND context_id=? AND incarnation_id=? AND role='worker'")
            .bind(run.to_string()).bind(context.owner.to_string()).bind(&context.id).bind(&context.incarnation)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        let canonical = super::super::admission::envelope(&row)?;
        self.production_authorized_run(tx, &canonical).await?;
        Ok(())
    }
}
