//! Read-only parallel Deep slots (docs/v2/parallel-deep.md). Slot 0 is the
//! canonical Deep lineage and the conversation's only writer; slots 1-3 are
//! fresh single-turn sessions of one live window that answer one queued
//! owner chat input each while the canonical turn is running, and only while
//! the owner's `parallel_deep` switch is on.
//!
//! Core grants a slot no more than an ordinary Deep claim: the claim goes
//! through the unchanged `admit_run`/dispatch path, an input is still
//! consumed by at most one Deep run (`production_deep_claim`), and a slot
//! run can never delegate a Worker, steer, ask another thread or take a
//! timer input. The read-only sandbox is enforced by Runtime and the broker
//! at launch; Core only refuses what such a turn could otherwise use.
use super::*;
use orkestr_v2_contracts::{ConversationId, EventId, MessageId, RunId, SessionId};

/// Parallel slots per conversation (the canonical slot 0 is separate). The
/// schema enforces the same ceiling: `deep_slot BETWEEN 0 AND 3`.
pub const MAX_PARALLEL_DEEP_SLOTS: u8 = 3;

/// How long a parallel claim stays valid before its admission. Same bound as
/// the canonical claim (`claims::next` accepts 1-60 s).
const CLAIM_MS: i64 = 60_000;

/// SQL predicate over an inbox row aliased `{inbox}`: the row is claimed by a
/// parallel slot session other than `?` (bind the claimant, or '' for none).
/// The canonical lineage never waits behind, or counts, such a row.
pub(crate) fn claimed_by_other_slot(inbox: &str) -> String {
    format!(
        "({inbox}.state='claimed' AND {inbox}.claimant_session_id IS NOT ? AND EXISTS(SELECT 1 FROM session_bindings ps WHERE ps.id={inbox}.claimant_session_id AND ps.deep_slot>0))"
    )
}

/// SQL predicate over an inbox row aliased `{inbox}`: the row is claimed by
/// any parallel slot session (no bind). Deep grouping skips such rows.
pub(crate) fn claimed_by_slot(inbox: &str) -> String {
    format!(
        "({inbox}.state='claimed' AND EXISTS(SELECT 1 FROM session_bindings ps WHERE ps.id={inbox}.claimant_session_id AND ps.deep_slot>0))"
    )
}

/// SQL predicate over a run aliased `{run}`: it ran on the canonical Deep
/// lineage (or is not a Deep run at all).
pub(crate) fn canonical_run(run: &str) -> String {
    format!(
        "NOT EXISTS(SELECT 1 FROM session_bindings ps WHERE ps.id={run}.session_id AND ps.deep_slot>0)"
    )
}

/// Whether the schema has parallel Deep slots. Historical unit fixtures run
/// pre-82 schemas; production always migrates, so this is `true` there.
pub(crate) async fn present(tx: &mut SqliteConnection) -> Result<bool> {
    #[cfg(test)]
    {
        let present: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pragma_table_info('session_bindings') WHERE name='deep_slot'",
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        Ok(present == 1)
    }
    #[cfg(not(test))]
    {
        let _ = tx;
        Ok(true)
    }
}

/// Whether `session` is a parallel slot session (never the canonical lineage).
pub(crate) async fn is_slot(tx: &mut SqliteConnection, session: &str) -> Result<bool> {
    if !present(tx).await? {
        return Ok(false);
    }
    let slot: Option<i64> = sqlx::query_scalar("SELECT deep_slot FROM session_bindings WHERE id=?")
        .bind(session)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
    Ok(slot.is_some_and(|slot| slot > 0))
}

/// The owner's switch for one conversation. Absent settings mean off.
pub(crate) async fn enabled_in(
    tx: &mut SqliteConnection,
    owner: &str,
    conversation: &str,
) -> Result<bool> {
    if !present(tx).await? {
        return Ok(false);
    }
    let value: Option<i64> = sqlx::query_scalar(
        "SELECT parallel_deep FROM conversation_settings WHERE conversation_id=? AND owner_id=?",
    )
    .bind(conversation)
    .bind(owner)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    Ok(value == Some(1))
}

