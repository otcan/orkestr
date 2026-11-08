//! Proven gracefully retired supervisor restart, never recovery of an uncertain turn.
use super::*;
use orkestr_v2_contracts::{ConversationId, RunId};
mod diagnostics;
use diagnostics::{Diagnostics, Phase};

struct TerminalReattachment {
    store: Store,
    metadata: BoundSessionMetadata,
    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    workspace: Option<WorkspaceGrant>,
}

impl Store {
    /// Trusted server discovery only. Returned IDs are locators, not authority;
    /// reattach revalidates every predicate and exact predecessor under write lock.
    /// No credential, native identity or setup reservation is returned here.
    pub async fn terminal_supervisor_candidate(
        &self,
        credential: &str,
        config: &ProductionSupervisorConfig,
        conversation: &ConversationId,
    ) -> Result<Option<(RunId, String)>> {
        if credential.len() != 64 || !credential.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if !valid(&config.namespace) || !valid(&config.supervisor_key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner: String = sqlx::query_scalar(
            "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
        )
        .bind(crate::digest(credential))
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::Unauthorized)?;
        let candidate = sqlx::query("SELECT r.id,s.incarnation_id,s.context_id FROM production_supervisors s JOIN production_runs r ON r.context_id=s.context_id AND r.incarnation_id=s.incarnation_id JOIN production_terminal_evidence a ON a.run_id=r.id JOIN session_bindings b ON b.id=r.session_id JOIN production_retirement_provenance g ON g.context_id=s.context_id AND g.incarnation_id=s.incarnation_id AND g.supervisor_generation=s.generation AND g.prior_run_id=r.id AND g.terminal_event_id=a.event_id AND g.session_id=b.id AND g.binding_generation=b.generation WHERE s.lease_deadline_ms=0 AND s.owner_id=? AND s.provider_kind=? AND s.namespace=? AND s.supervisor_key=? AND r.conversation_id=? AND r.role IN ('deep','fast') AND b.state='ready' AND b.role=r.role AND b.provider_kind=r.provider_kind AND b.native_session_id=r.native_session_id AND b.generation=r.binding_generation+1 AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.context_id=s.context_id AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=other.id)) AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=r.session_id AND other.id!=r.id AND other.binding_generation>=r.binding_generation) AND NOT EXISTS(SELECT 1 FROM production_resume_metadata rm WHERE rm.prior_run_id=r.id)")
            .bind(owner).bind(provider_name(config.provider)?).bind(&config.namespace).bind(&config.supervisor_key).bind(conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let candidate = if let Some(row) = candidate {
            if super::terminal_retirement::descendants_clear(
                &mut tx,
                row.get::<&str, _>("context_id"),
            )
            .await?
            {
                Some(row)
            } else {
                None
            }
        } else {
            None
        };
        let result = candidate
            .map(|row| -> Result<_> {
                Ok((
                    RunId(row.get::<String, _>("id").parse().map_err(db)?),
                    row.get("incarnation_id"),
                ))
            })
            .transpose()?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
    /// Trusted configured restart after an owner-accepted or canonically Stopped Deep or Fast turn. Requires
    /// exact expired predecessor CAS and returns a single setup reservation in
    /// the same transaction. The server must prove its old owned child reaped.
    /// No historical run or consumed dispatch is reissued; queued input remains.
    pub async fn reattach_terminal_supervisor(
        &self,
        credential: &str,
        config: ProductionSupervisorConfig,
        prior_run: &RunId,
    ) -> Result<(Store, BoundSessionMetadata)> {
        let result = self
            .reattach_terminal_supervisor_inner(
                credential,
                config,
                prior_run,
                #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
                None,
            )
            .await?;
        Ok((result.store, result.metadata))
    }

    /// Exact local installation reattachment, at unchanged durable generation.
    /// The old association must match the proven predecessor before metadata is
    /// reserved in this same transaction. No path or new project is authorized.
    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    pub async fn reattach_terminal_supervisor_with_workspace(
        &self,
        credential: &str,
        config: ProductionSupervisorConfig,
        prior_run: &RunId,
        project: Uuid,
        installation: WorkspaceInstallation,
    ) -> Result<(Store, BoundSessionMetadata, WorkspaceGrant)> {
        let result = self
            .reattach_terminal_supervisor_inner(
                credential,
                config,
                prior_run,
                Some((project, installation)),
            )
            .await?;
        Ok((
            result.store,
            result.metadata,
            result.workspace.ok_or(RuntimeStoreError::Fenced)?,
        ))
    }

    async fn reattach_terminal_supervisor_inner(
        &self,
        credential: &str,
        config: ProductionSupervisorConfig,
        prior_run: &RunId,
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))] workspace: Option<(
            Uuid,
            WorkspaceInstallation,
        )>,
    ) -> Result<TerminalReattachment> {
        let mut diagnostics = Diagnostics::new();
        let result = self
            .reattach_terminal_supervisor_diagnosed(
                credential,
                config,
                prior_run,
                #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
                workspace,
                &mut diagnostics,
            )
            .await;
        diagnostics.emit(&result);
        result
    }

    async fn reattach_terminal_supervisor_diagnosed(
        &self,
        credential: &str,
        config: ProductionSupervisorConfig,
        prior_run: &RunId,
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))] mut workspace: Option<(
            Uuid,
            WorkspaceInstallation,
        )>,
        diagnostics: &mut Diagnostics,
    ) -> Result<TerminalReattachment> {
        if credential.len() != 64 || !credential.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let ProductionTakeover::ExpiredPredecessor { incarnation_id } = config.takeover else {
            return Err(RuntimeStoreError::InvalidInput);
        };
        let provider = provider_name(config.provider)?;
        if !valid(&config.namespace) || !valid(&config.supervisor_key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        diagnostics.enter(Phase::WorkspacePreflight);
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let mut physical = Some({
            let scope =
                sqlx::query("SELECT owner_id,conversation_id FROM production_runs WHERE id=?")
                    .bind(prior_run.to_string())
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(db)?
                    .ok_or(RuntimeStoreError::NotFound)?;
            let owner = OwnerId(scope.get::<String, _>("owner_id").parse().map_err(db)?);
            let conversation = ConversationId(
                scope
                    .get::<String, _>("conversation_id")
                    .parse()
                    .map_err(db)?,
            );
            if let Some((_, installation)) = &workspace {
                installation
                    .check_before_writer(self, &owner, &conversation)
                    .await?
            } else {
                self.check_workspace_before_writer(&owner, &conversation, None)
                    .await?
            }
        });
        for _attempt in 0..2 {
            let result = async {
                diagnostics.enter(Phase::BeginWriter);
                let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
                diagnostics.enter(Phase::AuthenticateOwner);
                let token_hash = crate::digest(credential);
                let owner: String = sqlx::query_scalar(
                    "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
                )
                .bind(&token_hash)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .ok_or(RuntimeStoreError::Unauthorized)?;
                diagnostics.enter(Phase::Supervisor);
                let row = sqlx::query("SELECT * FROM production_supervisors WHERE owner_id=? AND provider_kind=? AND namespace=? AND supervisor_key=?")
                    .bind(&owner).bind(provider).bind(&config.namespace).bind(&config.supervisor_key)
                    .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
                if row.get::<String, _>("incarnation_id") != incarnation_id {
                    return Err(RuntimeStoreError::Conflict);
                }
                let clock = now(&mut tx).await?;
                if row.get::<i64, _>("lease_deadline_ms") > clock {
                    return Err(RuntimeStoreError::Busy);
                }
                let context_id: String = row.get("context_id");
                // Natural expiry, revoked retirement and legacy deadline zero are not
                // graceful evidence. Match the immutable original decision before CAS.
                // Materialize only this exact prior run, preserving every canonical
                // terminal predicate without scanning unrelated history under the
                // short-lived physical handoff.
                diagnostics.enter(Phase::GracefulPredecessor);
                let graceful: i64 = sqlx::query_scalar("WITH terminal AS MATERIALIZED (SELECT * FROM production_terminal_evidence WHERE run_id=?) SELECT count(*) FROM production_retirement_provenance g JOIN production_runs r ON r.id=g.prior_run_id JOIN terminal a ON a.run_id=r.id JOIN session_bindings b ON b.id=r.session_id WHERE g.context_id=? AND g.incarnation_id=? AND g.supervisor_generation=? AND g.prior_run_id=? AND g.terminal_event_id=a.event_id AND g.session_id=r.session_id AND g.binding_generation=b.generation")
                    .bind(prior_run.to_string()).bind(&context_id).bind(&incarnation_id).bind(row.get::<i64,_>("generation"))
                    .bind(prior_run.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
                if row.get::<i64, _>("lease_deadline_ms") != 0 || graceful != 1 {
                    return Err(RuntimeStoreError::Fenced);
                }

                diagnostics.enter(Phase::RetiredWindowPredecessor);
                self.validate_window_retired_predecessor_in(
                    &mut tx,
                    &token_hash,
                    &OwnerId(owner.parse().map_err(db)?),
                    &config.namespace,
                    &config.supervisor_key,
                    &context_id,
                    &incarnation_id,
                    prior_run,
                )
                .await?;

                // Clean means no unresolved run anywhere in this supervisor namespace,
                // including children. Do not convert unknown delivery into a new attempt.
                diagnostics.enter(Phase::Descendants);
                let unresolved: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r WHERE context_id=? AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id)")
                    .bind(&context_id).fetch_one(&mut *tx).await.map_err(db)?;
                if unresolved != 0 {
                    return Err(RuntimeStoreError::Fenced);
                }
                if !super::terminal_retirement::descendants_clear(&mut tx, &context_id).await? {
                    return Err(RuntimeStoreError::Fenced);
                }
                diagnostics.enter(Phase::TerminalBinding);
                let terminal = sqlx::query("SELECT r.session_id,a.event_id FROM production_runs r JOIN production_terminal_evidence a ON a.run_id=r.id WHERE r.id=? AND r.owner_id=? AND r.context_id=? AND r.incarnation_id=? AND r.role IN ('deep','fast')")
                    .bind(prior_run.to_string()).bind(&owner).bind(&context_id).bind(&incarnation_id)
                    .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
                let session: String = terminal.get("session_id");
                let binding = sqlx::query(
                    "SELECT * FROM session_bindings WHERE id=? AND owner_id=? AND provider_namespace=?",
                )
                .bind(&session)
                .bind(&owner)
                .bind(&config.namespace)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
                let binding = crate::runtime::binding(&binding)?;
                diagnostics.enter(Phase::TakeoverRows);
                let generation = row
                    .get::<i64, _>("generation")
                    .checked_add(1)
                    .ok_or(RuntimeStoreError::Unavailable)?;
                let incarnation = Uuid::new_v4().to_string();
                sqlx::query("UPDATE production_supervisors SET incarnation_id=?,generation=?,lease_deadline_ms=? WHERE context_id=?")
                    .bind(&incarnation).bind(generation).bind(clock+60_000).bind(&context_id).execute(&mut *tx).await.map_err(db)?;
                let changed = sqlx::query("UPDATE production_readiness SET incarnation_id=? WHERE context_id=? AND incarnation_id=? AND session_id=?")
                    .bind(&incarnation).bind(&context_id).bind(&incarnation_id).bind(&session).execute(&mut *tx).await.map_err(db)?.rows_affected();
                if changed != 1 {
                    return Err(RuntimeStoreError::Fenced);
                }
                // Other old setup bindings cannot be used as if their process survived.
                sqlx::query("UPDATE session_bindings SET state='lost' WHERE id!=? AND state!='retired' AND id IN (SELECT session_id FROM production_readiness WHERE context_id=?)")
                    .bind(&session).bind(&context_id).execute(&mut *tx).await.map_err(db)?;
                let store = Store {
                    #[cfg(feature = "fixture-test-controls")]
                    production_checkpoint: None,
                    deep_burst_quiet_ms: self.deep_burst_quiet_ms,
                    agent_timer_daily: self.agent_timer_daily,
                    pool: self.pool.clone(),
                    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
                    workspace_handles: self.workspace_handles.clone(),
                    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
                    workspace_check: None,
                    authority: Some(Context {
                        owner: OwnerId(owner.parse().map_err(db)?),
                        provider: config.provider,
                        namespace: config.namespace.clone(),
                        key: config.supervisor_key.clone(),
                        id: context_id,
                        incarnation,
                        generation,
                        token_hash,
                        window_bootstrap_only: false,
                    }),
                };
                diagnostics.enter(Phase::PhysicalHandoff);
                #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
                let checked = match physical.as_ref().ok_or(RuntimeStoreError::Fenced)?
                    .after_verified_takeover(&store) {
                    Ok(checked) => checked,
                    Err(error) => {
                        // Fresh Root IPC is forbidden until the original writer has
                        // actually released every tentative takeover/readiness change.
                        tx.rollback().await.map_err(db)?;
                        return Err(error);
                    }
                };
                #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
                let scoped = &*checked;
                #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
                let scoped = &store;
                diagnostics.enter(Phase::RebindWindow);
                scoped
                    .rebind_execution_window_in(&mut tx, &incarnation_id)
                    .await?;
                diagnostics.enter(Phase::RebindWorkspace);
                #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
                let workspace_grant = if let Some((project, installation)) = workspace.take() {
                    Some(
                        scoped
                            .rebind_terminal_workspace_in(
                                &mut tx,
                                &binding,
                                &incarnation_id,
                                project,
                                installation,
                            )
                            .await?,
                    )
                } else {
                    None
                };
                diagnostics.enter(Phase::ReserveMetadata);
                let grant = scoped
                    .reserve_terminal_metadata(tx, prior_run, &binding, terminal.get("event_id"))
                    .await?;
                Ok(TerminalReattachment {
                    store,
                    metadata: grant,
                    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
                    workspace: workspace_grant,
                })
            }.await;
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            if _attempt == 0 && matches!(&result, Err(RuntimeStoreError::Fenced)) {
                if let Some(proof) = physical.take() {
                    if proof.terminal_handoff_refresh_eligible() {
                        diagnostics.enter(Phase::WorkspacePreflight);
                        if let Some(fresh) = proof.refresh_terminal_handoff(self).await? {
                            physical = Some(fresh);
                            continue;
                        }
                    }
                }
            }
            return result;
        }
        Err(RuntimeStoreError::Fenced)
    }
}
#[cfg(test)]
mod tests;
