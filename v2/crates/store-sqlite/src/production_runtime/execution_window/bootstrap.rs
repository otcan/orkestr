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
        if !window_provider(config.provider)
            || !matches!(config.takeover, ProductionTakeover::First)
            || !valid(&config.namespace)
            || !valid(&config.supervisor_key)
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, browser_credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let history: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM production_supervisors WHERE owner_id=? AND provider_kind=? AND namespace=? AND supervisor_key=?) + (SELECT count(*) FROM execution_windows WHERE owner_id=? AND conversation_id=?) + (SELECT count(*) FROM production_runs WHERE owner_id=? AND conversation_id=?) + (SELECT count(*) FROM session_bindings WHERE owner_id=? AND conversation_id=?)")
            .bind(owner.to_string()).bind(provider_name(config.provider)?).bind(&config.namespace).bind(&config.supervisor_key)
            .bind(owner.to_string()).bind(conversation.to_string())
            .bind(owner.to_string()).bind(conversation.to_string())
            .bind(owner.to_string()).bind(conversation.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        if history != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        // A new conversation is not a way around its own unfinished or lost
        // context. Every previous scope of this conversation must have the same
        // durable retirement provenance required when recovering it. Other
        // conversations are bounded by the live-window capacity instead.
        retired_context::all_prior_retired(
            &mut tx,
            &owner,
            conversation,
            &config.namespace,
            &config.supervisor_key,
            None,
        )
        .await?;
        let secret = format!("window-bootstrap:{}", crate::runtime::ledger::secret());
        let hash = crate::digest(&secret);
        let context = Context {
            owner: owner.clone(),
            provider: config.provider,
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
        sqlx::query("INSERT INTO production_supervisors(context_id,owner_id,provider_kind,namespace,supervisor_key,incarnation_id,generation,lease_deadline_ms) VALUES(?,?,?,?,?,?,1,?)")
            .bind(&context.id).bind(owner.to_string()).bind(provider_name(context.provider)?).bind(&context.namespace).bind(&context.key)
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

/// Every window of this conversation failed to open (audited `failed`) and
/// none ever retired: there is no turn to resume, so the next opening
/// bootstraps again instead of recovering a retired predecessor.
async fn failed_first_lineage_in(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<bool> {
    let floor = native_reset::floor(tx, owner, conversation).await?;
    let (windows, failed, unclosed): (i64, i64, i64) = sqlx::query_as("SELECT count(*),count(f.id),coalesce(sum(w.state!='closed'),0) FROM execution_windows w LEFT JOIN execution_window_open_failures f ON f.window_id=w.id AND f.restored_window_id IS NULL WHERE w.owner_id=? AND w.conversation_id=? AND w.generation>?")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(floor)
        .fetch_one(&mut *tx).await.map_err(db)?;
    Ok((windows > 0 || floor > 0) && windows == failed && unclosed == 0)
}

impl Store {
    /// Read-only selector for the next opening's Core port. Durable state, not
    /// a failed attempt, decides: there is never a fallback between ports.
    pub async fn execution_window_failed_first_open_authenticated(
        &self,
        browser_credential: &str,
        conversation: &ConversationId,
    ) -> Result<bool> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, browser_credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let result = failed_first_lineage_in(&mut tx, &owner, conversation).await?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }

    /// First-window bootstrap again, after every earlier opening of this
    /// conversation was reconciled as `failed` before running anything. The
    /// fenced bootstrap supervisor is taken over (new incarnation, next
    /// generation) and the never-used Fast/Deep bindings are retired for fresh
    /// ones; no run, readiness or native identity is carried over.
    pub async fn rebootstrap_execution_window_authenticated(
        &self,
        browser_credential: &str,
        conversation: &ConversationId,
        config: ProductionSupervisorConfig,
    ) -> Result<ExecutionWindowBootstrap> {
        if !window_provider(config.provider)
            || !matches!(config.takeover, ProductionTakeover::First)
            || !valid(&config.namespace)
            || !valid(&config.supervisor_key)
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, browser_credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let floor = native_reset::floor(&mut tx, &owner, conversation).await?;
        let handoff =
            handoff_context::target(&mut tx, &owner, conversation, config.provider).await?;
        let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r WHERE r.owner_id=? AND r.conversation_id=? AND NOT EXISTS(SELECT 1 FROM execution_windows w WHERE w.context_id=r.context_id AND w.incarnation_id=r.incarnation_id AND w.generation<=?)")
        .bind(owner.to_string())
        .bind(conversation.to_string())
        .bind(floor)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if !failed_first_lineage_in(&mut tx, &owner, conversation).await? || runs != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        let clock = now(&mut tx).await?;
        let existing = sqlx::query("SELECT * FROM production_supervisors WHERE owner_id=? AND provider_kind=? AND namespace=? AND supervisor_key=?")
            .bind(owner.to_string()).bind(provider_name(config.provider)?).bind(&config.namespace).bind(&config.supervisor_key)
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let current = existing
            .as_ref()
            .map(|row| row.get::<String, _>("context_id"))
            .unwrap_or_default();
        // Every scope of this conversation is that one configured supervisor.
        let others: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM production_supervisors s WHERE {} AND s.context_id!=?",
            retired_context::CONVERSATION_SUPERVISORS
        ))
        .bind(owner.to_string())
        .bind(&config.namespace)
        .bind(&config.supervisor_key)
        .bind(conversation.to_string())
        .bind(conversation.to_string())
        .bind(&current)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if others != 0 && !handoff {
            return Err(RuntimeStoreError::Fenced);
        }
        if handoff {
            // Only an explicit matching handoff may cross providers, and every
            // old scope must still carry genuine retirement provenance now.
            retired_context::all_prior_retired(
                &mut tx,
                &owner,
                conversation,
                &config.namespace,
                &config.supervisor_key,
                None,
            )
            .await?;
        }
        let incarnation = Uuid::new_v4().to_string();
        let (id, generation) = match existing {
            Some(row) => {
                if row.get::<i64, _>("lease_deadline_ms") > clock {
                    return Err(RuntimeStoreError::Busy);
                }
                if !super::super::terminal_retirement::descendants_clear(&mut tx, &current).await? {
                    return Err(RuntimeStoreError::Fenced);
                }
                let generation = row
                    .get::<i64, _>("generation")
                    .checked_add(1)
                    .ok_or(RuntimeStoreError::Unavailable)?;
                let taken = sqlx::query("UPDATE production_supervisors SET incarnation_id=?,generation=?,lease_deadline_ms=? WHERE context_id=? AND incarnation_id=? AND generation=?")
                    .bind(&incarnation).bind(generation).bind(clock + 60_000).bind(&current)
                    .bind(row.get::<String, _>("incarnation_id")).bind(row.get::<i64, _>("generation"))
                    .execute(&mut *tx).await.map_err(db)?.rows_affected();
                if taken != 1 {
                    return Err(RuntimeStoreError::Fenced);
                }
                (current, generation)
            }
            None => {
                let id = Uuid::new_v4().to_string();
                sqlx::query("INSERT INTO production_supervisors(context_id,owner_id,provider_kind,namespace,supervisor_key,incarnation_id,generation,lease_deadline_ms) VALUES(?,?,?,?,?,?,1,?)")
                    .bind(&id).bind(owner.to_string()).bind(provider_name(config.provider)?).bind(&config.namespace).bind(&config.supervisor_key)
                    .bind(&incarnation).bind(clock + 60_000).execute(&mut *tx).await.map_err(db)?;
                (id, 1)
            }
        };
        // The never-used role bindings (no run ever existed) are retired, not
        // reused: their native setup belonged to the failed opening.
        sqlx::query("UPDATE session_bindings SET state='retired' WHERE owner_id=? AND conversation_id=? AND role IN ('fast','deep') AND state!='retired'")
            .bind(owner.to_string()).bind(conversation.to_string())
            .execute(&mut *tx).await.map_err(db)?;
        let secret = format!("window-bootstrap:{}", crate::runtime::ledger::secret());
        let hash = crate::digest(&secret);
        sqlx::query("INSERT INTO auth_sessions(token_hash,owner_id,expires_at) VALUES(?,?,unixepoch()+43200)")
            .bind(&hash).bind(owner.to_string()).execute(&mut *tx).await.map_err(db)?;
        let mut deep = None;
        for role in ["fast", "deep"] {
            let row = sqlx::query("INSERT INTO session_bindings(id,owner_id,conversation_id,role) VALUES(?,?,?,?) RETURNING *")
                .bind(Uuid::new_v4().to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(role)
                .fetch_one(&mut *tx).await.map_err(db)?;
            handoff_context::bind(&mut tx, &owner, conversation, row.get("id")).await?;
            if role == "deep" {
                deep = Some(crate::runtime::binding(&row)?);
            }
        }
        let binding = deep.ok_or(RuntimeStoreError::Unavailable)?;
        tx.commit().await.map_err(db)?;
        let mut store = self.clone();
        store.authority = Some(Context {
            owner,
            provider: config.provider,
            namespace: config.namespace,
            key: config.supervisor_key,
            id,
            incarnation,
            generation,
            token_hash: hash,
            window_bootstrap_only: true,
        });
        Ok(ExecutionWindowBootstrap {
            store,
            credential: secret,
            binding,
        })
    }
}
