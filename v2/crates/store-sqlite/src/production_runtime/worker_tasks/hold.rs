//! Negative reconciliation for time-based expiry, which emits no SQLite write.
use super::*;

impl Store {
    /// Hold at most this exact parent's bounded pending tasks when their current
    /// authority is no longer valid. A sealed old handle can only remove its own
    /// incarnation's authority; it cannot grant, resume, or retarget execution.
    /// Mutation triggers handle explicit Stop, terminal state, and revocation in
    /// their originating transaction. This additionally handles elapsed time.
    pub async fn reconcile_worker_task_holds(&self, parent: &RunId) -> Result<u64> {
        let context = self.context()?;
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let workspace = match self.check_run_workspace_before_writer(parent).await {
            Ok(workspace) => Some(workspace),
            Err(
                RuntimeStoreError::Unauthorized
                | RuntimeStoreError::Fenced
                | RuntimeStoreError::StaleLease
                | RuntimeStoreError::Expired
                | RuntimeStoreError::NotFound,
            ) => None,
            Err(error) => return Err(error),
        };
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let (store, physical_current) = (workspace.as_deref().unwrap_or(self), workspace.is_some());
        #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
        let (store, physical_current) = (self, true);
        let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let rows = sqlx::query("SELECT * FROM worker_tasks WHERE owner_id=? AND context_id=? AND incarnation_id=? AND parent_run_id=? AND state IN ('queued','claimed') ORDER BY ordinal LIMIT 33")
            .bind(context.owner.to_string()).bind(&context.id).bind(&context.incarnation)
            .bind(parent.to_string()).fetch_all(&mut *tx).await.map_err(db)?;
        if rows.len() > MAX_WORKER_TASKS_PER_PARENT {
            return Err(RuntimeStoreError::Unavailable);
        }
        let mut held = 0;
        for row in rows {
            let current = if physical_current {
                store.task_parent_in(&mut tx, &row).await.map(|_| ())
            } else {
                Err(RuntimeStoreError::Fenced)
            };
            match current {
                Ok(_) => continue,
                Err(
                    RuntimeStoreError::Unauthorized
                    | RuntimeStoreError::Fenced
                    | RuntimeStoreError::StaleLease
                    | RuntimeStoreError::Expired
                    | RuntimeStoreError::NotFound,
                ) => {}
                Err(error) => return Err(error),
            }
            held += sqlx::query("UPDATE worker_tasks SET state='held',claim_hash=NULL WHERE id=? AND state IN ('queued','claimed')")
                .bind(row.get::<&str,_>("id")).execute(&mut *tx).await.map_err(db)?.rows_affected();
        }
        tx.commit().await.map_err(db)?;
        Ok(held)
    }
}