impl Store {
    /// The owner's live switch for this exact live window's conversation.
    /// Read by the window scheduler (cached briefly); Core rechecks it inside
    /// every allocation and claim, so a stale read never starts a slot.
    pub async fn parallel_deep_enabled(&self, credential: &str) -> Result<bool> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        let mut tx = self.pool.begin().await.map_err(db)?;
        c.validate(&mut tx).await?;
        let window = c
            .window_scope(&mut tx)
            .await?
            .ok_or(RuntimeStoreError::Fenced)?;
        let conversation: String = window.get("conversation_id");
        let enabled = enabled_in(&mut tx, &c.owner.to_string(), &conversation).await?;
        tx.commit().await.map_err(db)?;
        Ok(enabled && c.provider == ProviderKind::Codex)
    }

    /// Trusted window scheduler only. Reserves the lowest free parallel slot
    /// for one fresh read-only Deep session of this exact live window, while
    /// the owner's switch is on. Grants no setup, claim or acceptance.
    /// `Busy` when every slot is live; `Fenced` when the window is not
    /// active, the switch is off or the provider is not Codex.
    pub async fn allocate_parallel_deep_slot(&self, credential: &str) -> Result<(Binding, u8)> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        if c.provider != ProviderKind::Codex {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        let window = c
            .window_scope(&mut tx)
            .await?
            .ok_or(RuntimeStoreError::Fenced)?;
        if window.get::<&str, _>("state") != "active"
            || window.get::<i64, _>("work_deadline_ms") <= now(&mut tx).await?
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let owner = c.owner.to_string();
        let conversation: String = window.get("conversation_id");
        if !enabled_in(&mut tx, &owner, &conversation).await? {
            return Err(RuntimeStoreError::Fenced);
        }
        // Settled leftovers of an earlier (crashed) incarnation never hold a
        // slot. This window's own sessions retire through their slot task.
        retire_settled(
            &mut tx,
            &owner,
            &conversation,
            Some((&c.id, &c.incarnation)),
        )
        .await?;
        let live: Vec<i64> = sqlx::query_scalar("SELECT deep_slot FROM session_bindings WHERE owner_id=? AND conversation_id=? AND role='deep' AND state!='retired' AND deep_slot>0")
            .bind(&owner).bind(&conversation).fetch_all(&mut *tx).await.map_err(db)?;
        let slot = (1..=i64::from(MAX_PARALLEL_DEEP_SLOTS))
            .find(|slot| !live.contains(slot))
            .ok_or(RuntimeStoreError::Busy)?;
        let row = sqlx::query("INSERT INTO session_bindings(id,owner_id,conversation_id,role,deep_slot) VALUES(?,?,?,'deep',?) RETURNING *")
            .bind(Uuid::new_v4().to_string()).bind(&owner).bind(&conversation).bind(slot)
            .fetch_one(&mut *tx).await.map_err(db)?;
        let binding = crate::runtime::binding(&row)?;
        sqlx::query("INSERT INTO production_parallel_deep_slots(session_id,context_id,incarnation_id,created_at_ms) VALUES(?,?,?,?)")
            .bind(binding.session_id.to_string()).bind(&c.id).bind(&c.incarnation).bind(now(&mut tx).await?)
            .execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok((binding, u8::try_from(slot).map_err(db)?))
    }

    /// Setup authority for one parallel slot session this live incarnation
    /// allocated. The ordinary metadata rules apply (Starting, unconfigured,
    /// no native, no parent).
    pub async fn authorize_parallel_deep_metadata(
        &self,
        credential: &str,
        binding: &Binding,
    ) -> Result<BoundSessionMetadata> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        if c.provider != ProviderKind::Codex
            || binding.owner_id != c.owner
            || binding.role != Role::Deep
            || binding.parent_session_id.is_some()
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let grant = BoundSessionMetadata {
            context: c.clone(),
            binding: binding.clone(),
            parent_run: None,
            resume: None,
        };
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        own_slot(&mut tx, &c.id, &c.incarnation, &binding.session_id).await?;
        self.validate_metadata(&mut tx, &grant).await?;
        tx.commit().await.map_err(db)?;
        Ok(grant)
    }

    /// Trusted window scheduler only. Claims the earliest queued owner chat
    /// input of this live window for one ready parallel slot session, while
    /// the canonical Deep turn is running and the switch is on. The claim
    /// then goes through the ordinary `admit_run`, which consumes the input,
    /// so neither the canonical lineage nor grouping can take it again.
    ///
    /// `None` (nothing written): the switch is off, the canonical lineage is
    /// not running a turn (it takes its own next input), or the earliest
    /// pending input is not eligible (claimed by the lineage, a timer, a
    /// thread ask, or an agent-relayed input). Never skips an input the
    /// lineage could take next for a later one.
    pub async fn claim_parallel_deep_input(
        &self,
        credential: &str,
        session: &SessionId,
    ) -> Result<Option<InboxClaim>> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        if c.provider != ProviderKind::Codex {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        let window = c
            .window_scope(&mut tx)
            .await?
            .ok_or(RuntimeStoreError::Fenced)?;
        let clock = now(&mut tx).await?;
        if window.get::<&str, _>("state") != "active"
            || window.get::<i64, _>("work_deadline_ms") <= clock
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let owner = c.owner.to_string();
        let conversation: String = window.get("conversation_id");
        let window_id: String = window.get("id");
        own_slot(&mut tx, &c.id, &c.incarnation, session).await?;
        let slot = sqlx::query("SELECT b.* FROM session_bindings b JOIN production_readiness r ON r.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND b.role='deep' AND b.deep_slot>0 AND r.context_id=? AND r.incarnation_id=?")
            .bind(session.to_string()).bind(&owner).bind(&conversation).bind(&c.id).bind(&c.incarnation)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        let binding = crate::runtime::binding(&slot)?;
        // A slot answers exactly one input: it must be ready and never ran.
        let used: i64 =
            sqlx::query_scalar("SELECT count(*) FROM production_runs WHERE session_id=?")
                .bind(session.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if binding.state != SessionState::Ready || used != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        if !enabled_in(&mut tx, &owner, &conversation).await? {
            tx.commit().await.map_err(db)?;
            return Ok(None);
        }
        // Only while the single writer is running a turn of this window.
        let writing: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r JOIN session_bindings b ON b.id=r.session_id WHERE r.owner_id=? AND r.conversation_id=? AND r.context_id=? AND r.incarnation_id=? AND r.role='deep' AND r.state IN ('starting','running') AND b.deep_slot=0 AND b.state='busy'")
            .bind(&owner).bind(&conversation).bind(&c.id).bind(&c.incarnation)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if writing != 1 {
            tx.commit().await.map_err(db)?;
            return Ok(None);
        }
        // Earliest pending input of this window, as the canonical claim sees
        // it, ignoring only rows other slots already claimed.
        let row = sqlx::query(&format!("SELECT i.* FROM reasoning_inbox i WHERE i.conversation_id=? AND i.state IN ('queued','claimed') AND NOT EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=i.event_id) AND EXISTS(SELECT 1 FROM execution_window_inputs wi WHERE wi.window_id=? AND wi.event_id=i.event_id) AND NOT {} ORDER BY i.sequence LIMIT 1", claimed_by_other_slot("i")))
            .bind(&conversation).bind(&window_id).bind(session.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let Some(row) = row else {
            tx.commit().await.map_err(db)?;
            return Ok(None);
        };
        let event: String = row.get("event_id");
        let message: String = row.get("message_id");
        // Owner chat input only: never a timer occurrence (typically
        // outreach), a thread ask, or an agent-relayed input.
        let eligible: i64 = sqlx::query_scalar("SELECT count(*) FROM messages m WHERE m.id=?1 AND m.actor_kind='owner' AND NOT EXISTS(SELECT 1 FROM dormant_timer_inputs t WHERE t.event_id=?2) AND NOT EXISTS(SELECT 1 FROM production_steering s WHERE s.event_id=?2) AND NOT EXISTS(SELECT 1 FROM thread_asks a WHERE a.input_message_id=m.id OR a.reply_message_id=m.id) AND NOT EXISTS(SELECT 1 FROM message_authors au WHERE au.message_id=m.id AND au.author NOT IN ('owner','member','v1_owner'))")
            .bind(&message).bind(&event)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if row.get::<&str, _>("state") != "queued" || eligible != 1 {
            tx.commit().await.map_err(db)?;
            return Ok(None);
        }
        let generation = row
            .get::<i64, _>("claim_generation")
            .checked_add(1)
            .ok_or(RuntimeStoreError::Unavailable)?;
        let deadline = clock
            .checked_add(CLAIM_MS)
            .ok_or(RuntimeStoreError::Unavailable)?;
        let sequence: i64 = row.get("sequence");
        let changed = sqlx::query("UPDATE reasoning_inbox SET state='claimed',claimant_session_id=?,claim_generation=?,claim_deadline_ms=? WHERE conversation_id=? AND sequence=? AND state='queued'")
            .bind(session.to_string()).bind(generation).bind(deadline).bind(&conversation).bind(sequence)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Busy);
        }
        let claim = InboxClaim {
            owner_id: c.owner.clone(),
            conversation_id: ConversationId(conversation.parse().map_err(db)?),
            consumer_session_id: session.clone(),
            message_id: MessageId(message.parse().map_err(db)?),
            event_id: EventId(event.parse().map_err(db)?),
            scope_sequence: sequence,
            claim_generation: u64::try_from(generation).map_err(db)?,
            lease_deadline_ms: deadline,
        };
        tx.commit().await.map_err(db)?;
        Ok(Some(claim))
    }

    /// After the exact slot run was owner-accepted or canonically Stopped and
    /// its original child reaped (the caller still holds the witness).
    /// Retires only that used session; it never creates a replacement.
    pub async fn retire_parallel_deep_slot(&self, credential: &str, run: &RunId) -> Result<()> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        let window = c
            .window_scope(&mut tx)
            .await?
            .ok_or(RuntimeStoreError::Fenced)?;
        if !matches!(
            window.get::<&str, _>("state"),
            "opening" | "active" | "retiring"
        ) {
            return Err(RuntimeStoreError::Fenced);
        }
        let changed = sqlx::query("UPDATE session_bindings SET state='retired' WHERE deep_slot>0 AND role='deep' AND state='ready' AND conversation_id=? AND id=(SELECT r.session_id FROM production_runs r JOIN production_terminal_evidence t ON t.run_id=r.id JOIN production_parallel_deep_slots p ON p.session_id=r.session_id WHERE r.id=? AND r.owner_id=? AND r.context_id=? AND r.incarnation_id=? AND r.role='deep' AND t.terminal_kind IN ('accepted','stopped') AND p.context_id=r.context_id AND p.incarnation_id=r.incarnation_id) AND generation=(SELECT binding_generation+1 FROM production_runs WHERE id=?) AND NOT EXISTS(SELECT 1 FROM production_runs o WHERE o.session_id=session_bindings.id AND o.id!=?)")
            .bind(window.get::<String, _>("conversation_id")).bind(run.to_string()).bind(c.owner.to_string())
            .bind(&c.id).bind(&c.incarnation).bind(run.to_string()).bind(run.to_string())
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }
}

