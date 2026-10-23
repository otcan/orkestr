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
    pub fn prior_run(&self) -> &RunId {
        &self.prior_run
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
        let row = retired_row_in(
            &mut tx,
            &owner,
            conversation,
            &config.namespace,
            &config.supervisor_key,
            None,
        )
        .await?;
        // A retired context continues only its own provider's native identity.
        if row.get::<String, _>("provider_kind") != provider_name(config.provider)? {
            return Err(RuntimeStoreError::Fenced);
        }
        let id: String = row.get("context_id");
        let binding_row = sqlx::query("SELECT * FROM session_bindings WHERE id=?")
            .bind(row.get::<String, _>("binding_id"))
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        let binding = crate::runtime::binding(&binding_row)?;
        let prior_run = RunId(row.get::<String, _>("prior_run").parse().map_err(db)?);
        let context = Context {
            owner,
            provider: config.provider,
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

/// Shared negative/identity check before issuance and before predecessor CAS.
pub(super) async fn retired_row_in(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    namespace: &str,
    key: &str,
    opening: Option<&str>,
) -> Result<SqliteRow> {
    all_prior_retired(tx, owner, conversation, namespace, key, opening).await?;
    let row = sqlx::query("SELECT s.*,w.id AS closed_window,r.id AS prior_run,b.id AS binding_id FROM execution_windows w JOIN production_supervisors s ON s.context_id=w.context_id AND s.incarnation_id=w.incarnation_id JOIN production_runs r ON r.id=w.terminal_run_id AND r.context_id=s.context_id AND r.incarnation_id=s.incarnation_id JOIN production_terminal_evidence t ON t.run_id=r.id JOIN session_bindings b ON b.id=r.session_id JOIN production_retirement_provenance g ON g.context_id=s.context_id AND g.incarnation_id=s.incarnation_id AND g.supervisor_generation=s.generation AND g.prior_run_id=r.id AND g.terminal_event_id=t.event_id AND g.session_id=b.id AND g.binding_generation=b.generation JOIN production_readiness rd ON rd.session_id=b.id AND rd.context_id=s.context_id AND rd.incarnation_id=s.incarnation_id WHERE w.owner_id=? AND w.conversation_id=? AND w.state='closed' AND w.generation=(SELECT max(latest.generation) FROM execution_windows latest WHERE latest.owner_id=w.owner_id AND latest.conversation_id=w.conversation_id AND latest.state='closed' AND NOT EXISTS(SELECT 1 FROM execution_window_open_failures f WHERE f.window_id=latest.id)) AND w.credential_issued=1 AND w.credential_bound=1 AND s.owner_id=w.owner_id AND s.provider_kind IN ('codex','claude') AND s.namespace=? AND s.supervisor_key=? AND s.lease_deadline_ms=0 AND r.owner_id=w.owner_id AND r.conversation_id=w.conversation_id AND r.role='deep' AND r.provider_kind=s.provider_kind AND b.owner_id=w.owner_id AND b.conversation_id=w.conversation_id AND b.role='deep' AND b.state='ready' AND b.provider_kind=s.provider_kind AND b.provider_namespace=s.namespace AND b.native_session_id=r.native_session_id AND b.generation=r.binding_generation+1 AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=r.session_id AND other.id!=r.id AND other.binding_generation>=r.binding_generation) AND NOT EXISTS(SELECT 1 FROM production_resume_metadata rm WHERE rm.prior_run_id=r.id AND (rm.state!='confirmed' OR rm.context_id!=r.context_id OR rm.session_id!=b.id OR rm.binding_generation!=b.generation OR rm.terminal_event_id!=t.event_id)) ORDER BY w.generation DESC LIMIT 1")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(namespace).bind(key)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
    Ok(row)
}

/// Supervisors belonging to one conversation: its derived namespace/key, any
/// context its windows used, or any context with readiness for its sessions.
pub(super) const CONVERSATION_SUPERVISORS: &str = "s.owner_id=? AND ((s.namespace=? AND s.supervisor_key=?) OR EXISTS(SELECT 1 FROM execution_windows cw WHERE cw.context_id=s.context_id AND cw.owner_id=s.owner_id AND cw.conversation_id=?) OR EXISTS(SELECT 1 FROM production_readiness cr JOIN session_bindings cb ON cb.id=cr.session_id WHERE cr.context_id=s.context_id AND cb.owner_id=s.owner_id AND cb.conversation_id=?))";

pub(super) async fn all_prior_retired(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    namespace: &str,
    key: &str,
    opening: Option<&str>,
) -> Result<()> {
    // Require every window, supervisor and run of THIS conversation to be
    // closed/genuinely retired. Never repair a lost active slot. Other
    // conversations are independent: the owner-wide live-window capacity and
    // the root manager's per-window budgets bound concurrent authority, and an
    // uncertain scope elsewhere can neither be bypassed nor block this one.
    let (owner, conversation) = (owner.to_string(), conversation.to_string());
    let windows: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_windows WHERE owner_id=? AND conversation_id=? AND state!='closed' AND (? IS NULL OR id!=?)")
        .bind(&owner).bind(&conversation).bind(opening).bind(opening)
        .fetch_one(&mut *tx).await.map_err(db)?;
    let supervisors: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM production_supervisors s WHERE {CONVERSATION_SUPERVISORS} AND (s.lease_deadline_ms!=0 OR NOT EXISTS(SELECT 1 FROM production_retirement_provenance g WHERE g.context_id=s.context_id AND g.incarnation_id=s.incarnation_id AND g.supervisor_generation=s.generation))"))
        .bind(&owner).bind(namespace).bind(key).bind(&conversation).bind(&conversation)
        .fetch_one(&mut *tx).await.map_err(db)?;
    let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r WHERE r.owner_id=? AND r.conversation_id=? AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id)")
        .bind(&owner).bind(&conversation)
        .fetch_one(&mut *tx).await.map_err(db)?;
    if windows + supervisors + runs != 0 {
        return Err(RuntimeStoreError::Fenced);
    }
    // Retired contexts of this conversation must not hide pending descendants.
    let contexts: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT s.context_id FROM production_supervisors s WHERE {CONVERSATION_SUPERVISORS}"
    ))
    .bind(&owner)
    .bind(namespace)
    .bind(key)
    .bind(&conversation)
    .bind(&conversation)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;
    for context in contexts {
        if !super::super::terminal_retirement::descendants_clear(tx, &context).await? {
            return Err(RuntimeStoreError::Fenced);
        }
    }
    Ok(())
}

