//! Bounded concurrent window Fast. Slot 0 is the canonical lineage; slots 1-7
//! are fresh single-presentation sessions owned by one live window.
use super::*;
use orkestr_v2_contracts::RunId;

/// Auxiliary slots per conversation (the canonical slot 0 is separate). The
/// schema enforces the same ceiling: `fast_slot BETWEEN 0 AND 7`.
pub const MAX_AUXILIARY_FAST_SLOTS: u8 = 7;

impl Store {
    /// Trusted window scheduler only. Reserves the lowest free auxiliary slot
    /// for one fresh Fast session of this exact live window. Grants no setup,
    /// dispatch or acceptance: metadata still comes from the bounded issuer.
    /// `Busy` when every slot is live.
    pub async fn allocate_bounded_fast_slot(&self, credential: &str) -> Result<(Binding, u8)> {
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
        let conversation: String = window.get("conversation_id");
        // Settled leftovers of an earlier (crashed) incarnation never hold a
        // slot. This window's own sessions retire through their slot task.
        retire_settled(
            &mut tx,
            &c.owner.to_string(),
            &conversation,
            Some((&c.id, &c.incarnation)),
        )
        .await?;
        let live: Vec<i64> = sqlx::query_scalar("SELECT fast_slot FROM session_bindings WHERE owner_id=? AND conversation_id=? AND role='fast' AND state!='retired' AND fast_slot>0")
            .bind(c.owner.to_string()).bind(&conversation).fetch_all(&mut *tx).await.map_err(db)?;
        let slot = (1..=i64::from(MAX_AUXILIARY_FAST_SLOTS))
            .find(|slot| !live.contains(slot))
            .ok_or(RuntimeStoreError::Busy)?;
        let row = sqlx::query("INSERT INTO session_bindings(id,owner_id,conversation_id,role,fast_slot) VALUES(?,?,?,'fast',?) RETURNING *")
            .bind(Uuid::new_v4().to_string()).bind(c.owner.to_string()).bind(&conversation).bind(slot)
            .fetch_one(&mut *tx).await.map_err(db)?;
        let binding = crate::runtime::binding(&row)?;
        sqlx::query("INSERT INTO production_fast_continuity(session_id,context_id,incarnation_id,created_at_ms) VALUES(?,?,?,?)")
            .bind(binding.session_id.to_string()).bind(&c.id).bind(&c.incarnation).bind(now(&mut tx).await?)
            .execute(&mut *tx).await.map_err(db)?;
        execution_window::handoff_context::bind(
            &mut tx,
            &c.owner,
            &binding.conversation_id,
            &binding.session_id.to_string(),
        )
        .await?;
        tx.commit().await.map_err(db)?;
        Ok((binding, u8::try_from(slot).map_err(db)?))
    }

    /// Current record of one auxiliary session of this live window, e.g.
    /// after its readiness commit. Grants nothing.
    pub async fn bounded_fast_slot_binding(
        &self,
        credential: &str,
        session: &orkestr_v2_contracts::SessionId,
    ) -> Result<Binding> {
        self.worker_credential(credential)?;
        let c = self.context()?;
        let mut tx = self.pool.begin().await.map_err(db)?;
        c.validate(&mut tx).await?;
        let window = c
            .window_scope(&mut tx)
            .await?
            .ok_or(RuntimeStoreError::Fenced)?;
        let row = sqlx::query("SELECT b.* FROM session_bindings b JOIN production_fast_continuity f ON f.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND b.role='fast' AND b.fast_slot>0 AND f.context_id=? AND f.incarnation_id=?")
            .bind(session.to_string()).bind(c.owner.to_string()).bind(window.get::<String, _>("conversation_id"))
            .bind(&c.id).bind(&c.incarnation)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        let binding = crate::runtime::binding(&row)?;
        tx.commit().await.map_err(db)?;
        Ok(binding)
    }

    /// After the exact auxiliary run was owner-accepted or canonically Stopped
    /// and its original child reaped (the caller still holds the witness).
    /// Retires only that used session; it never creates a replacement.
    pub async fn retire_bounded_fast_slot(&self, credential: &str, run: &RunId) -> Result<()> {
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
        let changed = sqlx::query("UPDATE session_bindings SET state='retired' WHERE fast_slot>0 AND role='fast' AND state='ready' AND conversation_id=? AND id=(SELECT r.session_id FROM production_runs r JOIN production_terminal_evidence t ON t.run_id=r.id JOIN production_fast_continuity f ON f.session_id=r.session_id WHERE r.id=? AND r.owner_id=? AND r.context_id=? AND r.incarnation_id=? AND r.role='fast' AND t.terminal_kind IN ('accepted','stopped') AND f.context_id=r.context_id AND f.incarnation_id=r.incarnation_id) AND generation=(SELECT binding_generation+1 FROM production_runs WHERE id=?) AND NOT EXISTS(SELECT 1 FROM production_runs o WHERE o.session_id=session_bindings.id AND o.id!=?)")
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

/// Retire auxiliary Fast sessions whose every run has terminal truth (or that
/// never ran). `keep` exempts sessions set up by that live incarnation, whose
/// slot tasks may still be preparing them. Never touches slot 0, a run, an
/// input, a native identity or an unresolved session.
pub(super) async fn retire_settled(
    tx: &mut SqliteConnection,
    owner: &str,
    conversation: &str,
    keep: Option<(&str, &str)>,
) -> Result<()> {
    // Historical unit fixtures run pre-80 schemas; production always migrates.
    #[cfg(test)]
    if sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM pragma_table_info('session_bindings') WHERE name='fast_slot'",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?
        == 0
    {
        return Ok(());
    }
    let (context, incarnation) = keep.unwrap_or(("", ""));
    sqlx::query("UPDATE session_bindings SET state='retired' WHERE owner_id=? AND conversation_id=? AND role='fast' AND fast_slot>0 AND state NOT IN ('retired','busy') AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.session_id=session_bindings.id AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id)) AND NOT EXISTS(SELECT 1 FROM production_fast_continuity f WHERE f.session_id=session_bindings.id AND f.context_id=? AND f.incarnation_id=?)")
        .bind(owner).bind(conversation).bind(context).bind(incarnation)
        .execute(tx).await.map_err(db)?;
    Ok(())
}