/// `session` is a parallel slot set up by exactly this live incarnation.
async fn own_slot(
    tx: &mut SqliteConnection,
    context: &str,
    incarnation: &str,
    session: &SessionId,
) -> Result<()> {
    let own: i64 = sqlx::query_scalar("SELECT count(*) FROM production_parallel_deep_slots p JOIN session_bindings b ON b.id=p.session_id WHERE p.session_id=? AND p.context_id=? AND p.incarnation_id=? AND b.deep_slot>0 AND b.role='deep' AND b.state!='retired'")
        .bind(session.to_string()).bind(context).bind(incarnation)
        .fetch_one(&mut *tx).await.map_err(db)?;
    if own != 1 {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}

/// Retire parallel slot sessions whose every run has terminal truth (or that
/// never ran). `keep` exempts sessions set up by that live incarnation, whose
/// slot tasks may still be preparing them. Never touches the canonical
/// lineage, a run, an input, a native identity or an unresolved session.
pub(super) async fn retire_settled(
    tx: &mut SqliteConnection,
    owner: &str,
    conversation: &str,
    keep: Option<(&str, &str)>,
) -> Result<()> {
    if !present(tx).await? {
        return Ok(());
    }
    let (context, incarnation) = keep.unwrap_or(("", ""));
    sqlx::query("UPDATE session_bindings SET state='retired' WHERE owner_id=? AND conversation_id=? AND role='deep' AND deep_slot>0 AND state NOT IN ('retired','busy') AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.session_id=session_bindings.id AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id)) AND NOT EXISTS(SELECT 1 FROM production_parallel_deep_slots p WHERE p.session_id=session_bindings.id AND p.context_id=? AND p.incarnation_id=?)")
        .bind(owner).bind(conversation).bind(context).bind(incarnation)
        .execute(tx).await.map_err(db)?;
    Ok(())
}
