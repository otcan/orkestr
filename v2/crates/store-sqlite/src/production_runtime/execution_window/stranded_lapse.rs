//! Runs whose lease passed while their process was gone (0054).
//!
//! A service restart or a dead broker can leave a Worker, Deep or Fast run
//! `starting`, `running` or `blocked` with unknown delivery and no terminal
//! observation. Its lease has passed, so Core already refuses every effect of
//! the lost child, but nothing ever made the run terminal: its window could not
//! retire, and a parent proposal waiting on it could not be accepted.
//!
//! Settling is a separate, idempotent step before the window decision. The
//! caller (a process holding no custody of the window, after the manager
//! reported no live budget for it) asks Core to fail each lapsed run with cause
//! `lease_expired_process_gone`. Children settle before parents. A Worker's
//! binding is lost; a Deep or Fast binding is released at the next generation
//! so the conversation resumes its native session. A parent proposal stays
//! acceptable. Nothing is stopped, accepted or re-executed.
use super::*;

impl Store {
    /// Fail every lapsed run of this reconciliation-required window. Returns
    /// the runs failed by this call (empty when nothing is lapsed).
    pub async fn settle_lapsed_runs_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        window: Uuid,
        generation: u64,
        actor: Actor,
    ) -> Result<Vec<RunId>> {
        if window.is_nil() || generation == 0 || generation >= 9_007_199_254_740_992 {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let w = sqlx::query("SELECT * FROM execution_windows WHERE id=? AND owner_id=? AND conversation_id=? AND generation=?")
            .bind(window.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .bind(i64::try_from(generation).map_err(db)?)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
        // Only a window already marked uncertain by a process that does not own it.
        if w.get::<&str, _>("state") != "reconciliation_required"
            || w.get::<i64, _>("credential_issued") != 1
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let (Some(context), Some(incarnation)) = (
            w.get::<Option<String>, _>("context_id"),
            w.get::<Option<String>, _>("incarnation_id"),
        ) else {
            return Err(RuntimeStoreError::Fenced);
        };
        let current: Option<String> = sqlx::query_scalar(
            "SELECT incarnation_id FROM production_supervisors WHERE context_id=? AND owner_id=?",
        )
        .bind(&context)
        .bind(owner.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        if current.as_deref() != Some(incarnation.as_str()) {
            return Err(RuntimeStoreError::Fenced);
        }
        let clock = now(&mut tx).await?;
        // Automatically only once the window could never legitimately produce
        // more work. The owner side (an explicit decision, or Runtime after
        // its task ended and every original child was reaped and the manager
        // closed the window's egress) may settle earlier: each run's own lease
        // must still have passed, so no live child can still answer.
        if actor == Actor::Startup && w.get::<i64, _>("expires_at_ms") > clock {
            return Err(RuntimeStoreError::Fenced);
        }
        // Every nonterminal run whose lease passed, in any role and state, and
        // every proposal without exactly one readable completion. Children
        // first: a parent's terminal update fences live descendants.
        let mut failed = Vec::new();
        // A parent's terminal update can fence a child it held (for example a
        // Worker proposal under a lapsed Deep becomes `blocked`): settle again
        // until nothing nonterminal and lapsed is left. Each round makes at
        // least one run terminal, so this is bounded by the window's runs.
        loop {
            let lapsed = sqlx::query("SELECT r.*,CASE WHEN r.state='awaiting_acceptance' THEN 'proposal_execution_missing' ELSE 'lease_expired_process_gone' END AS cause FROM production_runs r WHERE r.context_id=? AND r.incarnation_id=? AND r.owner_id=? AND r.conversation_id=? AND r.state!='succeeded' AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id) AND ((r.state!='awaiting_acceptance' AND r.lease_deadline_ms<?) OR (r.state='awaiting_acceptance' AND (SELECT count(*) FROM production_observations o JOIN events e ON e.id=o.event_id WHERE o.run_id=r.id AND o.kind='completed_proposal' AND o.receipt_state='awaiting_acceptance' AND e.kind='provider_observed' AND e.schema_version=5 AND e.owner_id=r.owner_id AND e.conversation_id=r.conversation_id)!=1)) ORDER BY CASE r.role WHEN 'worker' THEN 0 WHEN 'fast' THEN 1 ELSE 2 END,r.scope_sequence,r.id")
            .bind(&context).bind(&incarnation).bind(owner.to_string()).bind(conversation.to_string()).bind(clock)
            .fetch_all(&mut *tx).await.map_err(db)?;
            if lapsed.is_empty() {
                break;
            }
            for r in &lapsed {
                let run: String = r.get("id");
                let role: String = r.get("role");
                let state: String = r.get("state");
                let cause: String = r.get("cause");
                let binding_generation: i64 = r.get("binding_generation");
                // The run's latest observation (or, before any, its own input event).
                let evidence: String = sqlx::query_scalar("SELECT coalesce((SELECT o.event_id FROM production_observations o WHERE o.run_id=? ORDER BY o.run_sequence DESC LIMIT 1),?)")
                .bind(&run).bind(r.get::<String, _>("event_id"))
                .fetch_one(&mut *tx).await.map_err(db)?;
                // A binding still at the run's generation moves on; one that
                // already moved (or was retired) is left exactly as it is.
                if role == "worker" {
                    // The Worker's last native turn is unknown: never reuse it.
                    sqlx::query("UPDATE session_bindings SET state='lost',generation=generation+1 WHERE id=? AND owner_id=? AND conversation_id=? AND role='worker' AND generation=? AND state!='retired'")
                    .bind(r.get::<String, _>("session_id")).bind(owner.to_string()).bind(conversation.to_string())
                    .bind(binding_generation)
                    .execute(&mut *tx).await.map_err(db)?;
                } else {
                    // Same release as abandonment: the conversation resumes this
                    // native session; the interrupted turn is never re-executed.
                    sqlx::query("UPDATE session_bindings SET state='ready',generation=generation+1 WHERE id=? AND owner_id=? AND conversation_id=? AND role=? AND generation=? AND native_session_id=? AND state!='retired' AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=session_bindings.id AND other.id!=? AND other.state NOT IN ('cancelled','succeeded'))")
                    .bind(r.get::<String, _>("session_id")).bind(owner.to_string()).bind(conversation.to_string())
                    .bind(&role).bind(binding_generation).bind(r.get::<String, _>("native_session_id")).bind(&run)
                    .execute(&mut *tx).await.map_err(db)?;
                }
                let cancelled = sqlx::query("UPDATE production_runs SET state='cancelled' WHERE id=? AND state=? AND lease_generation=? AND dispatch_fence=? AND lease_deadline_ms=?")
                .bind(&run).bind(&state).bind(r.get::<i64, _>("lease_generation"))
                .bind(r.get::<i64, _>("dispatch_fence")).bind(r.get::<i64, _>("lease_deadline_ms"))
                .execute(&mut *tx).await.map_err(db)?.rows_affected();
                if cancelled != 1 {
                    return Err(RuntimeStoreError::Fenced);
                }
                sqlx::query("INSERT INTO production_run_lapses(run_id,window_id,owner_id,conversation_id,actor,cause,prior_state,evidence_event_id,lease_generation,dispatch_fence,lease_deadline_ms,binding_generation,failed_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
                .bind(&run).bind(window.to_string()).bind(owner.to_string()).bind(conversation.to_string())
                .bind(actor_name(actor)).bind(&cause).bind(&state).bind(&evidence)
                .bind(r.get::<i64, _>("lease_generation")).bind(r.get::<i64, _>("dispatch_fence"))
                .bind(r.get::<i64, _>("lease_deadline_ms")).bind(binding_generation + 1).bind(clock)
                .execute(&mut *tx).await.map_err(db)?;
                let terminal: i64 = sqlx::query_scalar("SELECT count(*) FROM production_terminal_evidence WHERE run_id=? AND terminal_kind='failed' AND event_id=?")
                .bind(&run).bind(&evidence).fetch_one(&mut *tx).await.map_err(db)?;
                if terminal != 1 {
                    return Err(RuntimeStoreError::Fenced);
                }
                failed.push(RunId(run.parse().map_err(db)?));
            }
        }
        // A lapsed (process-gone) incarnation's auxiliary Fast slots whose
        // runs are now all terminal never stay live after the crash.
        super::super::fast_slots::retire_settled(
            &mut tx,
            &owner.to_string(),
            &conversation.to_string(),
            None,
        )
        .await?;
        super::super::parallel_deep::retire_settled(
            &mut tx,
            &owner.to_string(),
            &conversation.to_string(),
            None,
        )
        .await?;
        tx.commit().await.map_err(db)?;
        Ok(failed)
    }
}
