use super::*;
/// Private same-owner machine token. No Debug/Clone/serde; never HTTP output.
pub struct ExecutionWindowCredential {
    secret: String,
    window: Uuid,
    generation: u64,
    boot: String,
}
impl ExecutionWindowCredential {
    pub fn credential(&self) -> &str {
        &self.secret
    }
    pub fn window_id(&self) -> Uuid {
        self.window
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn boot_id(&self) -> &str {
        &self.boot
    }
}
/// Original credential retained after proven terminal retirement. Lost reply
/// is reconciliation, never reissuance. It grants no execution window by itself.
pub struct ExecutionWindowRetirement {
    pub(super) secret: String,
    pub(super) run: RunId,
    pub(super) terminal_event: EventId,
    pub(super) outcome: String,
}
impl ExecutionWindowRetirement {
    /// Exact canonical terminal evidence, committed before this handoff exists.
    pub fn terminal_event_id(&self) -> &EventId {
        &self.terminal_event
    }
    pub fn run_id(&self) -> &RunId {
        &self.run
    }
    /// Canonical terminal kind: only `accepted` or `stopped`.
    pub fn outcome(&self) -> &str {
        &self.outcome
    }
    pub fn credential(&self) -> &str {
        &self.secret
    }
}
impl Store {
    /// Root-manager ACK has already passed private IPC authentication. The caller
    /// supplies its exact immutable boot/window/generation/deadline/digest tuple.
    /// No reissue, even after a lost reply or process restart.
    pub async fn issue_execution_window_credential(
        &self,
        credential: &str,
        window: Uuid,
        generation: u64,
        boot_id: &str,
        expires_at_ms: i64,
        manager_ack_digest: &str,
    ) -> Result<ExecutionWindowCredential> {
        self.issue_window_credential_in_mode(
            credential,
            window,
            generation,
            boot_id,
            expires_at_ms,
            manager_ack_digest,
            false,
        )
        .await
    }
    /// Current browser owner may bootstrap a new private credential only after
    /// exact graceful retirement; this never repairs unresolved expired lineage.
    pub async fn issue_idle_execution_window_credential_authenticated(
        &self,
        browser_credential: &str,
        window: Uuid,
        generation: u64,
        boot_id: &str,
        expires_at_ms: i64,
        manager_ack_digest: &str,
    ) -> Result<ExecutionWindowCredential> {
        self.issue_window_credential_in_mode(
            browser_credential,
            window,
            generation,
            boot_id,
            expires_at_ms,
            manager_ack_digest,
            true,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)]
    async fn issue_window_credential_in_mode(
        &self,
        credential: &str,
        window: Uuid,
        generation: u64,
        boot_id: &str,
        expires_at_ms: i64,
        manager_ack_digest: &str,
        idle_owner: bool,
    ) -> Result<ExecutionWindowCredential> {
        if !idle_owner {
            self.window_issuance_credential(credential)?;
        }
        let c = self.context()?;
        if !window_provider(c.provider)
            || !valid(boot_id)
            || manager_ack_digest.len() != 64
            || !manager_ack_digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        if idle_owner {
            let mut public = self.clone();
            public.authority = None;
            if browser_owner(&public, &mut tx, credential).await? != c.owner {
                return Err(RuntimeStoreError::Unauthorized);
            }
            let retired: i64 = sqlx::query_scalar("SELECT count(*) FROM production_supervisors s JOIN production_retirement_provenance p ON p.context_id=s.context_id AND p.incarnation_id=s.incarnation_id AND p.supervisor_generation=s.generation WHERE s.context_id=? AND s.incarnation_id=? AND s.generation=? AND s.lease_deadline_ms=0")
                .bind(&c.id).bind(&c.incarnation).bind(c.generation).fetch_one(&mut *tx).await.map_err(db)?;
            let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_windows WHERE context_id=? AND credential_issued=1 AND state!='closed'")
                .bind(&c.id).fetch_one(&mut *tx).await.map_err(db)?;
            if retired != 1 || pending != 0 {
                return Err(RuntimeStoreError::Fenced);
            }
        } else {
            c.authenticate(&mut tx).await?;
        }
        let current:i64=sqlx::query_scalar("SELECT count(*) FROM production_supervisors WHERE context_id=? AND owner_id=? AND incarnation_id=? AND generation=?")
            .bind(&c.id).bind(c.owner.to_string()).bind(&c.incarnation).bind(c.generation)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if current != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        let deadline: i64 = sqlx::query_scalar(
            "SELECT lease_deadline_ms FROM production_supervisors WHERE context_id=?",
        )
        .bind(&c.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if deadline <= now(&mut tx).await? {
            let retired:i64=sqlx::query_scalar("SELECT count(*) FROM production_retirement_provenance WHERE context_id=? AND incarnation_id=? AND supervisor_generation=?")
                .bind(&c.id).bind(&c.incarnation).bind(c.generation).fetch_one(&mut *tx).await.map_err(db)?;
            if deadline != 0 || retired != 1 {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        let row = window_in(&mut tx, c, window, generation).await?;
        if idle_owner && c.token_hash.is_empty() {
            let conversation = ConversationId(
                row.get::<String, _>("conversation_id")
                    .parse()
                    .map_err(db)?,
            );
            let opening = window.to_string();
            let retired = super::retired_context::retired_row_in(
                &mut tx,
                &c.owner,
                &conversation,
                &c.namespace,
                &c.key,
                Some(&opening),
            )
            .await?;
            if retired.get::<String, _>("provider_kind") != provider_name(c.provider)?
                || retired.get::<String, _>("context_id") != c.id
                || retired.get::<String, _>("incarnation_id") != c.incarnation
                || retired.get::<i64, _>("generation") != c.generation
                || effective_predecessor(&mut tx, row.get("predecessor_window_id")).await?
                    != Some(retired.get("closed_window"))
            {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        if idle_owner {
            let busy: i64 = sqlx::query_scalar("SELECT count(*) FROM production_supervisors s WHERE s.owner_id=? AND EXISTS(SELECT 1 FROM production_readiness r JOIN session_bindings b ON b.id=r.session_id WHERE r.context_id=s.context_id AND b.conversation_id=?) AND (s.lease_deadline_ms!=0 OR NOT EXISTS(SELECT 1 FROM production_retirement_provenance p WHERE p.context_id=s.context_id AND p.incarnation_id=s.incarnation_id AND p.supervisor_generation=s.generation))")
                .bind(c.owner.to_string()).bind(row.get::<String,_>("conversation_id")).fetch_one(&mut *tx).await.map_err(db)?;
            let windows: i64 = sqlx::query_scalar("SELECT count(*) FROM execution_windows WHERE owner_id=? AND conversation_id=? AND credential_issued=1 AND state!='closed'")
                .bind(c.owner.to_string()).bind(row.get::<String,_>("conversation_id")).fetch_one(&mut *tx).await.map_err(db)?;
            if busy != 0 || windows != 0 {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        // The canonical Deep lineage's readiness: a parallel slot session of
        // an earlier window of this context never counts.
        let canonical = if super::super::parallel_deep::present(&mut tx).await? {
            " AND b.deep_slot=0"
        } else {
            ""
        };
        let scoped:i64=sqlx::query_scalar(&format!("SELECT count(*) FROM production_readiness r JOIN session_bindings b ON b.id=r.session_id WHERE r.context_id=? AND r.incarnation_id=? AND b.owner_id=? AND b.conversation_id=? AND b.role='deep'{canonical}"))
            .bind(&c.id).bind(&c.incarnation).bind(c.owner.to_string()).bind(row.get::<String,_>("conversation_id"))
            .fetch_one(&mut *tx).await.map_err(db)?;
        // First boot has only an owner-scoped Starting binding: native readiness
        // is produced later under the newly bound window's metadata fence. This
        // exception cannot recover a retired/expired context or an existing run.
        if scoped != 1 {
            let bootstrap: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM session_bindings b WHERE b.owner_id=? AND b.conversation_id=? AND b.role='deep'{canonical} AND b.state='starting' AND b.provider_kind='unconfigured' AND b.native_session_id IS NULL AND NOT EXISTS(SELECT 1 FROM production_readiness r WHERE r.session_id=b.id) AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.session_id=b.id OR (r.context_id=? AND r.incarnation_id=?))"))
                .bind(c.owner.to_string()).bind(row.get::<String, _>("conversation_id")).bind(&c.id).bind(&c.incarnation)
                .fetch_one(&mut *tx).await.map_err(db)?;
            if idle_owner || deadline <= now(&mut tx).await? || scoped != 0 || bootstrap != 1 {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        if row.get::<&str, _>("state") != "opening"
            || row.get::<i64, _>("work_deadline_ms") <= now(&mut tx).await?
            || row.get::<i64, _>("expires_at_ms") != expires_at_ms
            || row.get::<i64, _>("credential_issued") != 0
        {
            return Err(RuntimeStoreError::Fenced);
        }
        // Current context may be live for first boot or exactly gracefully retired.
        let unresolved:i64=sqlx::query_scalar("SELECT count(*) FROM production_runs r WHERE r.context_id=? AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id)")
            .bind(&c.id).fetch_one(&mut *tx).await.map_err(db)?;
        if unresolved != 0
            || !super::super::terminal_retirement::descendants_clear(&mut tx, &c.id).await?
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let secret = crate::runtime::ledger::secret();
        let hash = crate::digest(&secret);
        // Auth survives window expiry for truthful acceptance/owned retirement;
        // effect checks still enforce 870/900. No timer refresh or cached auth.
        let expiry: i64 = sqlx::query_scalar("SELECT unixepoch()+43200")
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("INSERT INTO auth_sessions(token_hash,owner_id,expires_at) VALUES(?,?,?)")
            .bind(&hash)
            .bind(c.owner.to_string())
            .bind(expiry)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("UPDATE execution_windows SET boot_id=?,manager_ack_hash=?,context_id=?,incarnation_id=?,credential_hash=?,credential_expires_at=?,credential_issued=1 WHERE id=?")
            .bind(boot_id).bind(manager_ack_digest).bind(&c.id).bind(&c.incarnation).bind(hash).bind(expiry)
            .bind(window.to_string()).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(ExecutionWindowCredential {
            secret,
            window,
            generation,
            boot: boot_id.into(),
        })
    }
    /// First window on a live, idle supervisor. For retired predecessors use the
    /// existing exact typed terminal reattachment with grant.credential(), which
    /// rebinds the window in that same transaction before metadata reservation.
    pub async fn bind_execution_window(
        &self,
        credential: &str,
        grant: &ExecutionWindowCredential,
    ) -> Result<Store> {
        self.window_issuance_credential(credential)?;
        let c = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        let row = window_in(&mut tx, c, grant.window, grant.generation).await?;
        if row.get::<&str, _>("state") != "opening"
            || row.get::<Option<String>, _>("credential_hash") != Some(crate::digest(&grant.secret))
            || row.get::<Option<String>, _>("context_id") != Some(c.id.clone())
            || row.get::<Option<String>, _>("incarnation_id") != Some(c.incarnation.clone())
            || row.get::<i64, _>("credential_bound") != 0
            || row.get::<i64, _>("work_deadline_ms") <= now(&mut tx).await?
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let fresh:i64=sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(crate::digest(&grant.secret)).bind(c.owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if fresh != 1 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let unresolved:i64=sqlx::query_scalar("SELECT count(*) FROM production_runs WHERE context_id=? AND state NOT IN ('cancelled','succeeded')")
            .bind(&c.id).fetch_one(&mut *tx).await.map_err(db)?;
        if unresolved != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        sqlx::query("UPDATE execution_windows SET credential_bound=1 WHERE id=?")
            .bind(grant.window.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM auth_sessions WHERE token_hash=?")
            .bind(&c.token_hash)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        let mut store = self.clone();
        let mut context = c.clone();
        context.token_hash = crate::digest(&grant.secret);
        context.window_bootstrap_only = false;
        store.authority = Some(context);
        Ok(store)
    }
}
