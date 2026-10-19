use super::*;
impl Store {
    async fn transition_execution_window(
        &self,
        credential: &str,
        window: Uuid,
        generation: u64,
        boot: &str,
        target: &str,
    ) -> Result<ExecutionWindowStatus> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        if target == "reconciliation_required" {
            c.authenticate(&mut tx).await?;
        } else {
            c.validate(&mut tx).await?;
        }
        let w = window_in(&mut tx, c, window, generation).await?;
        if w.get::<Option<String>, _>("boot_id").as_deref() != Some(boot)
            || w.get::<Option<String>, _>("credential_hash").as_deref() != Some(&c.token_hash)
            || w.get::<i64, _>("credential_bound") != 1
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let prior = w.get::<&str, _>("state");
        let allowed = match target {
            "active" => {
                matches!(prior, "opening" | "active")
                    && w.get::<i64, _>("work_deadline_ms") > now(&mut tx).await?
            }
            "retiring" => matches!(prior, "active" | "retiring"),
            "reconciliation_required" => prior != "closed",
            _ => false,
        };
        if !allowed {
            return Err(RuntimeStoreError::Fenced);
        }
        sqlx::query("UPDATE execution_windows SET state=? WHERE id=?")
            .bind(target)
            .bind(window.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let w = window_in(&mut tx, c, window, generation).await?;
        let result = status(&w)?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
    pub async fn activate_execution_window(
        &self,
        credential: &str,
        window: Uuid,
        generation: u64,
        boot: &str,
    ) -> Result<ExecutionWindowStatus> {
        self.transition_execution_window(credential, window, generation, boot, "active")
            .await
    }
    pub async fn begin_execution_window_retirement(
        &self,
        credential: &str,
        window: Uuid,
        generation: u64,
        boot: &str,
    ) -> Result<ExecutionWindowStatus> {
        self.transition_execution_window(credential, window, generation, boot, "retiring")
            .await
    }
    pub async fn mark_execution_window_uncertain(
        &self,
        credential: &str,
        window: Uuid,
        generation: u64,
        boot: &str,
    ) -> Result<ExecutionWindowStatus> {
        self.transition_execution_window(
            credential,
            window,
            generation,
            boot,
            "reconciliation_required",
        )
        .await
    }
    /// Trusted teardown only, after original Runtime parent/descendant reap proof.
    /// The separate terminal retirement port must already have committed its
    /// immutable evidence. No process boolean or PID is accepted here.
    pub async fn retire_execution_window(
        &self,
        credential: &str,
        window: Uuid,
        generation: u64,
        boot: &str,
        prior_run: &RunId,
    ) -> Result<(Store, ExecutionWindowRetirement)> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.authenticate(&mut tx).await?;
        let w = window_in(&mut tx, c, window, generation).await?;
        if w.get::<Option<String>, _>("boot_id").as_deref() != Some(boot)
            || w.get::<Option<String>, _>("credential_hash").as_deref() != Some(&c.token_hash)
            || !matches!(
                w.get::<&str, _>("state"),
                "retiring" | "reconciliation_required"
            )
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let count:i64=sqlx::query_scalar("SELECT count(*) FROM production_retirement_provenance p JOIN production_supervisors s ON s.context_id=p.context_id JOIN production_runs r ON r.id=p.prior_run_id JOIN execution_window_inputs i ON i.event_id=r.event_id WHERE p.context_id=? AND p.incarnation_id=? AND p.supervisor_generation=? AND p.prior_run_id=? AND s.incarnation_id=p.incarnation_id AND s.generation=p.supervisor_generation AND s.lease_deadline_ms=0 AND i.window_id=?")
            .bind(&c.id).bind(&c.incarnation).bind(c.generation).bind(prior_run.to_string()).bind(window.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if count != 1
            || !super::super::terminal_retirement::descendants_clear(&mut tx, &c.id).await?
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let terminal = sqlx::query("SELECT t.event_id,t.terminal_kind FROM production_terminal_evidence t JOIN production_retirement_provenance p ON p.prior_run_id=t.run_id AND p.terminal_event_id=t.event_id WHERE t.run_id=? AND p.context_id=? AND p.incarnation_id=? AND p.supervisor_generation=?")
            .bind(prior_run.to_string()).bind(&c.id).bind(&c.incarnation).bind(c.generation)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        let terminal_event = EventId(terminal.get::<String, _>("event_id").parse().map_err(db)?);
        let outcome: String = terminal.get("terminal_kind");
        if !matches!(outcome.as_str(), "accepted" | "stopped") {
            return Err(RuntimeStoreError::Fenced);
        }
        sqlx::query("UPDATE execution_windows SET state='closed',terminal_run_id=? WHERE id=?")
            .bind(prior_run.to_string())
            .bind(window.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        // Retain the existing authenticated retirement identity, not a newly
        // minted token/budget. The next issuance is separately one-shot.
        Ok((
            self.clone(),
            ExecutionWindowRetirement {
                secret: credential.into(),
                run: prior_run.clone(),
                terminal_event,
                outcome,
            },
        ))
    }
}

impl Store {
    /// Negative-only cold-start reconciliation. Original browser auth cannot
    /// recover a lost private token, close terminal evidence, or create budget.
    pub async fn reconcile_execution_window_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        window: Uuid,
        generation: u64,
    ) -> Result<ExecutionWindowStatus> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        let w = sqlx::query("SELECT * FROM execution_windows WHERE id=? AND owner_id=? AND conversation_id=? AND generation=?")
            .bind(window.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .bind(i64::try_from(generation).map_err(db)?).fetch_optional(&mut *tx).await.map_err(db)?
            .ok_or(RuntimeStoreError::Fenced)?;
        if w.get::<&str, _>("state") == "closed" {
            return Err(RuntimeStoreError::Fenced);
        }
        sqlx::query("UPDATE execution_windows SET state='reconciliation_required' WHERE id=?")
            .bind(window.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let mut result = status(&w)?;
        result.state = ExecutionWindowState::ReconciliationRequired;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
}
