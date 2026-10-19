use super::*;

impl Store {
    /// Called by the trusted sandbox executor after physical child termination.
    /// No public receipt, request ID or caller-selected response text is a grant.
    pub async fn prepare_offline_python_result(
        &self,
        credential: &str,
        launch: &ConsumedOfflinePython,
        output: &OfflinePythonOutput,
    ) -> Result<OfflinePythonResultPreparation> {
        let (digest, text, success) = output::render(output)?;
        let response_digest = output::response_digest(&text, success);
        let state = if success { "completed" } else { "failed" };
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let row = authority::live(self, &mut tx, credential, launch).await?;
        if launch.parent.run.role != Role::Worker || !launch.spawn_spent.load(Ordering::Acquire) {
            return Err(RuntimeStoreError::Fenced);
        }
        let native = sqlx::query(
            "SELECT * FROM worker_tool_results WHERE delegation_id=? AND parent_run_id=?",
        )
        .bind(launch.id().to_string())
        .bind(launch.parent.run.run_id.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::Fenced)?;
        let call = OfflinePythonNativeCall::from_row(&native)?;
        if launch.parent.run.native_session_id.as_deref() != Some(call.thread_id.as_str()) {
            return Err(RuntimeStoreError::Conflict);
        }
        match row.get::<&str, _>("state") {
            "delivery_unknown" => {
                sqlx::query("UPDATE worker_tool_delegations SET state=?,outcome_digest=?,revision=revision+1 WHERE id=? AND state='delivery_unknown'")
                    .bind(state).bind(&digest).bind(launch.id().to_string()).execute(&mut *tx).await.map_err(db)?;
            }
            actual
                if actual == state
                    && row.get::<Option<&str>, _>("outcome_digest") == Some(digest.as_str()) => {}
            _ => return Err(RuntimeStoreError::Conflict),
        }
        if native.get::<&str, _>("state") != "bound" {
            if native.get::<Option<&str>, _>("output_digest") != Some(digest.as_str())
                || native.get::<Option<&str>, _>("response_digest")
                    != Some(response_digest.as_str())
            {
                return Err(RuntimeStoreError::Conflict);
            }
            tx.commit().await.map_err(db)?;
            return Ok(OfflinePythonResultPreparation::ReconciliationRequired);
        }
        let locator = secret();
        sqlx::query("UPDATE worker_tool_results SET state='prepared',output_digest=?,response_text=?,response_digest=?,success=?,grant_hash=? WHERE delegation_id=? AND state='bound'")
            .bind(&digest).bind(&text).bind(response_digest).bind(success)
            .bind(hash("offline-python-result-grant-v1", &[&locator]))
            .bind(launch.id().to_string()).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(OfflinePythonResultPreparation::Reserved(
            OfflinePythonResultReservation {
                launch: Box::new(types::ResultLineage::from_launch(launch)),
                locator,
                call,
                output_digest: digest,
                text,
                success,
            },
        ))
    }
}