impl Store {
    #[allow(clippy::too_many_arguments)]
    pub(in crate::production_runtime) async fn validate_window_retired_predecessor_in(
        &self,
        tx: &mut SqliteConnection,
        token_hash: &str,
        owner: &OwnerId,
        namespace: &str,
        key: &str,
        context: &str,
        incarnation: &str,
        prior_run: &RunId,
    ) -> Result<()> {
        let window = sqlx::query("SELECT * FROM execution_windows WHERE credential_hash=?")
            .bind(token_hash)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        let Some(window) = window else { return Ok(()) };
        if window.get::<&str, _>("state") != "opening"
            || window.get::<i64, _>("credential_bound") != 0
            || window.get::<String, _>("owner_id") != owner.to_string()
            || window.get::<Option<String>, _>("context_id").as_deref() != Some(context)
            || window.get::<Option<String>, _>("incarnation_id").as_deref() != Some(incarnation)
        {
            return Err(RuntimeStoreError::Fenced);
        }
        // Legacy first window can be associated with an already retired
        // pre-window supervisor. A window successor always proves its cut.
        let Some(declared) = window.get::<Option<String>, _>("predecessor_window_id") else {
            return Ok(());
        };
        // A failed opening in between is transparent; with none retired yet
        // there is nothing to reattach to.
        let predecessor = effective_predecessor(tx, Some(declared))
            .await?
            .ok_or(RuntimeStoreError::Fenced)?;
        let conversation = ConversationId(
            window
                .get::<String, _>("conversation_id")
                .parse()
                .map_err(db)?,
        );
        let opening: String = window.get("id");
        let retired =
            retired_row_in(tx, owner, &conversation, namespace, key, Some(&opening)).await?;
        if retired.get::<String, _>("closed_window") != predecessor
            || retired.get::<String, _>("context_id") != context
            || retired.get::<String, _>("incarnation_id") != incarnation
            || retired.get::<String, _>("prior_run") != prior_run.to_string()
        {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
}
