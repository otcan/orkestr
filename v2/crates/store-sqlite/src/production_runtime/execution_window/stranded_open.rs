//! A window whose open failed before it ran anything of its own.
//!
//! The opener lost its private credential (or never bound it) after the manager
//! admitted the window, for example because broker readiness or Fast setup was
//! refused. No run of the window exists, so there is nothing to accept, stop or
//! abandon, and `stranded.rs` could never plan it: the conversation stayed
//! blocked. Such a window is closed as `failed` with a derived cause.
//!
//! A successor opening already took over the retired predecessor's supervisor
//! (new incarnation, readiness, workspace association and resume reservations
//! for the predecessor turns). Those effects are reverted exactly, so the
//! conversation continues from that same retired window as if the failed
//! opening never happened; the reservations are archived, never confirmed
//! again. A first window has no predecessor: its bootstrap supervisor is fenced
//! and the next opening bootstraps again (`bootstrap.rs`).
use super::*;

pub(super) struct OpenPlan {
    context: Option<String>,
    incarnation: Option<String>,
    supervisor_generation: Option<i64>,
    credential_hash: Option<String>,
    /// The retired window the conversation continues from, if any.
    lineage: Option<Lineage>,
    /// The opening took over the lineage's supervisor: revert it exactly.
    revert: bool,
    /// First-window lineage: zero the bootstrap supervisor's lease.
    fence: bool,
    release: Vec<String>,
}

/// The exact retired predecessor state before the failed opening.
struct Lineage {
    window: String,
    incarnation: String,
    generation: i64,
    namespace: String,
    key: String,
    prior_run: String,
}

async fn lineage_in(tx: &mut SqliteConnection, retired: &SqliteRow) -> Result<Option<Lineage>> {
    let context: String = retired.get("context_id");
    let incarnation: String = retired.get("incarnation_id");
    let prior_run: String = retired.get("terminal_run_id");
    let generation: Option<i64> = sqlx::query_scalar("SELECT supervisor_generation FROM production_retirement_provenance WHERE context_id=? AND incarnation_id=? AND prior_run_id=?")
        .bind(&context).bind(&incarnation).bind(&prior_run)
        .fetch_optional(&mut *tx).await.map_err(db)?;
    let supervisor = sqlx::query(
        "SELECT namespace,supervisor_key FROM production_supervisors WHERE context_id=?",
    )
    .bind(&context)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    let (Some(generation), Some(supervisor)) = (generation, supervisor) else {
        return Ok(None);
    };
    Ok(Some(Lineage {
        window: retired.get("id"),
        incarnation,
        generation,
        namespace: supervisor.get("namespace"),
        key: supervisor.get("supervisor_key"),
        prior_run,
    }))
}

