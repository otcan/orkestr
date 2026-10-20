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
        let owner_budget = task
            .get::<Option<i64>, _>("execution_budget_ms")
            .ok_or(RuntimeStoreError::Fenced)?;
        let effective = i64::from(max_run_ms).min(owner_budget);
        let anchor: i64 = task.get("created_at_ms");
        let deadline = anchor
            .checked_add(effective)
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

    /// Read-only: would `renew_running` extend this budgeted Worker's lease
    /// right now? Renewal refuses a non-extending lease, and transport treats
    /// any refusal as uncertainty, so scheduling asks first and never spends
    /// the live child on a renewal that cannot advance.
    pub async fn worker_renewal_extends(&self, authority: &RunRenewalAuthority) -> Result<bool> {
        let c = self.context()?;
        let Some(budget) = authority.worker_budget else {
            return Ok(false);
        };
        if authority.namespace != c.namespace || authority.incarnation != c.incarnation {
            return Err(RuntimeStoreError::Fenced);
        }
        let current = &authority.provider.run;
        let mut tx = self.pool.begin().await.map_err(db)?;
        let row = sqlx::query("SELECT * FROM production_runs WHERE id=? AND owner_id=? AND context_id=? AND role='worker' AND state='running' AND dispatch_state='delivery_unknown' AND lease_generation=? AND lease_deadline_ms=?")
            .bind(current.run_id.to_string()).bind(c.owner.to_string()).bind(&c.id)
            .bind(i64::try_from(current.lease_generation).map_err(db)?).bind(current.lease_deadline_ms)
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let Some(row) = row else {
            return Ok(false);
        };
        let supervisor: i64 = sqlx::query_scalar(
            "SELECT lease_deadline_ms FROM production_supervisors WHERE context_id=?",
        )
        .bind(&c.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let extends = match self
            .worker_budget_deadline_in(&mut tx, &row, budget, supervisor)
            .await
        {
            Ok((deadline, _)) => deadline > current.lease_deadline_ms,
            Err(RuntimeStoreError::Expired) => false,
            Err(error) => return Err(error),
        };
        tx.rollback().await.map_err(db)?;
        Ok(extends)
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

    /// Next lease deadline for a budgeted Worker. A Running parent bounds it
    /// by its own live lease. A parent that already committed its proposal and
    /// is retained for the owner's decision no longer renews itself; its live
    /// lease is carried forward with the Worker instead (`RetainedParent`), so
    /// an admitted Worker can finish and deliver its own result.
    pub(in crate::production_runtime) async fn worker_budget_deadline_in(
        &self,
        tx: &mut SqliteConnection,
        run: &SqliteRow,
        budget: i64,
        supervisor_deadline: i64,
    ) -> Result<(i64, Option<RetainedParent>)> {
        let stored:i64 = sqlx::query_scalar("SELECT b.deadline_ms FROM worker_running_budgets b JOIN worker_tasks t ON t.id=b.task_id WHERE b.run_id=? AND t.delegation_id=? AND t.state='delegated' AND t.execution_budget_ms IS NOT NULL AND b.deadline_ms<=t.created_at_ms+t.execution_budget_ms")
            .bind(run.get::<&str,_>("id")).bind(run.get::<&str,_>("worker_delegation_id"))
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        if budget != stored {
            return Err(RuntimeStoreError::Fenced);
        }
        let clock = now(tx).await?;
        if clock >= budget {
            return Err(RuntimeStoreError::Expired);
        }
        let target = (clock + 30_000).min(budget).min(supervisor_deadline);
        // production_authorized_run already authenticated the exact live parent;
        // retain its current deadline rather than assuming supervisor liveness.
        let parent_deadline:i64 = sqlx::query_scalar("SELECT parent_deadline_ms FROM worker_provider_delegations WHERE admitted_run_id=? AND state='admitted'")
            .bind(run.get::<&str,_>("id")).fetch_one(&mut *tx).await.map_err(db)?;
        let c = self.context()?;
        // Exactly the retained-parent shape the delegation fence accepts: a live
        // Deep lease whose completed proposal was committed at that same lease.
        let retained = sqlx::query("SELECT p.id,p.lease_generation,p.dispatch_fence,p.lease_deadline_ms FROM worker_provider_delegations d JOIN production_runs p ON p.id=d.parent_run_id WHERE d.admitted_run_id=? AND d.state='admitted' AND p.role='deep' AND p.state='awaiting_acceptance' AND p.dispatch_state='delivery_unknown' AND p.context_id=? AND p.incarnation_id=? AND p.owner_id=? AND p.lease_generation=d.parent_lease_generation AND p.dispatch_fence=d.parent_dispatch_fence AND p.lease_deadline_ms=d.parent_deadline_ms AND p.lease_deadline_ms>? AND EXISTS(SELECT 1 FROM production_observations o JOIN events e ON e.id=o.event_id WHERE o.run_id=p.id AND o.kind='completed_proposal' AND o.receipt_state='awaiting_acceptance' AND o.lease_generation=p.lease_generation AND o.dispatch_fence=p.dispatch_fence AND e.kind='provider_observed' AND e.schema_version=5 AND e.owner_id=p.owner_id AND e.conversation_id=p.conversation_id)")
            .bind(run.get::<&str,_>("id")).bind(&c.id).bind(&c.incarnation).bind(c.owner.to_string()).bind(clock)
            .fetch_optional(&mut *tx).await.map_err(db)?;
        Ok(match retained {
            Some(parent) if target > parent_deadline => (
                target,
                Some(RetainedParent {
                    run: parent.get("id"),
                    lease_generation: parent.get("lease_generation"),
                    dispatch_fence: parent.get("dispatch_fence"),
                    deadline: parent.get("lease_deadline_ms"),
                }),
            ),
            Some(_) => (target, None),
            None => (target.min(parent_deadline), None),
        })
    }

    /// Carry a retained parent's live lease forward to `deadline`, in place:
    /// same generation and fence, so its committed proposal still names its
    /// current lease. Every live delegation's snapshot moves first, so the
    /// parent fence sees an unchanged lineage. Never revives an expired lease.
    pub(in crate::production_runtime) async fn extend_retained_parent_in(
        &self,
        tx: &mut SqliteConnection,
        parent: &RetainedParent,
        deadline: i64,
    ) -> Result<()> {
        if deadline <= parent.deadline || parent.deadline <= now(tx).await? {
            return Err(RuntimeStoreError::Fenced);
        }
        sqlx::query("UPDATE worker_provider_delegations SET parent_deadline_ms=? WHERE parent_run_id=? AND parent_lease_generation=? AND parent_dispatch_fence=? AND parent_deadline_ms=? AND state IN ('delegated','admitted')")
            .bind(deadline).bind(&parent.run).bind(parent.lease_generation)
            .bind(parent.dispatch_fence).bind(parent.deadline)
            .execute(&mut *tx).await.map_err(db)?;
        let lease = sqlx::query("UPDATE production_run_leases SET lease_deadline_ms=? WHERE run_id=? AND generation=? AND dispatch_fence=? AND lease_deadline_ms=? AND purpose='execution'")
            .bind(deadline).bind(&parent.run).bind(parent.lease_generation)
            .bind(parent.dispatch_fence).bind(parent.deadline)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        let run = sqlx::query("UPDATE production_runs SET lease_deadline_ms=? WHERE id=? AND state='awaiting_acceptance' AND lease_generation=? AND dispatch_fence=? AND lease_deadline_ms=?")
            .bind(deadline).bind(&parent.run).bind(parent.lease_generation)
            .bind(parent.dispatch_fence).bind(parent.deadline)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if lease != 1 || run != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
}

/// A parent Deep that committed its proposal at its current, still-live lease.
pub(in crate::production_runtime) struct RetainedParent {
    run: String,
    lease_generation: i64,
    dispatch_fence: i64,
    deadline: i64,
}

#[cfg(test)]
mod tests;
