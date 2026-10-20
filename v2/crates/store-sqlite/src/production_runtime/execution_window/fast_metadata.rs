//! Reattach only the Fast companion of the same gracefully closed predecessor.
use super::*;

impl Store {
    /// Trusted composition after binding the new window credential. No caller
    /// native identity, prior run, replay flag, or replacement authority is used.
    pub async fn authorize_window_fast_metadata(
        &self,
        credential: &str,
        binding: &Binding,
    ) -> Result<BoundSessionMetadata> {
        self.window_fast_metadata(
            credential,
            binding,
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            None,
        )
        .await
    }
    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    pub async fn authorize_window_fast_metadata_with_workspace(
        &self,
        credential: &str,
        binding: &Binding,
        workspace: &WorkspaceGrant,
    ) -> Result<BoundSessionMetadata> {
        self.window_fast_metadata(credential, binding, Some(workspace))
            .await
    }
    async fn window_fast_metadata(
        &self,
        credential: &str,
        binding: &Binding,
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))] workspace: Option<
            &WorkspaceGrant,
        >,
    ) -> Result<BoundSessionMetadata> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        if binding.role != Role::Fast || binding.parent_session_id.is_some() {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        if let Some(workspace) = workspace {
            self.workspace_grant_in(&mut tx, workspace).await?;
            if *workspace.exec_identity().2 != binding.conversation_id {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        let window = c
            .window_scope(&mut tx)
            .await?
            .ok_or(RuntimeStoreError::Fenced)?;
        self.window_metadata_in(&mut tx, binding).await?;
        if binding.state == SessionState::Starting {
            let grant = BoundSessionMetadata {
                context: c.clone(),
                binding: binding.clone(),
                parent_run: None,
                resume: None,
            };
            self.validate_metadata(&mut tx, &grant).await?;
            tx.commit().await.map_err(db)?;
            return Ok(grant);
        }
        // Deep reattachment deliberately marked other old bindings Lost. Only
        // this exact closed-window lineage can recover the companion metadata.
        if binding.state != SessionState::Lost || binding.provider_kind != c.provider {
            return Err(RuntimeStoreError::Fenced);
        }
        let predecessor: String =
            effective_predecessor(&mut tx, window.get("predecessor_window_id"))
                .await?
                .ok_or(RuntimeStoreError::Fenced)?;
        let prior = sqlx::query("SELECT r.id,t.event_id,r.incarnation_id FROM execution_windows w JOIN production_runs r ON r.context_id=w.context_id AND r.incarnation_id=w.incarnation_id JOIN production_terminal_evidence t ON t.run_id=r.id JOIN production_readiness rd ON rd.session_id=r.session_id JOIN session_bindings b ON b.id=r.session_id JOIN production_retirement_provenance g ON g.context_id=w.context_id AND g.incarnation_id=w.incarnation_id AND g.prior_run_id=w.terminal_run_id WHERE w.id=? AND w.owner_id=? AND w.conversation_id=? AND w.context_id=? AND w.state='closed' AND r.role='fast' AND r.session_id=? AND r.owner_id=w.owner_id AND r.conversation_id=w.conversation_id AND b.role='fast' AND b.state='lost' AND b.generation=r.binding_generation+1 AND b.native_session_id=r.native_session_id AND b.provider_kind=? AND b.provider_namespace=? AND rd.context_id=w.context_id AND rd.incarnation_id=w.incarnation_id AND NOT EXISTS(SELECT 1 FROM production_runs n WHERE n.session_id=r.session_id AND n.id!=r.id AND n.binding_generation>=r.binding_generation) AND NOT EXISTS(SELECT 1 FROM production_resume_metadata rm WHERE rm.prior_run_id=r.id)")
            .bind(predecessor).bind(c.owner.to_string()).bind(binding.conversation_id.to_string())
            .bind(&c.id).bind(binding.session_id.to_string()).bind(provider_name(c.provider)?).bind(&c.namespace)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        let row = sqlx::query("SELECT * FROM session_bindings WHERE id=?")
            .bind(binding.session_id.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if crate::runtime::binding(&row)? != *binding {
            return Err(RuntimeStoreError::Fenced);
        }
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        if let Some(workspace) = workspace {
            self.rebind_window_fast_workspace_in(
                &mut tx,
                workspace,
                binding,
                prior.get("incarnation_id"),
            )
            .await?;
        }
        let changed = sqlx::query("UPDATE production_readiness SET incarnation_id=? WHERE session_id=? AND context_id=? AND incarnation_id=?")
            .bind(&c.incarnation).bind(binding.session_id.to_string()).bind(&c.id)
            .bind(prior.get::<String,_>("incarnation_id")).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        sqlx::query("UPDATE session_bindings SET state='ready' WHERE id=? AND state='lost'")
            .bind(binding.session_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let mut ready = binding.clone();
        ready.state = SessionState::Ready;
        let run = RunId(prior.get::<String, _>("id").parse().map_err(db)?);
        self.reserve_terminal_metadata(tx, &run, &ready, prior.get("event_id"))
            .await
    }
}
