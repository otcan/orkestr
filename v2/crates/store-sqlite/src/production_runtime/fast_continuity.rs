//! Bounded Codex Fast continuity: one native child per window (capped), fresh
//! across windows. Old identities stay history.
use super::*;

impl Store {
    /// Negative setup cleanup after trusted composition proved no child was
    /// launched, or retained the original metadata-child EOF/wait witness.
    /// Never settles a run, creates a replacement, or releases an input.
    pub async fn retire_bounded_fast_setup(&self, credential: &str, setup: &Binding) -> Result<()> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        let window = c
            .window_scope(&mut tx)
            .await?
            .ok_or(RuntimeStoreError::Fenced)?;
        if c.provider != ProviderKind::Codex
            || setup.role != Role::Fast
            || setup.owner_id != c.owner
            || setup.state != SessionState::Starting
            || setup.native_session_id.is_some()
            || setup.provider_kind != ProviderKind::Unconfigured
            || window.get::<String, _>("conversation_id") != setup.conversation_id.to_string()
            || !matches!(
                window.get::<&str, _>("state"),
                "opening" | "active" | "retiring"
            )
            || window.get::<i64, _>("expires_at_ms") <= now(&mut tx).await?
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let changed = sqlx::query("UPDATE session_bindings SET state='retired' WHERE id=? AND owner_id=? AND conversation_id=? AND role='fast' AND parent_session_id IS NULL AND ((state='starting' AND native_session_id IS NULL AND generation=?) OR (state='ready' AND provider_kind='codex' AND generation=?)) AND EXISTS(SELECT 1 FROM production_fast_continuity c WHERE c.session_id=session_bindings.id AND c.context_id=? AND c.incarnation_id=?) AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.session_id=session_bindings.id)")
            .bind(setup.session_id.to_string()).bind(c.owner.to_string()).bind(setup.conversation_id.to_string())
            .bind(setup.generation as i64).bind(setup.generation.checked_add(1).ok_or(RuntimeStoreError::InvalidInput)? as i64)
            .bind(&c.id).bind(&c.incarnation).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }

    /// Trusted window scheduler only, after the original Fast child was reaped
    /// (or the predecessor window completed its full retirement protocol).
    /// This grants fresh metadata setup, never dispatch, acceptance or replay.
    pub async fn authorize_bounded_fast_metadata(
        &self,
        credential: &str,
        binding: &Binding,
    ) -> Result<BoundSessionMetadata> {
        self.bounded_fast_metadata(
            credential,
            binding,
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            None,
        )
        .await
    }

    #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
    pub async fn authorize_bounded_fast_metadata_with_workspace(
        &self,
        credential: &str,
        binding: &Binding,
        workspace: &WorkspaceGrant,
    ) -> Result<BoundSessionMetadata> {
        self.bounded_fast_metadata(credential, binding, Some(workspace))
            .await
    }

    async fn bounded_fast_metadata(
        &self,
        credential: &str,
        binding: &Binding,
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))] workspace: Option<
            &WorkspaceGrant,
        >,
    ) -> Result<BoundSessionMetadata> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        if c.provider != ProviderKind::Codex
            || binding.owner_id != c.owner
            || binding.role != Role::Fast
            || binding.parent_session_id.is_some()
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        let window = c
            .window_scope(&mut tx)
            .await?
            .ok_or(RuntimeStoreError::Fenced)?;
        self.window_metadata_in(&mut tx, binding).await?;
        let row = sqlx::query("SELECT * FROM session_bindings WHERE id=?")
            .bind(binding.session_id.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or(RuntimeStoreError::Fenced)?;
        if crate::runtime::binding(&row)? != *binding {
            return Err(RuntimeStoreError::Fenced);
        }
        if binding.state != SessionState::Starting
            && row.get::<String, _>("provider_namespace") != c.namespace
        {
            return Err(RuntimeStoreError::Fenced);
        }
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        if let Some(workspace) = workspace {
            self.workspace_grant_in(&mut tx, workspace).await?;
            if *workspace.exec_identity().2 != binding.conversation_id {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        let fresh = if binding.state == SessionState::Starting {
            if binding.native_session_id.is_some()
                || binding.provider_kind != ProviderKind::Unconfigured
            {
                return Err(RuntimeStoreError::Fenced);
            }
            sqlx::query("INSERT INTO production_fast_continuity(session_id,context_id,incarnation_id,created_at_ms) VALUES(?,?,?,?) ON CONFLICT(session_id) DO NOTHING")
                .bind(binding.session_id.to_string()).bind(&c.id).bind(&c.incarnation).bind(now(&mut tx).await?)
                .execute(&mut *tx).await.map_err(db)?;
            let current: i64 = sqlx::query_scalar("SELECT count(*) FROM production_fast_continuity WHERE session_id=? AND context_id=? AND incarnation_id=?")
                .bind(binding.session_id.to_string()).bind(&c.id).bind(&c.incarnation)
                .fetch_one(&mut *tx).await.map_err(db)?;
            if current != 1 {
                return Err(RuntimeStoreError::Fenced);
            }
            binding.clone()
        } else {
            // Auxiliary slot sessions present once and retire; only the
            // canonical slot-0 lineage is ever replaced or reattached.
            if binding.provider_kind != ProviderKind::Codex
                || binding.native_session_id.is_none()
                || row.try_get::<i64, _>("fast_slot").map_err(db)? != 0
            {
                return Err(RuntimeStoreError::Fenced);
            }
            let incarnation = match binding.state {
                SessionState::Ready => {
                    // Current-window replacement needs a real accepted/Stopped
                    // predecessor, never merely a terminal label or interrupt ACK.
                    let valid: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r JOIN production_terminal_evidence t ON t.run_id=r.id JOIN production_readiness rd ON rd.session_id=r.session_id WHERE r.session_id=? AND r.owner_id=? AND r.conversation_id=? AND r.context_id=? AND r.incarnation_id=? AND r.role='fast' AND r.native_session_id=? AND r.provider_kind='codex' AND r.binding_generation+1=? AND t.terminal_kind IN ('accepted','stopped') AND rd.context_id=r.context_id AND rd.incarnation_id=r.incarnation_id AND NOT EXISTS(SELECT 1 FROM production_runs n WHERE n.session_id=r.session_id AND n.id!=r.id AND n.binding_generation>=r.binding_generation)")
                        .bind(binding.session_id.to_string()).bind(c.owner.to_string()).bind(binding.conversation_id.to_string())
                        .bind(&c.id).bind(&c.incarnation).bind(&binding.native_session_id).bind(binding.generation as i64)
                        .fetch_one(&mut *tx).await.map_err(db)?;
                    if valid != 1 {
                        return Err(RuntimeStoreError::Fenced);
                    }
                    c.incarnation.clone()
                }
                SessionState::Lost => {
                    let predecessor = execution_window::effective_predecessor(
                        &mut tx,
                        window.get("predecessor_window_id"),
                    )
                    .await?
                    .ok_or(RuntimeStoreError::Fenced)?;
                    // Manager/child custody was settled by the existing closed
                    // window retirement, then Deep reattachment marked Fast Lost.
                    // An unused setup from a reconciled failed opening is safe
                    // only when its readiness was restored to this exact lineage.
                    let prior: Option<String> = sqlx::query_scalar("SELECT rd.incarnation_id FROM production_readiness rd JOIN execution_windows w ON w.context_id=rd.context_id AND w.incarnation_id=rd.incarnation_id JOIN production_retirement_provenance g ON g.context_id=w.context_id AND g.incarnation_id=w.incarnation_id AND g.prior_run_id=w.terminal_run_id WHERE rd.session_id=? AND rd.context_id=? AND w.id=? AND w.owner_id=? AND w.conversation_id=? AND w.state='closed' AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.session_id=rd.session_id AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id)) AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.session_id=rd.session_id AND r.binding_generation+1!=? AND NOT EXISTS(SELECT 1 FROM production_runs n WHERE n.session_id=r.session_id AND n.binding_generation>r.binding_generation))")
                        .bind(binding.session_id.to_string()).bind(&c.id).bind(predecessor)
                        .bind(c.owner.to_string()).bind(binding.conversation_id.to_string()).bind(binding.generation as i64)
                        .fetch_optional(&mut *tx).await.map_err(db)?;
                    prior.ok_or(RuntimeStoreError::Fenced)?
                }
                _ => return Err(RuntimeStoreError::Fenced),
            };
            let unresolved: i64 = sqlx::query_scalar("SELECT count(*) FROM production_resume_metadata WHERE session_id=? AND state!='confirmed'")
                .bind(binding.session_id.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
            if unresolved != 0 {
                return Err(RuntimeStoreError::Fenced);
            }
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            {
                if binding.state == SessionState::Lost {
                    if let Some(workspace) = workspace {
                        self.rebind_window_fast_workspace_in(
                            &mut tx,
                            workspace,
                            binding,
                            &incarnation,
                        )
                        .await?;
                    }
                }
                self.validate_workspace_binding(&mut tx, binding).await?;
            }
            #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
            let _ = incarnation;
            sqlx::query("UPDATE session_bindings SET state='retired' WHERE id=?")
                .bind(binding.session_id.to_string())
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            let row = sqlx::query("INSERT INTO session_bindings(id,owner_id,conversation_id,role) VALUES(?,?,?,'fast') RETURNING *")
                .bind(Uuid::new_v4().to_string()).bind(c.owner.to_string()).bind(binding.conversation_id.to_string())
                .fetch_one(&mut *tx).await.map_err(db)?;
            let fresh = crate::runtime::binding(&row)?;
            sqlx::query("INSERT INTO production_fast_continuity(session_id,predecessor_session_id,context_id,incarnation_id,created_at_ms) VALUES(?,?,?,?,?)")
                .bind(fresh.session_id.to_string()).bind(binding.session_id.to_string()).bind(&c.id).bind(&c.incarnation).bind(now(&mut tx).await?)
                .execute(&mut *tx).await.map_err(db)?;
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            sqlx::query("INSERT INTO workspace_session_projects(session_id,project_id,generation,context_id,incarnation_id) SELECT ?,project_id,generation,context_id,incarnation_id FROM workspace_session_projects WHERE session_id=? AND context_id=? AND incarnation_id=?")
                .bind(fresh.session_id.to_string()).bind(binding.session_id.to_string()).bind(&c.id).bind(&c.incarnation)
                .execute(&mut *tx).await.map_err(db)?;
            execution_window::handoff_context::bind(
                &mut tx,
                &c.owner,
                &fresh.conversation_id,
                &fresh.session_id.to_string(),
            )
            .await?;
            fresh
        };
        let grant = BoundSessionMetadata {
            context: c.clone(),
            binding: fresh,
            parent_run: None,
            resume: None,
        };
        self.validate_metadata(&mut tx, &grant).await?;
        tx.commit().await.map_err(db)?;
        Ok(grant)
    }
}

/// Negative retirement under the original clean teardown or manager-proven
/// reconciliation. Never reuse an unused reservation or erase its native ID.
pub(super) async fn retire_failed_setups(
    tx: &mut SqliteConnection,
    context: &str,
    incarnation: &str,
) -> Result<()> {
    #[cfg(test)]
    if legacy_fixture(tx).await? {
        return Ok(());
    }
    sqlx::query("UPDATE session_bindings SET state='retired' WHERE role='fast' AND state!='retired' AND id IN (SELECT session_id FROM production_fast_continuity WHERE context_id=? AND incarnation_id=?) AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.session_id=session_bindings.id)")
        .bind(context).bind(incarnation).execute(tx).await.map_err(db)?;
    Ok(())
}

/// Accepted Codex Fast turns one window may present on the same native child
/// before the scheduler rotates to a fresh bounded presentation. A successor
/// window always starts fresh, so native Fast history stays bounded twice.
pub(super) const MAX_WINDOW_FAST_TURNS: i64 = 8;

/// Same-child continuation stays inside the window that created the binding:
/// the continuity row and every earlier run on the session belong to this
/// exact supervisor context and incarnation (one window, one conversation),
/// every earlier run was accepted, and neither an earlier run nor the next
/// source is a timer input (a timer Fast turn only ever sees its fixed note).
/// A source that Stop later held never stays in a warm native history either:
/// the digest excludes it and its answer, so the session rotates instead.
async fn reusable_in(
    tx: &mut SqliteConnection,
    context: &str,
    incarnation: &str,
    session: &orkestr_v2_contracts::SessionId,
    source_event: &str,
) -> Result<(i64, bool)> {
    let row = sqlx::query("SELECT (SELECT count(*) FROM production_runs r WHERE r.session_id=?1) AS runs, (SELECT count(*) FROM production_runs r WHERE r.session_id=?1 AND (r.role!='fast' OR r.state!='succeeded' OR r.context_id!=?2 OR r.incarnation_id!=?3 OR EXISTS(SELECT 1 FROM dormant_timer_inputs t WHERE t.event_id=r.event_id) OR EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=r.event_id))) AS foreign_runs, (SELECT count(*) FROM production_fast_continuity f WHERE f.session_id=?1 AND f.context_id=?2 AND f.incarnation_id=?3) AS owned, (SELECT count(*) FROM dormant_timer_inputs t WHERE t.event_id=?4) AS timer")
        .bind(session.to_string()).bind(context).bind(incarnation).bind(source_event)
        .fetch_one(tx).await.map_err(db)?;
    let runs: i64 = row.get("runs");
    let reusable = runs > 0
        && runs < MAX_WINDOW_FAST_TURNS
        && row.get::<i64, _>("foreign_runs") == 0
        && row.get::<i64, _>("owned") == 1
        && row.get::<i64, _>("timer") == 0;
    Ok((runs, reusable))
}

/// Admission guard for a bounded Fast binding: a fresh session, or a
/// same-window continuation that [`Store::bounded_fast_reusable`] allows.
pub(super) async fn require_admissible(
    tx: &mut SqliteConnection,
    context: &str,
    incarnation: &str,
    session: &orkestr_v2_contracts::SessionId,
    source_event: &str,
) -> Result<()> {
    #[cfg(test)]
    if legacy_fixture(tx).await? {
        return Ok(());
    }
    let bounded: i64 =
        sqlx::query_scalar("SELECT count(*) FROM production_fast_continuity WHERE session_id=?")
            .bind(session.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
    if bounded == 0 {
        return Ok(());
    }
    match reusable_in(tx, context, incarnation, session, source_event).await? {
        (0, _) | (_, true) => Ok(()),
        _ => Err(RuntimeStoreError::Fenced),
    }
}

impl Store {
    /// Read-only scheduler query: may the next source continue on the same
    /// accepted Fast native child of this window? `false` means rotate to a
    /// fresh bounded presentation; it never grants dispatch by itself.
    pub async fn bounded_fast_reusable(
        &self,
        credential: &str,
        binding: &Binding,
        source_event: &orkestr_v2_contracts::EventId,
    ) -> Result<bool> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        if c.provider != ProviderKind::Codex
            || binding.owner_id != c.owner
            || binding.role != Role::Fast
            || binding.parent_session_id.is_some()
            || binding.state != SessionState::Ready
            || binding.provider_kind != ProviderKind::Codex
        {
            return Ok(false);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        c.validate(&mut tx).await?;
        let Some(window) = c.window_scope(&mut tx).await? else {
            return Ok(false);
        };
        if window.get::<String, _>("conversation_id") != binding.conversation_id.to_string() {
            return Ok(false);
        }
        let current: i64 = sqlx::query_scalar("SELECT count(*) FROM session_bindings WHERE id=? AND owner_id=? AND conversation_id=? AND role='fast' AND state='ready' AND generation=? AND provider_namespace=?")
            .bind(binding.session_id.to_string()).bind(c.owner.to_string()).bind(binding.conversation_id.to_string())
            .bind(binding.generation as i64).bind(&c.namespace)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if current != 1 {
            return Ok(false);
        }
        let (_, reusable) = reusable_in(
            &mut tx,
            &c.id,
            &c.incarnation,
            &binding.session_id,
            &source_event.to_string(),
        )
        .await?;
        tx.commit().await.map_err(db)?;
        Ok(reusable)
    }
}

#[cfg(test)]
pub(super) async fn legacy_fixture(tx: &mut SqliteConnection) -> Result<bool> {
    let version: i64 =
        sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations WHERE success=1")
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
    let tables: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('production_fast_continuity','production_fast_digests')")
        .fetch_one(tx).await.map_err(db)?;
    Ok(version < 77 && tables == 0)
}