/// `Ok(None)`: the window ran something of its own; the turn plan decides.
pub(super) async fn plan(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    w: &SqliteRow,
    hard_deadline_passed: bool,
) -> Result<Option<Box<Plan>>> {
    let window: Uuid = w.get::<String, _>("id").parse().map_err(db)?;
    let issued = w.get::<i64, _>("credential_issued") == 1;
    let bound = w.get::<i64, _>("credential_bound") == 1;
    let context = w.get::<Option<String>, _>("context_id");
    let incarnation = w.get::<Option<String>, _>("incarnation_id");
    // The gracefully retired window this conversation continues from, if any.
    // A lineage this path cannot prove is never a failed-open decision: the
    // turn plan (which refuses anything it cannot prove either) decides.
    let retired = match effective_predecessor(tx, w.get("predecessor_window_id")).await? {
        Some(id) => match sqlx::query("SELECT * FROM execution_windows WHERE id=? AND owner_id=? AND conversation_id=? AND state='closed' AND terminal_run_id IS NOT NULL AND context_id IS NOT NULL AND incarnation_id IS NOT NULL")
            .bind(&id).bind(owner.to_string()).bind(conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?
        {
            Some(row) => Some(row),
            None => return Ok(None),
        },
        None => None,
    };
    let lineage = match &retired {
        Some(r) => match lineage_in(tx, r).await? {
            Some(lineage) => Some(lineage),
            None => return Ok(None),
        },
        None => None,
    };
    let mut supervisor_generation = None;
    let (cause, revert, fence) = if !issued {
        // No credential, context or incarnation was ever attached: the
        // supervisor is exactly as the predecessor (or bootstrap) left it.
        (Cause::CredentialUnissued, false, false)
    } else {
        let (Some(context), Some(incarnation)) = (&context, &incarnation) else {
            return Err(RuntimeStoreError::Fenced);
        };
        let supervisor =
            sqlx::query("SELECT * FROM production_supervisors WHERE context_id=? AND owner_id=?")
                .bind(context)
                .bind(owner.to_string())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .ok_or(RuntimeStoreError::Fenced)?;
        // Any takeover since the opening is not ours to undo.
        if &supervisor.get::<String, _>("incarnation_id") != incarnation {
            return Err(RuntimeStoreError::Fenced);
        }
        supervisor_generation = Some(supervisor.get::<i64, _>("generation"));
        let unresolved: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r WHERE r.context_id=? AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id)")
            .bind(context).fetch_one(&mut *tx).await.map_err(db)?;
        match &retired {
            Some(r) if r.get::<String, _>("incarnation_id") == *incarnation => {
                // Issued under the retired context but never reattached: the
                // supervisor is still the retired predecessor, untouched.
                if bound
                    || r.get::<String, _>("context_id") != *context
                    || supervisor.get::<i64, _>("lease_deadline_ms") != 0
                    || unresolved != 0
                {
                    return Err(RuntimeStoreError::Fenced);
                }
                (Cause::CredentialUnbound, false, false)
            }
            _ => {
                let own: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM production_runs WHERE context_id=? AND incarnation_id=?",
                )
                .bind(context)
                .bind(incarnation)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
                if own != 0 {
                    return Ok(None);
                }
                if unresolved != 0
                    || !crate::production_runtime::terminal_retirement::descendants_clear(
                        tx, context,
                    )
                    .await?
                {
                    return Err(RuntimeStoreError::Fenced);
                }
                let cause = if bound {
                    Cause::SetupIncomplete
                } else {
                    Cause::CredentialUnbound
                };
                match &lineage {
                    Some(l) => {
                        revert_allowed(tx, context, incarnation, &supervisor, l).await?;
                        (cause, true, false)
                    }
                    None => (cause, false, true),
                }
            }
        }
    };
    let restored_window_id = lineage
        .as_ref()
        .map(|l| l.window.parse::<Uuid>().map_err(db))
        .transpose()?;
    let release = super::unconsumed_inputs(tx, window).await?;
    let generation = u64::try_from(w.get::<i64, _>("generation")).map_err(db)?;
    Ok(Some(Box::new(Plan {
        public: StrandedExecutionWindowPlan {
            window_id: window,
            conversation_id: conversation.clone(),
            generation,
            outcome: Outcome::Failed,
            prior_run_id: None,
            terminal_event_id: None,
            abandoned_run_ids: Vec::new(),
            failed_run_ids: Vec::new(),
            open_failure_cause: Some(cause),
            restored_window_id,
            hard_deadline_passed,
        },
        kind: Kind::Open(Box::new(OpenPlan {
            context: if issued { context } else { None },
            incarnation: if issued { incarnation } else { None },
            supervisor_generation,
            credential_hash: w.get("credential_hash"),
            lineage,
            revert,
            fence,
            release,
        })),
        // Nothing of the window's own awaits acceptance.
        abandon_grace_passed: true,
    })))
}

