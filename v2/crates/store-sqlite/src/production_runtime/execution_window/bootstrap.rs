use super::*;

/// Private initial authority, returned once after current browser authentication.
/// No Clone, Debug or serialization; never expose this through HTTP.
pub struct ExecutionWindowBootstrap {
    store: Store,
    credential: String,
    binding: Binding,
}
impl ExecutionWindowBootstrap {
    pub fn store(&self) -> &Store {
        &self.store
    }
    pub fn credential(&self) -> &str {
        &self.credential
    }
    pub fn binding(&self) -> &Binding {
        &self.binding
    }
}
impl Store {
    pub(super) fn window_issuance_credential(&self, credential: &str) -> Result<()> {
        if !self.context()?.window_bootstrap_only {
            return self.worker_credential(credential);
        }
        let secret = credential
            .strip_prefix("window-bootstrap:")
            .ok_or(RuntimeStoreError::Unauthorized)?;
        if secret.len() != 64
            || !secret.bytes().all(|b| b.is_ascii_hexdigit())
            || crate::digest(credential) != self.context()?.token_hash
        {
            return Err(RuntimeStoreError::Unauthorized);
        }
        Ok(())
    }

    /// Trusted configured Codex Deep composition only, before the first window
    /// admission. Lost reply is reconciliation, never bootstrap reissuance.
    pub async fn bootstrap_execution_window_authenticated(
        &self,
        browser_credential: &str,
        conversation: &ConversationId,
        config: ProductionSupervisorConfig,
    ) -> Result<ExecutionWindowBootstrap> {
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
        let history: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM production_supervisors WHERE owner_id=? AND provider_kind='codex' AND namespace=? AND supervisor_key=?) + (SELECT count(*) FROM execution_windows WHERE owner_id=? AND conversation_id=?) + (SELECT count(*) FROM production_runs WHERE owner_id=? AND conversation_id=?) + (SELECT count(*) FROM session_bindings WHERE owner_id=? AND conversation_id=?)")
            .bind(owner.to_string()).bind(&config.namespace).bind(&config.supervisor_key)
            .bind(owner.to_string()).bind(conversation.to_string())
            .bind(owner.to_string()).bind(conversation.to_string())
            .bind(owner.to_string()).bind(conversation.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        if history != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        // A new conversation is not a way around an unfinished or lost owner
        // context. Every previous scope must have the same durable retirement
        // provenance required when recovering an existing conversation.
        retired_context::all_prior_retired(&mut tx, &owner, None).await?;
        let secret = format!("window-bootstrap:{}", crate::runtime::ledger::secret());
        let hash = crate::digest(&secret);
        let context = Context {
            owner: owner.clone(),
            provider: ProviderKind::Codex,
            namespace: config.namespace,
            key: config.supervisor_key,
            id: Uuid::new_v4().to_string(),
            incarnation: Uuid::new_v4().to_string(),
            generation: 1,
            token_hash: hash.clone(),
            window_bootstrap_only: true,
        };
        let clock = now(&mut tx).await?;
        sqlx::query("INSERT INTO auth_sessions(token_hash,owner_id,expires_at) VALUES(?,?,unixepoch()+43200)")
            .bind(hash).bind(owner.to_string()).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO production_supervisors(context_id,owner_id,provider_kind,namespace,supervisor_key,incarnation_id,generation,lease_deadline_ms) VALUES(?,?,'codex',?,?,?,1,?)")
            .bind(&context.id).bind(owner.to_string()).bind(&context.namespace).bind(&context.key)
            .bind(&context.incarnation).bind(clock+60_000).execute(&mut *tx).await.map_err(db)?;
        let mut deep = None;
        // Same ordinary unconfigured Starting role records as ensure_role_bindings;
        // no readiness, native identity, run or dispatch authority is fabricated.
        for role in ["fast", "deep"] {
            let row = sqlx::query("INSERT INTO session_bindings(id,owner_id,conversation_id,role) VALUES(?,?,?,?) RETURNING *")
                .bind(Uuid::new_v4().to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(role)
                .fetch_one(&mut *tx).await.map_err(db)?;
            if role == "deep" {
                deep = Some(crate::runtime::binding(&row)?);
            }
        }
        let binding = deep.ok_or(RuntimeStoreError::Unavailable)?;
        tx.commit().await.map_err(db)?;
        let mut store = self.clone();
        store.authority = Some(context);
        Ok(ExecutionWindowBootstrap {
            store,
            credential: secret,
            binding,
        })
    }
}
