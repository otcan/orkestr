use super::*;

/// Browser-authenticated discovery of already committed graceful retirement.
/// No credential, Clone, Debug or serialization; not execution authority.
pub struct RetiredExecutionWindowContext {
    store: Store,
    prior_run: RunId,
    binding: Binding,
}
impl RetiredExecutionWindowContext {
    pub fn store(&self) -> &Store {
        &self.store
    }
    pub fn prior_run_id(&self) -> &RunId {
        &self.prior_run
    }
    pub fn binding(&self) -> &Binding {
        &self.binding
    }
    pub fn predecessor_incarnation(&self) -> &str {
        // Construction always installs this exact retired context.
        &self
            .store
            .authority
            .as_ref()
            .expect("retired context")
            .incarnation
    }
}
impl Store {
    /// Called on an unbound Store, before admitting a successor window. This
    /// reads only proven CLOSED history; expiry or absence of effects is not
    /// retirement. Issuance and reattachment revalidate under their own locks.
    pub async fn recover_retired_execution_window_authenticated(
        &self,
        browser_credential: &str,
        conversation: &ConversationId,
        config: ProductionSupervisorConfig,
    ) -> Result<RetiredExecutionWindowContext> {
        if config.provider != ProviderKind::Codex
            || !matches!(config.takeover, ProductionTakeover::First)
            || !valid(&config.namespace)
            || !valid(&config.supervisor_key)
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, browser_credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        // Require every owner window closed and every supervisor genuinely
        // retired, including other namespaces. Never repair a lost active slot.
        let unresolved: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM execution_windows WHERE owner_id=? AND state!='closed') + (SELECT count(*) FROM production_supervisors s WHERE s.owner_id=? AND (s.lease_deadline_ms!=0 OR NOT EXISTS(SELECT 1 FROM production_retirement_provenance g WHERE g.context_id=s.context_id AND g.incarnation_id=s.incarnation_id AND g.supervisor_generation=s.generation))) + (SELECT count(*) FROM production_runs r WHERE r.owner_id=? AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id))")
            .bind(owner.to_string()).bind(owner.to_string()).bind(owner.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        if unresolved != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        let row = sqlx::query("SELECT s.*,r.id AS prior_run,b.id AS binding_id FROM execution_windows w JOIN production_supervisors s ON s.context_id=w.context_id AND s.incarnation_id=w.incarnation_id JOIN production_runs r ON r.id=w.terminal_run_id AND r.context_id=s.context_id AND r.incarnation_id=s.incarnation_id JOIN production_terminal_evidence t ON t.run_id=r.id JOIN session_bindings b ON b.id=r.session_id JOIN production_retirement_provenance g ON g.context_id=s.context_id AND g.incarnation_id=s.incarnation_id AND g.supervisor_generation=s.generation AND g.prior_run_id=r.id AND g.terminal_event_id=t.event_id AND g.session_id=b.id AND g.binding_generation=b.generation JOIN production_readiness rd ON rd.session_id=b.id AND rd.context_id=s.context_id AND rd.incarnation_id=s.incarnation_id WHERE w.owner_id=? AND w.conversation_id=? AND w.state='closed' AND w.credential_issued=1 AND w.credential_bound=1 AND s.owner_id=w.owner_id AND s.provider_kind='codex' AND s.namespace=? AND s.supervisor_key=? AND s.lease_deadline_ms=0 AND r.owner_id=w.owner_id AND r.conversation_id=w.conversation_id AND r.role='deep' AND r.provider_kind=s.provider_kind AND b.owner_id=w.owner_id AND b.conversation_id=w.conversation_id AND b.role='deep' AND b.state='ready' AND b.provider_kind='codex' AND b.provider_namespace=s.namespace AND b.native_session_id=r.native_session_id AND b.generation=r.binding_generation+1 AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=r.session_id AND other.id!=r.id AND other.binding_generation>=r.binding_generation) AND NOT EXISTS(SELECT 1 FROM production_resume_metadata rm WHERE rm.prior_run_id=r.id) ORDER BY w.generation DESC LIMIT 1")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&config.namespace).bind(&config.supervisor_key)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        let id: String = row.get("context_id");
        if !super::super::terminal_retirement::descendants_clear(&mut tx, &id).await? {
            return Err(RuntimeStoreError::Fenced);
        }
        // Other retired namespaces must not hide pending descendant effects.
        let contexts: Vec<String> =
            sqlx::query_scalar("SELECT context_id FROM production_supervisors WHERE owner_id=?")
                .bind(owner.to_string())
                .fetch_all(&mut *tx)
                .await
                .map_err(db)?;
        for context in contexts {
            if !super::super::terminal_retirement::descendants_clear(&mut tx, &context).await? {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        let binding_row = sqlx::query("SELECT * FROM session_bindings WHERE id=?")
            .bind(row.get::<String, _>("binding_id"))
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        let binding = crate::runtime::binding(&binding_row)?;
        let prior_run = RunId(row.get::<String, _>("prior_run").parse().map_err(db)?);
        let context = Context {
            owner,
            provider: ProviderKind::Codex,
            namespace: config.namespace,
            key: config.supervisor_key,
            id,
            incarnation: row.get("incarnation_id"),
            generation: row.get("generation"),
            token_hash: String::new(),
            window_bootstrap_only: false,
        };
        tx.commit().await.map_err(db)?;
        let mut store = self.clone();
        store.authority = Some(context);
        Ok(RetiredExecutionWindowContext {
            store,
            prior_run,
            binding,
        })
    }
}
