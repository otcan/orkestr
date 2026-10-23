//! Accepted-turn continuation setup. Original native reservation is immutable.
use super::*;
use orkestr_v2_contracts::{EventId, RunId};

pub(super) struct ResumeLink {
    id: String,
    prior_run: RunId,
    terminal_event: EventId,
}
impl ResumeLink {
    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    pub(super) fn workspace_identity(&self) -> &str {
        &self.id
    }
}
impl Store {
    /// Reserve setup once for the exact owner-accepted predecessor. Reopening or
    /// losing the grant never reissues it; uncertain setup requires reconciliation.
    /// This grants metadata I/O only, not dispatch or owner acceptance.
    pub async fn authorize_accepted_session_metadata(
        &self,
        credential: &str,
        prior_run: &RunId,
        binding: &Binding,
    ) -> Result<BoundSessionMetadata> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        let terminal: String = sqlx::query_scalar("SELECT event_id FROM production_acceptances WHERE run_id=? AND owner_id=? AND conversation_id=?")
            .bind(prior_run.to_string()).bind(c.owner.to_string()).bind(binding.conversation_id.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        self.reserve_terminal_metadata(tx, prior_run, binding, terminal)
            .await
    }
    pub(super) async fn reserve_terminal_metadata(
        &self,
        mut tx: sqlx::Transaction<'_, sqlx::Sqlite>,
        prior_run: &RunId,
        binding: &Binding,
        terminal: String,
    ) -> Result<BoundSessionMetadata> {
        let c = self.context()?;
        let grant = BoundSessionMetadata {
            context: c.clone(),
            binding: binding.clone(),
            parent_run: None,
            resume: Some(ResumeLink {
                id: Uuid::new_v4().to_string(),
                prior_run: prior_run.clone(),
                terminal_event: EventId(terminal.parse().map_err(db)?),
            }),
        };
        let link = grant.resume.as_ref().ok_or(RuntimeStoreError::Fenced)?;
        let existing: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM production_resume_metadata WHERE prior_run_id=? AND incarnation_id=?",
        )
        .bind(prior_run.to_string())
        .bind(&c.incarnation)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if existing != 0 {
            return Err(RuntimeStoreError::Conflict);
        }
        // Another incarnation's setup is never reused or overwritten. Only a
        // separately admitted successor window after proven retirement may
        // reserve again, and only when every earlier setup is confirmed.
        let previous: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM production_resume_metadata WHERE prior_run_id=?",
        )
        .bind(prior_run.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if previous != 0 {
            let window = c
                .window_scope(&mut tx)
                .await?
                .ok_or(RuntimeStoreError::Fenced)?;
            let valid: i64 = sqlx::query_scalar("SELECT count(*) FROM production_resume_metadata WHERE prior_run_id=? AND state='confirmed' AND context_id=? AND session_id=? AND binding_generation=? AND terminal_event_id=?")
                .bind(prior_run.to_string()).bind(&c.id).bind(binding.session_id.to_string())
                .bind(i64::try_from(binding.generation).map_err(db)?).bind(&terminal)
                .fetch_one(&mut *tx).await.map_err(db)?;
            if valid != previous
                || window.get::<&str, _>("state") != "opening"
                || window
                    .get::<Option<String>, _>("predecessor_window_id")
                    .is_none()
            {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        sqlx::query("INSERT INTO production_resume_metadata(id,prior_run_id,terminal_event_id,context_id,incarnation_id,session_id,binding_generation,state) VALUES(?,?,?,?,?,?,?,'issued')")
            .bind(&link.id).bind(prior_run.to_string()).bind(link.terminal_event.to_string()).bind(&c.id).bind(&c.incarnation)
            .bind(binding.session_id.to_string()).bind(i64::try_from(binding.generation).map_err(db)?)
            .execute(&mut *tx).await.map_err(db)?;
        self.validate_accepted_binding(&mut tx, &grant).await?;
        tx.commit().await.map_err(db)?;
        Ok(grant)
    }
    async fn validate_accepted_binding(
        &self,
        tx: &mut SqliteConnection,
        grant: &BoundSessionMetadata,
    ) -> Result<()> {
        let c = self.context()?;
        c.validate(tx).await?;
        self.window_metadata_in(tx, &grant.binding).await?;
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        self.validate_workspace_binding(tx, &grant.binding).await?;
        let link = grant.resume.as_ref().ok_or(RuntimeStoreError::Fenced)?;
        if c.id != grant.context.id
            || c.incarnation != grant.context.incarnation
            || c.owner != grant.context.owner
            || c.namespace != grant.context.namespace
            || c.provider != grant.context.provider
            || grant.parent_run.is_some()
            || !matches!(grant.binding.role, Role::Deep | Role::Fast)
            || grant.binding.state != SessionState::Ready
            || grant.binding.provider_kind != c.provider
            || grant.binding.native_session_id.is_none()
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let row = sqlx::query(
            "SELECT * FROM session_bindings WHERE id=? AND owner_id=? AND provider_namespace=?",
        )
        .bind(grant.binding.session_id.to_string())
        .bind(c.owner.to_string())
        .bind(&c.namespace)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::Fenced)?;
        if crate::runtime::binding(&row)? != grant.binding {
            return Err(RuntimeStoreError::Fenced);
        }
        let valid: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r JOIN production_readiness rd ON rd.session_id=r.session_id WHERE r.id=? AND r.owner_id=? AND r.conversation_id=? AND r.session_id=? AND r.context_id=? AND (r.incarnation_id=? OR EXISTS(SELECT 1 FROM production_resume_metadata rm WHERE rm.prior_run_id=r.id AND rm.context_id=r.context_id AND rm.incarnation_id=? AND rm.session_id=r.session_id)) AND r.role IN ('deep','fast') AND r.role=(SELECT role FROM session_bindings WHERE id=r.session_id) AND r.native_session_id=? AND r.provider_kind=? AND r.binding_generation+1=? AND ((r.state='succeeded' AND EXISTS(SELECT 1 FROM production_acceptances a WHERE a.run_id=r.id AND a.event_id=?)) OR (r.state='cancelled' AND EXISTS(SELECT 1 FROM production_observations o JOIN production_cancellations pc ON pc.run_id=r.id JOIN production_control_outbox co ON co.run_id=r.id WHERE o.run_id=r.id AND o.event_id=? AND o.kind='stopped' AND o.receipt_state='cancelled' AND o.lease_generation=r.lease_generation AND o.dispatch_fence=r.dispatch_fence AND pc.inflight_status='unknown' AND co.state='acknowledged')) OR (r.state='cancelled' AND EXISTS(SELECT 1 FROM production_run_abandonments ab JOIN production_terminal_evidence t ON t.run_id=ab.run_id AND t.event_id=ab.completion_event_id AND t.terminal_kind='abandoned' WHERE ab.run_id=r.id AND ab.completion_event_id=?)) OR (r.state='cancelled' AND EXISTS(SELECT 1 FROM production_run_lapses lp JOIN production_terminal_evidence t ON t.run_id=lp.run_id AND t.event_id=lp.evidence_event_id AND t.terminal_kind='failed' WHERE lp.run_id=r.id AND lp.evidence_event_id=?))) AND rd.context_id=r.context_id AND rd.incarnation_id=? AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=r.session_id AND other.id!=r.id AND other.binding_generation>=r.binding_generation)")
            .bind(link.prior_run.to_string()).bind(c.owner.to_string()).bind(grant.binding.conversation_id.to_string())
            .bind(grant.binding.session_id.to_string()).bind(&c.id).bind(&c.incarnation)
            .bind(&c.incarnation).bind(grant.binding.native_session_id.as_ref()).bind(provider_name(c.provider)?)
            .bind(i64::try_from(grant.binding.generation).map_err(db)?).bind(link.terminal_event.to_string()).bind(link.terminal_event.to_string()).bind(link.terminal_event.to_string()).bind(link.terminal_event.to_string()).bind(&c.incarnation)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if valid != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        // Stopped, abandoned or lapsed continuation must not reopen setup with unresolved
        // descendant effects. This validator runs at issuance, each actual-byte
        // metadata fence, and confirmation, including Claude process initialization.
        let stopped: i64 = sqlx::query_scalar("SELECT count(*) FROM production_terminal_evidence WHERE run_id=? AND terminal_kind IN ('stopped','abandoned','failed')")
            .bind(link.prior_run.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if stopped == 1 && !super::terminal_retirement::descendants_clear(tx, &c.id).await? {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
    pub(super) async fn validate_resume_metadata(
        &self,
        tx: &mut SqliteConnection,
        grant: &BoundSessionMetadata,
    ) -> Result<()> {
        self.validate_accepted_binding(tx, grant).await?;
        let link = grant.resume.as_ref().ok_or(RuntimeStoreError::Fenced)?;
        let valid:i64 = sqlx::query_scalar("SELECT count(*) FROM production_resume_metadata WHERE id=? AND prior_run_id=? AND terminal_event_id=? AND context_id=? AND incarnation_id=? AND session_id=? AND binding_generation=? AND state='issued'")
            .bind(&link.id).bind(link.prior_run.to_string()).bind(link.terminal_event.to_string()).bind(&grant.context.id).bind(&grant.context.incarnation)
            .bind(grant.binding.session_id.to_string()).bind(i64::try_from(grant.binding.generation).map_err(db)?)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if valid != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
    pub(super) async fn confirm_resumed_metadata(
        &self,
        grant: BoundSessionMetadata,
        evidence: NativeSessionConfirmation,
    ) -> Result<ReadySessionTransition> {
        if evidence.session_id != grant.binding.session_id
            || evidence.expected_generation != grant.binding.generation
            || Some(&evidence.native_session_id) != grant.binding.native_session_id.as_ref()
        {
            return Err(RuntimeStoreError::Conflict);
        }
        if !valid(&evidence.protocol_version) || !valid(&evidence.source_event_key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.validate_resume_metadata(&mut tx, &grant).await?;
        let link = grant.resume.as_ref().ok_or(RuntimeStoreError::Fenced)?;
        let digest = crate::runtime::ledger::hash(
            "accepted-session-metadata-v1",
            &[
                &evidence.native_session_id,
                &evidence.protocol_version,
                &evidence.source_event_key,
            ],
        );
        let changed=sqlx::query("UPDATE production_resume_metadata SET state='confirmed',confirmation_digest=? WHERE id=? AND state='issued'")
            .bind(digest).bind(&link.id).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        tx.commit().await.map_err(db)?;
        let ready = grant.binding.clone();
        Ok(ReadySessionTransition {
            metadata: grant,
            ready,
        })
    }
}
#[cfg(test)]
mod tests;

impl Store {
    pub(super) async fn consume_claude_resume_in(
        &self,
        tx: &mut SqliteConnection,
        grant: &BoundSessionMetadata,
        input: &super::claude_identity::ClaudeProcessInitialization,
    ) -> Result<()> {
        self.validate_resume_metadata(tx, grant).await?;
        let link = grant.resume.as_ref().ok_or(RuntimeStoreError::Fenced)?;
        let digest = crate::runtime::ledger::hash(
            "claude-process-initialized-v1",
            &[
                &input.requested_native_session_id,
                &input.protocol_version,
                &input.source_event_key,
            ],
        );
        let changed = sqlx::query("UPDATE production_resume_metadata SET state='confirmed',confirmation_digest=? WHERE id=? AND state='issued'")
            .bind(digest).bind(&link.id).execute(tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
}
