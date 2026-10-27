//! Commit of an audited turn decision: failed Workers, abandoned proposals,
//! released inputs, revoked credential and retirement provenance.
use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) async fn commit_turns(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    p: &StrandedExecutionWindowPlan,
    plan: &Turns,
    id: Uuid,
    decision: Decision,
    actor: Actor,
    clock: i64,
) -> Result<()> {
    let (Some(prior_run), Some(terminal_event)) = (&p.prior_run_id, &p.terminal_event_id) else {
        return Err(RuntimeStoreError::Fenced);
    };
    sqlx::query("INSERT INTO execution_window_reconciliations(id,window_id,owner_id,conversation_id,generation,actor,decision,outcome,prior_run_id,terminal_event_id,hard_deadline_passed,reconciled_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id.to_string()).bind(p.window_id.to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .bind(i64::try_from(p.generation).map_err(db)?).bind(actor_name(actor)).bind(decision_name(decision))
        .bind(p.outcome.as_str()).bind(prior_run.to_string()).bind(terminal_event.to_string())
        .bind(i64::from(p.hard_deadline_passed)).bind(clock)
        .execute(&mut *tx).await.map_err(db)?;
    // Workers first: abandoning their Deep parent below fences any child that
    // is not already terminal (it would become `blocked`, never resolved).
    for f in &plan.fail {
        // The native session's last turn is unknown: never reuse the binding.
        let lost = sqlx::query("UPDATE session_bindings SET state='lost',generation=generation+1 WHERE id=? AND owner_id=? AND conversation_id=? AND role='worker' AND generation=? AND state!='retired'")
            .bind(&f.session).bind(owner.to_string()).bind(conversation.to_string()).bind(f.binding_generation)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        let cancelled = sqlx::query("UPDATE production_runs SET state='cancelled' WHERE id=? AND role='worker' AND state=? AND dispatch_state='delivery_unknown' AND lease_deadline_ms=?")
            .bind(&f.run).bind(f.evidence.state()).bind(f.lease_deadline)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if lost != 1 || cancelled != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        let record = match &f.evidence {
            worker::Evidence::Cancellation(_) => "INSERT INTO production_run_failures(run_id,reconciliation_id,cause,cancellation_event_id,lease_deadline_ms,binding_generation,failed_at_ms) VALUES(?,?,'cancel_unacknowledged',?,?,?,?)",
            worker::Evidence::Lost(_) => "INSERT INTO production_run_lost_failures(run_id,reconciliation_id,lost_event_id,lease_deadline_ms,binding_generation,failed_at_ms) VALUES(?,?,?,?,?,?)",
        };
        sqlx::query(record)
            .bind(&f.run)
            .bind(id.to_string())
            .bind(f.evidence.event())
            .bind(f.lease_deadline)
            .bind(f.binding_generation + 1)
            .bind(clock)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let failed: i64 = sqlx::query_scalar("SELECT count(*) FROM production_terminal_evidence WHERE run_id=? AND terminal_kind='failed' AND event_id=?")
            .bind(&f.run).bind(f.evidence.event()).fetch_one(&mut *tx).await.map_err(db)?;
        if failed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
    }
    for a in &plan.abandon {
        // Same exact busy-generation release as owner acceptance, but the
        // run becomes Cancelled with abandonment evidence, never Succeeded.
        // A session that already moved on (not busy at this generation) is
        // left as it is; a Worker session is never reused.
        let target = if a.worker { "lost" } else { "ready" };
        sqlx::query("UPDATE session_bindings SET state=?,generation=generation+1 WHERE id=? AND owner_id=? AND conversation_id=? AND generation=? AND state='busy' AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=session_bindings.id AND other.id!=? AND other.state NOT IN ('cancelled','succeeded'))")
            .bind(target).bind(&a.session).bind(owner.to_string()).bind(conversation.to_string())
            .bind(a.binding_generation).bind(&a.run)
            .execute(&mut *tx).await.map_err(db)?;
        let cancelled = sqlx::query(
            "UPDATE production_runs SET state='cancelled' WHERE id=? AND state='awaiting_acceptance'",
        )
        .bind(&a.run)
        .execute(&mut *tx)
        .await
        .map_err(db)?
        .rows_affected();
        if cancelled != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        sqlx::query("INSERT INTO production_run_abandonments(run_id,reconciliation_id,completion_event_id,binding_generation,abandoned_at_ms) VALUES(?,?,?,?,?)")
            .bind(&a.run).bind(id.to_string()).bind(&a.completion).bind(a.binding_generation + 1).bind(clock)
            .execute(&mut *tx).await.map_err(db)?;
        let cause = if !a.acceptable {
            "proposal_execution_missing"
        } else if actor == Actor::Startup {
            "acceptance_grace_expired"
        } else {
            "owner_decision"
        };
        sqlx::query("INSERT INTO production_abandonment_causes(run_id,cause) VALUES(?,?)")
            .bind(&a.run)
            .bind(cause)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    super::release_inputs(tx, &id, p.window_id, &plan.release, false).await?;
    // Post-condition: the whole context is now canonically terminal.
    let unresolved: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r WHERE r.context_id=? AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id)")
        .bind(&plan.context).fetch_one(&mut *tx).await.map_err(db)?;
    if unresolved != 0
        || !crate::production_runtime::terminal_retirement::descendants_clear(tx, &plan.context)
            .await?
    {
        return Err(RuntimeStoreError::Fenced);
    }
    // Revoke the lost private window credential: a surviving holder is fenced.
    sqlx::query("DELETE FROM auth_sessions WHERE token_hash=?")
        .bind(&plan.credential_hash)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    if !plan.provenance_exists {
        let (table, column) = match p.outcome {
            Outcome::Accepted => ("production_graceful_retirements", "acceptance_event_id"),
            Outcome::Stopped => ("production_stopped_retirements", "stopped_event_id"),
            Outcome::Abandoned => ("production_abandoned_retirements", "abandoned_event_id"),
            Outcome::Failed => ("production_lapsed_retirements", "lapsed_event_id"),
        };
        // Closed constant identifiers above, never caller data.
        sqlx::query(&format!("INSERT INTO {table}(context_id,incarnation_id,supervisor_generation,prior_run_id,{column},session_id,binding_generation,retired_at_ms) SELECT r.context_id,r.incarnation_id,?,r.id,t.event_id,r.session_id,b.generation,? FROM production_runs r JOIN production_terminal_evidence t ON t.run_id=r.id JOIN session_bindings b ON b.id=r.session_id WHERE r.id=? AND t.terminal_kind=? AND t.event_id=?"))
            .bind(plan.supervisor_generation).bind(clock).bind(prior_run.to_string())
            .bind(p.outcome.as_str()).bind(terminal_event.to_string())
            .execute(&mut *tx).await.map_err(db)?;
    }
    let recorded: i64 = sqlx::query_scalar("SELECT count(*) FROM production_retirement_provenance g JOIN production_runs r ON r.id=g.prior_run_id JOIN production_terminal_evidence a ON a.run_id=r.id JOIN session_bindings b ON b.id=r.session_id WHERE g.context_id=? AND g.incarnation_id=? AND g.supervisor_generation=? AND g.prior_run_id=? AND g.terminal_event_id=a.event_id AND g.session_id=? AND g.binding_generation=b.generation AND b.state='ready'")
        .bind(&plan.context).bind(&plan.incarnation).bind(plan.supervisor_generation)
        .bind(prior_run.to_string()).bind(&plan.prior_session)
        .fetch_one(&mut *tx).await.map_err(db)?;
    if recorded != 1 {
        return Err(RuntimeStoreError::Fenced);
    }
    super::super::fast_continuity::retire_failed_setups(tx, &plan.context, &plan.incarnation)
        .await?;
    // The whole context is terminal: no auxiliary Fast slot outlives it.
    super::super::fast_slots::retire_settled(
        tx,
        &owner.to_string(),
        &conversation.to_string(),
        None,
    )
    .await?;
    sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0 WHERE context_id=? AND incarnation_id=? AND generation=?")
        .bind(&plan.context).bind(&plan.incarnation).bind(plan.supervisor_generation)
        .execute(&mut *tx).await.map_err(db)?;
    let closed = sqlx::query("UPDATE execution_windows SET state='closed',terminal_run_id=? WHERE id=? AND state='reconciliation_required'")
        .bind(prior_run.to_string()).bind(p.window_id.to_string())
        .execute(&mut *tx).await.map_err(db)?.rows_affected();
    if closed != 1 {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}
