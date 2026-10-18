use super::*;

impl Store {
    /// Trusted supervisor only. A lost response strands the one-use claim for
    /// owner reconciliation; neither reading nor reopening reissues it.
    pub async fn claim_worker_task(
        &self,
        credential: &str,
        parent: &RunId,
    ) -> Result<Option<WorkerTaskClaim>> {
        self.worker_credential(credential)?;
        let context = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.worker_parent_current_in(&mut tx, parent).await?;
        let row = sqlx::query("SELECT * FROM worker_tasks WHERE parent_run_id=? AND owner_id=? AND context_id=? AND incarnation_id=? AND state='queued' ORDER BY ordinal LIMIT 1")
            .bind(parent.to_string()).bind(context.owner.to_string()).bind(&context.id).bind(&context.incarnation)
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let Some(row) = row else {
            tx.commit().await.map_err(db)?;
            return Ok(None);
        };
        let parent = self.task_parent_in(&mut tx, &row).await?;
        self.task_payload_in(&mut tx, &row).await?;
        let locator = secret();
        let hash = hash("worker-task-claim-v1", &[&locator]);
        let changed = sqlx::query(
            "UPDATE worker_tasks SET state='claimed',claim_hash=? WHERE id=? AND state='queued'",
        )
        .bind(hash)
        .bind(row.get::<&str, _>("id"))
        .execute(&mut *tx)
        .await
        .map_err(db)?
        .rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        let result = WorkerTaskClaim {
            id: TaskId(row.get::<String, _>("id").parse().map_err(db)?),
            locator,
            parent: super::super::admission::envelope(&parent)?.run,
            source_message: MessageId(
                row.get::<String, _>("source_message_id")
                    .parse()
                    .map_err(db)?,
            ),
            source_event: EventId(
                row.get::<String, _>("source_event_id")
                    .parse()
                    .map_err(db)?,
            ),
            lifetime_ms: u32::try_from(row.get::<i64, _>("lifetime_ms")).map_err(db)?,
        };
        tx.commit().await.map_err(db)?;
        Ok(Some(result))
    }

    /// Atomically consume the task claim and link one ordinary Worker
    /// delegation. The existing delegation helper owns native/parent checks.
    pub async fn delegate_worker_task(
        &self,
        credential: &str,
        claim: WorkerTaskClaim,
        binding: &Binding,
    ) -> Result<WorkerDelegation> {
        self.worker_credential(credential)?;
        let context = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let row = sqlx::query("SELECT * FROM worker_tasks WHERE id=? AND owner_id=? AND context_id=? AND incarnation_id=?")
            .bind(claim.id.to_string()).bind(context.owner.to_string()).bind(&context.id).bind(&context.incarnation)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
        if row.get::<&str, _>("state") != "claimed"
            || row.get::<Option<String>, _>("claim_hash")
                != Some(hash("worker-task-claim-v1", &[&claim.locator]))
        {
            return Err(RuntimeStoreError::Fenced);
        }
        self.task_parent_in(&mut tx, &row).await?;
        self.task_payload_in(&mut tx, &row).await?;
        let input = WorkerAdmissionInput {
            worker_binding_id: binding.session_id.clone(),
            expected_binding_generation: binding.generation,
            source_message_id: claim.source_message,
            source_event_id: claim.source_event,
            request_key: delegation_key(&claim.id, row.get("request_digest")),
            lifetime_ms: claim.lifetime_ms,
        };
        let WorkerDelegationResult::Fresh(delegation) = self
            .delegate_worker_in(&mut tx, credential, &claim.parent.run_id, &input)
            .await?
        else {
            return Err(RuntimeStoreError::Fenced);
        };
        sqlx::query(
            "UPDATE worker_tasks SET state='delegated',claim_hash=NULL,delegation_id=? WHERE id=?",
        )
        .bind(delegation.id().to_string())
        .bind(claim.id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(delegation)
    }
}