/// The failed opening took over the lineage's supervisor. Prove that nothing
/// but setup happened under the new incarnation.
async fn revert_allowed(
    tx: &mut SqliteConnection,
    context: &str,
    incarnation: &str,
    supervisor: &SqliteRow,
    lineage: &Lineage,
) -> Result<()> {
    if lineage.incarnation == incarnation
        || supervisor.get::<i64, _>("generation") <= lineage.generation
    {
        return Err(RuntimeStoreError::Fenced);
    }
    // The predecessor's native Deep session is still exactly where acceptance,
    // stop or abandonment released it.
    let ready: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r JOIN session_bindings b ON b.id=r.session_id WHERE r.id=? AND r.context_id=? AND r.incarnation_id=? AND r.role='deep' AND b.state='ready' AND b.generation=r.binding_generation+1 AND b.native_session_id=r.native_session_id")
        .bind(&lineage.prior_run).bind(context).bind(&lineage.incarnation)
        .fetch_one(&mut *tx).await.map_err(db)?;
    // Setup only: no session became busy and no per-generation native request
    // (which a later opening would collide with) was recorded.
    let busy: i64 = sqlx::query_scalar("SELECT count(*) FROM production_readiness rd JOIN session_bindings b ON b.id=rd.session_id WHERE rd.context_id=? AND rd.incarnation_id=? AND b.state='busy'")
        .bind(context).bind(incarnation).fetch_one(&mut *tx).await.map_err(db)?;
    let requested: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM production_requested_native WHERE context_id=? AND incarnation_id=?",
    )
    .bind(context)
    .bind(incarnation)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    let foreign: i64 = sqlx::query_scalar("SELECT count(*) FROM production_resume_metadata rm WHERE rm.context_id=? AND rm.incarnation_id=? AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.id=rm.prior_run_id AND r.context_id=rm.context_id AND r.incarnation_id=?)")
        .bind(context).bind(incarnation).bind(&lineage.incarnation)
        .fetch_one(&mut *tx).await.map_err(db)?;
    if ready != 1 || busy != 0 || requested != 0 || foreign != 0 {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn commit(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    p: &StrandedExecutionWindowPlan,
    plan: &OpenPlan,
    id: Uuid,
    decision: Decision,
    actor: Actor,
    clock: i64,
) -> Result<()> {
    let cause = p.open_failure_cause.ok_or(RuntimeStoreError::Fenced)?;
    let lineage = plan.lineage.as_ref();
    sqlx::query("INSERT INTO execution_window_open_failures(id,window_id,owner_id,conversation_id,generation,actor,decision,cause,context_id,failed_incarnation_id,failed_generation,restored_window_id,restored_incarnation_id,restored_generation,hard_deadline_passed,reconciled_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id.to_string()).bind(p.window_id.to_string()).bind(owner.to_string())
        .bind(p.conversation_id.to_string()).bind(i64::try_from(p.generation).map_err(db)?)
        .bind(actor_name(actor)).bind(decision_name(decision)).bind(cause.as_str())
        .bind(&plan.context).bind(&plan.incarnation).bind(plan.supervisor_generation)
        .bind(lineage.map(|l| &l.window)).bind(lineage.map(|l| &l.incarnation))
        .bind(lineage.map(|l| l.generation))
        .bind(i64::from(p.hard_deadline_passed)).bind(clock)
        .execute(&mut *tx).await.map_err(db)?;
    if let (true, Some(restore), Some(context), Some(failed), Some(failed_generation)) = (
        plan.revert,
        lineage,
        &plan.context,
        &plan.incarnation,
        plan.supervisor_generation,
    ) {
        // Reservations for the predecessor turns are archived, never confirmed.
        sqlx::query("INSERT INTO execution_window_failed_resume_metadata(id,failure_id,prior_run_id,terminal_event_id,context_id,incarnation_id,session_id,binding_generation,state,confirmation_digest) SELECT id,?,prior_run_id,terminal_event_id,context_id,incarnation_id,session_id,binding_generation,state,confirmation_digest FROM production_resume_metadata WHERE context_id=? AND incarnation_id=?")
            .bind(id.to_string()).bind(context).bind(failed)
            .execute(&mut *tx).await.map_err(db)?;
        sqlx::query(
            "DELETE FROM production_resume_metadata WHERE context_id=? AND incarnation_id=?",
        )
        .bind(context)
        .bind(failed)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        for table in ["production_readiness", "workspace_session_projects"] {
            // Closed constant identifiers, never caller data.
            sqlx::query(&format!(
                "UPDATE {table} SET incarnation_id=? WHERE context_id=? AND incarnation_id=?"
            ))
            .bind(&restore.incarnation)
            .bind(context)
            .bind(failed)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        }
        let reverted = sqlx::query("UPDATE production_supervisors SET incarnation_id=?,generation=?,lease_deadline_ms=0 WHERE context_id=? AND incarnation_id=? AND generation=?")
            .bind(&restore.incarnation).bind(restore.generation).bind(context).bind(failed).bind(failed_generation)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if reverted != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
    } else if plan.fence {
        let (Some(context), Some(incarnation), Some(generation)) =
            (&plan.context, &plan.incarnation, plan.supervisor_generation)
        else {
            return Err(RuntimeStoreError::Fenced);
        };
        let fenced = sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0 WHERE context_id=? AND incarnation_id=? AND generation=?")
            .bind(context).bind(incarnation).bind(generation)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if fenced != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
    }
    super::release_inputs(tx, &id, p.window_id, &plan.release, true).await?;
    retry_timer_inputs(tx, p.window_id, &plan.release).await?;
    // Revoke the lost private window credential: a surviving holder is fenced.
    if let Some(hash) = &plan.credential_hash {
        sqlx::query("DELETE FROM auth_sessions WHERE token_hash=?")
            .bind(hash)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    let closed = sqlx::query(
        "UPDATE execution_windows SET state='closed' WHERE id=? AND state='reconciliation_required'",
    )
    .bind(p.window_id.to_string())
    .execute(&mut *tx)
    .await
    .map_err(db)?
    .rows_affected();
    if closed != 1 {
        return Err(RuntimeStoreError::Fenced);
    }
    // Post-condition: the conversation continues from exactly that retired
    // window, with the same proof a successor opening requires.
    if let Some(lineage) = lineage {
        let retired = crate::production_runtime::execution_window::retired_context::retired_row_in(
            tx,
            owner,
            &p.conversation_id,
            &lineage.namespace,
            &lineage.key,
            None,
        )
        .await?;
        if retired.get::<String, _>("closed_window") != lineage.window
            || retired.get::<String, _>("prior_run") != lineage.prior_run
        {
            return Err(RuntimeStoreError::Fenced);
        }
    }
    Ok(())
}

/// A timer occurrence has no sender who could send it again. When its window
/// failed to open, nothing of it ran: Core proves no run of any role exists
/// for its event, so its Deep turn has never executed and Fast (which only
/// ever sees a fixed note for a timer, #246) never presented it either. Its
/// dispatched queue intent goes back in line exactly once, and the dispatcher
/// opens the next window for it. A second failed opening of the same input
/// leaves it released: the adapter then refuses it with an operator alert.
async fn retry_timer_inputs(
    tx: &mut SqliteConnection,
    window: Uuid,
    release: &[String],
) -> Result<()> {
    for event in release {
        sqlx::query("UPDATE execution_window_queue SET state='queued',window_id=NULL WHERE event_id=?1 AND window_id=?2 AND state='dispatched' AND request_key='timer-window:'||?1 AND EXISTS(SELECT 1 FROM dormant_timer_inputs t WHERE t.event_id=?1) AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.event_id=?1) AND NOT EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=?1) AND (SELECT count(*) FROM execution_window_open_failure_inputs f WHERE f.event_id=?1)=1")
            .bind(event)
            .bind(window.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    Ok(())
}
