//! A claimed task whose Worker was still in native setup when its parent
//! stopped running. No delegation can be admitted under that parent any more,
//! so the task never runs: it ends visibly as failed, and its unused setup
//! binding (with any confirmed readiness) can no longer strand the window.
use super::*;
use orkestr_v2_contracts::SessionId;

impl Store {
    /// Trusted Worker scheduler only, with the window's machine credential.
    /// Idempotent. Refuses while the parent still runs (setup may continue)
    /// or once anything was delegated or dispatched for the task.
    pub async fn fail_worker_task_setup(
        &self,
        credential: &str,
        task: &TaskId,
        setup: Option<&SessionId>,
    ) -> Result<()> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        let row = sqlx::query("SELECT t.*,p.state AS parent_state,p.session_id AS parent_session FROM worker_tasks t JOIN production_runs p ON p.id=t.parent_run_id WHERE t.id=? AND t.owner_id=? AND t.context_id=? AND t.incarnation_id=?")
            .bind(task.to_string()).bind(c.owner.to_string()).bind(&c.id).bind(&c.incarnation)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
        let existing: Option<Option<String>> =
            sqlx::query_scalar("SELECT setup_session_id FROM worker_task_failures WHERE task_id=?")
                .bind(task.to_string())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
        if let Some(recorded) = existing {
            tx.commit().await.map_err(db)?;
            return if recorded.as_deref() == setup.map(|s| s.to_string()).as_deref() {
                Ok(())
            } else {
                Err(RuntimeStoreError::Conflict)
            };
        }
        if row.get::<&str, _>("parent_state") == "running"
            || row.get::<Option<String>, _>("delegation_id").is_some()
            || !matches!(row.get::<&str, _>("state"), "claimed" | "held")
        {
            return Err(RuntimeStoreError::Fenced);
        }
        sqlx::query(
            "UPDATE worker_tasks SET state='held',claim_hash=NULL WHERE id=? AND state='claimed'",
        )
        .bind(task.to_string())
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        if let Some(session) = setup {
            // Only this task's own never-dispatched Worker setup binding.
            let lost = sqlx::query("UPDATE session_bindings SET state='lost' WHERE id=? AND owner_id=? AND conversation_id=? AND role='worker' AND parent_session_id=? AND state IN ('starting','ready','lost') AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.session_id=session_bindings.id) AND NOT EXISTS(SELECT 1 FROM worker_provider_delegations d WHERE d.worker_session_id=session_bindings.id)")
                .bind(session.to_string()).bind(c.owner.to_string())
                .bind(row.get::<String, _>("conversation_id")).bind(row.get::<String, _>("parent_session"))
                .execute(&mut *tx).await.map_err(db)?.rows_affected();
            if lost != 1 {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        let clock = now(&mut tx).await?;
        sqlx::query("INSERT INTO worker_task_failures(task_id,cause,setup_session_id,failed_at_ms) VALUES(?,'parent_left_running_during_setup',?,?)")
            .bind(task.to_string()).bind(setup.map(|s| s.to_string())).bind(clock)
            .execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(())
    }
}
