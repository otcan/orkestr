use super::*;

impl Store {
    /// Trusted executor attests bounded output only after child termination.
    /// Current authority is required even for replay; completion is not acceptance.
    pub async fn finish_workspace_exec(
        &self,
        credential: &str,
        launch: &ConsumedWorkspaceExec,
        outcome: WorkspaceExecOutcome,
        output_digest: &str,
    ) -> Result<WorkspaceExecReceipt> {
        let state = match outcome {
            WorkspaceExecOutcome::Completed => "completed",
            WorkspaceExecOutcome::Failed => "failed",
            WorkspaceExecOutcome::Cancelled => return Err(RuntimeStoreError::InvalidInput),
        };
        if output_digest.len() != 64
            || !output_digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let row = authority::live(self, &mut tx, credential, launch).await?;
        if !launch.spawn_spent.load(Ordering::Acquire) {
            return Err(RuntimeStoreError::Conflict);
        }
        let result = match row.get::<&str, _>("state") {
            "delivery_unknown" => {
                let row = sqlx::query("UPDATE workspace_exec_delegations SET state=?,outcome_digest=?,revision=revision+1 WHERE id=? AND state='delivery_unknown' RETURNING *")
                    .bind(state).bind(output_digest).bind(launch.id().to_string()).fetch_one(&mut *tx).await.map_err(db)?;
                receipt(&row)?
            }
            actual
                if actual == state
                    && row.get::<Option<&str>, _>("outcome_digest") == Some(output_digest) =>
            {
                receipt(&row)?
            }
            _ => return Err(RuntimeStoreError::Conflict),
        };
        tx.commit().await.map_err(db)?;
        Ok(result)
    }

    /// Trusted owned-child kill/reap evidence is required before this call. The
    /// exact Core-issued parent control authenticates acknowledgement, never launch.
    pub async fn acknowledge_workspace_exec_cancel(
        &self,
        credential: &str,
        launch: &ConsumedWorkspaceExec,
        control: &ProviderAdmission,
    ) -> Result<WorkspaceExecReceipt> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        authority::credential(self, credential)?;
        let parent_row = self.production_authorized_run(&mut tx, control).await?;
        if control.run.purpose != AdmissionPurpose::CancellationAcknowledgement
            || parent_row.get::<&str, _>("state") != "cancel_requested"
            || control.run.run_id != launch.parent.run.run_id
            || !launch.spawn_spent.load(Ordering::Acquire)
        {
            return Err(RuntimeStoreError::Fenced);
        }
        // Authenticate the original issued envelope despite the new cancel fence;
        // immutable scope/session identity must still match the original launch.
        super::super::leases::authenticate(&mut tx, &parent_row, &launch.parent).await?;
        let row = load(
            self,
            &mut tx,
            launch.id(),
            &launch.parent,
            &launch.context_id,
            &launch.incarnation,
            &launch.profile,
        )
        .await?;
        if row.get::<&str, _>("source_digest") != launch.source_digest()
            || row.get::<i64, _>("expires_at_ms") != launch.expires_at_ms
        {
            return Err(RuntimeStoreError::Conflict);
        }
        let result = match row.get::<&str, _>("state") {
            "delivery_unknown" => {
                let row = sqlx::query("UPDATE workspace_exec_delegations SET state='cancelled',revision=revision+1 WHERE id=? AND state='delivery_unknown' RETURNING *")
                    .bind(launch.id().to_string()).fetch_one(&mut *tx).await.map_err(db)?;
                receipt(&row)?
            }
            "cancelled" => receipt(&row)?,
            _ => return Err(RuntimeStoreError::Conflict),
        };
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
}
