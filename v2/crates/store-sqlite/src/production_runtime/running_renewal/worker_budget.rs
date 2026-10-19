//! No task lifetime is silently widened: a separate trusted host opt-in is
//! persisted once, anchored to original owner-task creation, before attach.
use super::*;
use sqlx::sqlite::SqliteRow;
impl Store {
    /// Trusted host policy only, never a browser budget or provider request.
    /// Capture from genuine consumed owner-task Worker before by-value attach.
    pub async fn authorize_worker_running_renewal(
        &self,
        dispatch: &ConsumedProviderDispatch,
        max_run_ms: u32,
    ) -> Result<RunRenewalAuthority> {
        if max_run_ms == 0 || max_run_ms > 3_600_000 {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let c = self.context()?;
        if dispatch.namespace() != c.namespace || dispatch.incarnation_id() != c.incarnation {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let run = self
            .production_authorized_run(&mut tx, dispatch.provider())
            .await?;
        if dispatch.provider().run.role != Role::Worker
            || dispatch.provider().run.purpose != AdmissionPurpose::Execution
            || run.get::<&str, _>("dispatch_state") != "delivery_unknown"
            || !matches!(run.get::<&str, _>("state"), "starting" | "running")
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let task = sqlx::query("SELECT t.* FROM worker_tasks t JOIN worker_provider_delegations d ON d.id=t.delegation_id WHERE d.admitted_run_id=? AND d.state='admitted' AND t.state='delegated' AND t.owner_id=? AND t.context_id=? AND t.incarnation_id=? AND t.issuer_token_hash=?")
            .bind(dispatch.provider().run.run_id.to_string()).bind(c.owner.to_string()).bind(&c.id).bind(&c.incarnation).bind(&c.token_hash)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        let anchor: i64 = task.get("created_at_ms");
        let deadline = anchor
            .checked_add(i64::from(max_run_ms))
            .ok_or(RuntimeStoreError::InvalidInput)?;
        if deadline <= now(&mut tx).await? {
            return Err(RuntimeStoreError::Expired);
        }
        let original: i64 = sqlx::query_scalar(
            "SELECT expires_at_ms FROM worker_provider_delegations WHERE admitted_run_id=?",
        )
        .bind(dispatch.provider().run.run_id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if let Some(existing) = sqlx::query("SELECT * FROM worker_running_budgets WHERE run_id=?")
            .bind(dispatch.provider().run.run_id.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
        {
            if existing.get::<i64, _>("max_run_ms") != i64::from(max_run_ms)
                || existing.get::<i64, _>("anchor_ms") != anchor
                || existing.get::<&str, _>("task_id") != task.get::<&str, _>("id")
            {
                return Err(RuntimeStoreError::Conflict);
            }
        } else {
            sqlx::query("INSERT INTO worker_running_budgets(run_id,task_id,max_run_ms,anchor_ms,deadline_ms,original_delegation_deadline_ms) VALUES(?,?,?,?,?,?)")
                .bind(dispatch.provider().run.run_id.to_string()).bind(task.get::<&str,_>("id"))
                .bind(i64::from(max_run_ms)).bind(anchor).bind(deadline).bind(original).execute(&mut *tx).await.map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(RunRenewalAuthority {
            provider: dispatch.provider().clone(),
            namespace: c.namespace.clone(),
            incarnation: c.incarnation.clone(),
            worker_budget: Some(deadline),
            renewed: false,
        })
    }

    pub(in crate::production_runtime) fn renewal_provider<'a>(
        &self,
        authority: &'a RunRenewalAuthority,
    ) -> Result<&'a ProviderAdmission> {
        let c = self.context()?;
        if !authority.renewed
            || authority.namespace != c.namespace
            || authority.incarnation != c.incarnation
        {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(&authority.provider)
    }

    pub(in crate::production_runtime) async fn worker_budget_deadline_in(
        &self,
        tx: &mut SqliteConnection,
        run: &SqliteRow,
        budget: i64,
        supervisor_deadline: i64,
    ) -> Result<i64> {
        let stored:i64 = sqlx::query_scalar("SELECT b.deadline_ms FROM worker_running_budgets b JOIN worker_tasks t ON t.id=b.task_id WHERE b.run_id=? AND t.delegation_id=? AND t.state='delegated'")
            .bind(run.get::<&str,_>("id")).bind(run.get::<&str,_>("worker_delegation_id"))
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        if budget != stored {
            return Err(RuntimeStoreError::Fenced);
        }
        let clock = now(tx).await?;
        if clock >= budget {
            return Err(RuntimeStoreError::Expired);
        }
        // production_authorized_run already authenticated the exact live parent;
        // retain its current deadline rather than assuming supervisor liveness.
        let parent_deadline:i64 = sqlx::query_scalar("SELECT parent_deadline_ms FROM worker_provider_delegations WHERE admitted_run_id=? AND state='admitted'")
            .bind(run.get::<&str,_>("id")).fetch_one(&mut *tx).await.map_err(db)?;
        Ok((clock + 30_000)
            .min(budget)
            .min(supervisor_deadline)
            .min(parent_deadline))
    }
}

#[cfg(test)]
mod tests;
