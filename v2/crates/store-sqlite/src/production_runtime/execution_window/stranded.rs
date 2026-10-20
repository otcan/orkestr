//! Audited recovery of a window whose opening process incarnation is gone.
//!
//! `retire_execution_window` needs the exact boot and private credential of the
//! opener, which a restarted process never has. Without this path a window left
//! `reconciliation_required` (for example with proposals still awaiting owner
//! acceptance) blocks every later window of the owner forever.
//!
//! This is owner-authenticated (browser credential, rechecked in the same write
//! transaction) and negative-first: the window must already be marked
//! `reconciliation_required`, its supervisor must still be the window's own
//! incarnation, and every unresolved run must be a completed Deep/Fast proposal
//! awaiting acceptance. Such proposals are explicitly ABANDONED, never accepted
//! and never re-executed. The private window credential is revoked, so a
//! surviving holder of it is fenced. Inputs admitted to the window that no Deep
//! run consumed are released back to ordinary admission. Every decision leaves
//! an immutable audit row; observations, payloads and receipts are retained.
use super::*;
use orkestr_v2_contracts::{
    ExecutionWindowReconciliation, ExecutionWindowReconciliationActor as Actor,
    ExecutionWindowReconciliationDecision as Decision, ExecutionWindowTerminalOutcome as Outcome,
};

/// Locators for the trusted server's manager step. Not authority: commit
/// revalidates everything under its own write transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrandedExecutionWindowPlan {
    pub window_id: Uuid,
    pub conversation_id: ConversationId,
    pub generation: u64,
    pub outcome: Outcome,
    pub prior_run_id: RunId,
    pub terminal_event_id: EventId,
    pub abandoned_run_ids: Vec<RunId>,
    pub hard_deadline_passed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StrandedExecutionWindow {
    Pending(StrandedExecutionWindowPlan),
    Reconciled(ExecutionWindowReconciliation),
}

struct Abandon {
    run: String,
    completion: String,
    session: String,
    binding_generation: i64,
}

struct Plan {
    public: StrandedExecutionWindowPlan,
    context: String,
    incarnation: String,
    supervisor_generation: i64,
    credential_hash: String,
    prior_session: String,
    provenance_exists: bool,
    abandon: Vec<Abandon>,
    release: Vec<String>,
}

enum Planned {
    Plan(Box<Plan>),
    Replay(ExecutionWindowReconciliation),
}

#[path = "stranded_receipt.rs"]
mod receipt;
use receipt::receipt_in;

fn decision_name(decision: Decision) -> &'static str {
    match decision {
        Decision::AbandonUnaccepted => "abandon_unaccepted",
        Decision::RetireResolved => "retire_resolved",
    }
}
fn actor_name(actor: Actor) -> &'static str {
    match actor {
        Actor::Startup => "startup",
        Actor::Owner => "owner",
    }
}

impl Store {
    /// Every unfinished window of the authenticated owner, oldest first.
    pub async fn unfinished_execution_windows_authenticated(
        &self,
        credential: &str,
    ) -> Result<Vec<ExecutionWindowStatus>> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        let rows = sqlx::query("SELECT * FROM execution_windows WHERE owner_id=? AND state!='closed' ORDER BY opened_at_ms,generation")
            .bind(owner.to_string()).fetch_all(&mut *tx).await.map_err(db)?;
        let result = rows.iter().map(status).collect::<Result<Vec<_>>>()?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }

    /// Read-only preflight used before the manager is asked to release its own
    /// custody. A committed decision is returned as a replay.
    pub async fn plan_stranded_execution_window_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        window: Uuid,
        generation: u64,
        decision: Decision,
        actor: Actor,
    ) -> Result<StrandedExecutionWindow> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let planned = plan_in(&mut tx, &owner, conversation, window, generation, decision).await?;
        let result = match planned {
            Planned::Replay(receipt) => StrandedExecutionWindow::Reconciled(receipt),
            Planned::Plan(plan) => {
                startup_allowed(&plan, actor)?;
                StrandedExecutionWindow::Pending(plan.public)
            }
        };
        tx.commit().await.map_err(db)?;
        Ok(result)
    }

    /// Commit the audited terminal decision planned (and already reported to
    /// the manager) as `expected`. Idempotent: a repeated identical decision
    /// replays the original receipt; a different decision or a changed plan
    /// (for example a concurrent owner acceptance) conflicts without effects.
    pub async fn reconcile_stranded_execution_window_authenticated(
        &self,
        credential: &str,
        expected: &StrandedExecutionWindowPlan,
        decision: Decision,
        actor: Actor,
    ) -> Result<ExecutionWindowReconciliation> {
        if self.authority.is_some() {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let conversation = &expected.conversation_id;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = browser_owner(self, &mut tx, credential).await?;
        crate::runtime::scope(&mut tx, &owner, conversation).await?;
        let plan = match plan_in(
            &mut tx,
            &owner,
            conversation,
            expected.window_id,
            expected.generation,
            decision,
        )
        .await?
        {
            Planned::Replay(receipt) => {
                tx.commit().await.map_err(db)?;
                if receipt.outcome != expected.outcome
                    || receipt.prior_run_id != expected.prior_run_id
                    || receipt.terminal_event_id != expected.terminal_event_id
                {
                    return Err(RuntimeStoreError::Conflict);
                }
                return Ok(receipt);
            }
            Planned::Plan(plan) => plan,
        };
        startup_allowed(&plan, actor)?;
        if plan.public.outcome != expected.outcome
            || plan.public.prior_run_id != expected.prior_run_id
            || plan.public.terminal_event_id != expected.terminal_event_id
            || plan.public.abandoned_run_ids != expected.abandoned_run_ids
        {
            return Err(RuntimeStoreError::Conflict);
        }
        let clock = now(&mut tx).await?;
        let id = Uuid::new_v4();
        let p = &plan.public;
        sqlx::query("INSERT INTO execution_window_reconciliations(id,window_id,owner_id,conversation_id,generation,actor,decision,outcome,prior_run_id,terminal_event_id,hard_deadline_passed,reconciled_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(id.to_string()).bind(p.window_id.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .bind(i64::try_from(p.generation).map_err(db)?).bind(actor_name(actor)).bind(decision_name(decision))
            .bind(p.outcome.as_str()).bind(p.prior_run_id.to_string()).bind(p.terminal_event_id.to_string())
            .bind(i64::from(p.hard_deadline_passed)).bind(clock)
            .execute(&mut *tx).await.map_err(db)?;
        for a in &plan.abandon {
            // Same exact busy-generation release as owner acceptance, but the
            // run becomes Cancelled with abandonment evidence, never Succeeded.
            let released = sqlx::query("UPDATE session_bindings SET state='ready',generation=generation+1 WHERE id=? AND owner_id=? AND conversation_id=? AND generation=? AND state='busy' AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=session_bindings.id AND other.id!=? AND other.state NOT IN ('cancelled','succeeded'))")
                .bind(&a.session).bind(owner.to_string()).bind(conversation.to_string())
                .bind(a.binding_generation).bind(&a.run)
                .execute(&mut *tx).await.map_err(db)?.rows_affected();
            let cancelled = sqlx::query(
                "UPDATE production_runs SET state='cancelled' WHERE id=? AND state='awaiting_acceptance'",
            )
            .bind(&a.run)
            .execute(&mut *tx)
            .await
            .map_err(db)?
            .rows_affected();
            if released != 1 || cancelled != 1 {
                return Err(RuntimeStoreError::Fenced);
            }
            sqlx::query("INSERT INTO production_run_abandonments(run_id,reconciliation_id,completion_event_id,binding_generation,abandoned_at_ms) VALUES(?,?,?,?,?)")
                .bind(&a.run).bind(id.to_string()).bind(&a.completion).bind(a.binding_generation + 1).bind(clock)
                .execute(&mut *tx).await.map_err(db)?;
        }
        for event in &plan.release {
            sqlx::query("INSERT INTO execution_window_released_inputs(event_id,reconciliation_id,window_id,owner_id,conversation_id,request_key,semantic_digest,message_id,input_request_key,receipt_json) SELECT event_id,?,window_id,owner_id,conversation_id,request_key,semantic_digest,message_id,input_request_key,receipt_json FROM execution_window_inputs WHERE event_id=? AND window_id=?")
                .bind(id.to_string()).bind(event).bind(p.window_id.to_string())
                .execute(&mut *tx).await.map_err(db)?;
            let deleted =
                sqlx::query("DELETE FROM execution_window_inputs WHERE event_id=? AND window_id=?")
                    .bind(event)
                    .bind(p.window_id.to_string())
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?
                    .rows_affected();
            if deleted != 1 {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        // Post-condition: the whole context is now canonically terminal.
        let unresolved: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r WHERE r.context_id=? AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id)")
            .bind(&plan.context).fetch_one(&mut *tx).await.map_err(db)?;
        if unresolved != 0
            || !super::super::terminal_retirement::descendants_clear(&mut tx, &plan.context).await?
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
            };
            // Closed constant identifiers above, never caller data.
            sqlx::query(&format!("INSERT INTO {table}(context_id,incarnation_id,supervisor_generation,prior_run_id,{column},session_id,binding_generation,retired_at_ms) SELECT r.context_id,r.incarnation_id,?,r.id,t.event_id,r.session_id,b.generation,? FROM production_runs r JOIN production_terminal_evidence t ON t.run_id=r.id JOIN session_bindings b ON b.id=r.session_id WHERE r.id=? AND t.terminal_kind=? AND t.event_id=?"))
                .bind(plan.supervisor_generation).bind(clock).bind(p.prior_run_id.to_string())
                .bind(p.outcome.as_str()).bind(p.terminal_event_id.to_string())
                .execute(&mut *tx).await.map_err(db)?;
        }
        let recorded: i64 = sqlx::query_scalar("SELECT count(*) FROM production_retirement_provenance g JOIN production_runs r ON r.id=g.prior_run_id JOIN production_terminal_evidence a ON a.run_id=r.id JOIN session_bindings b ON b.id=r.session_id WHERE g.context_id=? AND g.incarnation_id=? AND g.supervisor_generation=? AND g.prior_run_id=? AND g.terminal_event_id=a.event_id AND g.session_id=? AND g.binding_generation=b.generation AND b.state='ready'")
            .bind(&plan.context).bind(&plan.incarnation).bind(plan.supervisor_generation)
            .bind(p.prior_run_id.to_string()).bind(&plan.prior_session)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if recorded != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0 WHERE context_id=? AND incarnation_id=? AND generation=?")
            .bind(&plan.context).bind(&plan.incarnation).bind(plan.supervisor_generation)
            .execute(&mut *tx).await.map_err(db)?;
        let closed = sqlx::query("UPDATE execution_windows SET state='closed',terminal_run_id=? WHERE id=? AND state='reconciliation_required'")
            .bind(p.prior_run_id.to_string()).bind(p.window_id.to_string())
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if closed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        let receipt = receipt_in(&mut tx, &p.window_id.to_string(), false).await?;
        tx.commit().await.map_err(db)?;
        Ok(receipt)
    }
}

fn startup_allowed(plan: &Plan, actor: Actor) -> Result<()> {
    // Automatic recovery only after the hard deadline: the window could never
    // have legitimately produced more work. Earlier abandonment is owner-only.
    if actor == Actor::Startup && !plan.public.hard_deadline_passed {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}

async fn plan_in(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    window: Uuid,
    generation: u64,
    decision: Decision,
) -> Result<Planned> {
    if window.is_nil() || generation == 0 || generation >= 9_007_199_254_740_992 {
        return Err(RuntimeStoreError::InvalidInput);
    }
    let w = sqlx::query("SELECT * FROM execution_windows WHERE id=? AND owner_id=? AND conversation_id=? AND generation=?")
        .bind(window.to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .bind(i64::try_from(generation).map_err(db)?)
        .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
    let state: String = w.get("state");
    if state == "closed" {
        let recorded: Option<String> = sqlx::query_scalar(
            "SELECT decision FROM execution_window_reconciliations WHERE window_id=?",
        )
        .bind(window.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        return match recorded {
            Some(d) if d == decision_name(decision) => Ok(Planned::Replay(
                receipt_in(tx, &window.to_string(), true).await?,
            )),
            Some(_) => Err(RuntimeStoreError::Conflict),
            None => Err(RuntimeStoreError::Fenced),
        };
    }
    // Only a window already marked uncertain by a process that does not own it.
    if state != "reconciliation_required"
        || w.get::<i64, _>("credential_issued") != 1
        || w.get::<i64, _>("credential_bound") != 1
    {
        return Err(RuntimeStoreError::Fenced);
    }
    let (Some(context), Some(incarnation), Some(credential_hash)) = (
        w.get::<Option<String>, _>("context_id"),
        w.get::<Option<String>, _>("incarnation_id"),
        w.get::<Option<String>, _>("credential_hash"),
    ) else {
        return Err(RuntimeStoreError::Fenced);
    };
    let clock = now(tx).await?;
    let hard_deadline_passed = w.get::<i64, _>("expires_at_ms") <= clock;
    // No takeover may have happened since: the window's incarnation is current.
    let supervisor =
        sqlx::query("SELECT * FROM production_supervisors WHERE context_id=? AND owner_id=?")
            .bind(&context)
            .bind(owner.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or(RuntimeStoreError::Fenced)?;
    if supervisor.get::<String, _>("incarnation_id") != incarnation {
        return Err(RuntimeStoreError::Fenced);
    }
    let supervisor_generation: i64 = supervisor.get("generation");
    let foreign: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r WHERE r.context_id=? AND r.incarnation_id!=? AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id)")
        .bind(&context).bind(&incarnation).fetch_one(&mut *tx).await.map_err(db)?;
    if foreign != 0 {
        return Err(RuntimeStoreError::Fenced);
    }
    let runs = sqlx::query("SELECT r.*,(SELECT t.terminal_kind FROM production_terminal_evidence t WHERE t.run_id=r.id) AS terminal FROM production_runs r WHERE r.context_id=? AND r.incarnation_id=? ORDER BY r.scope_sequence,r.id")
        .bind(&context).bind(&incarnation).fetch_all(&mut *tx).await.map_err(db)?;
    let mut abandon = Vec::new();
    for r in &runs {
        if r.get::<Option<String>, _>("terminal").is_some() {
            continue;
        }
        let run: String = r.get("id");
        if decision != Decision::AbandonUnaccepted
            || r.get::<&str, _>("state") != "awaiting_acceptance"
            || !matches!(r.get::<&str, _>("role"), "deep" | "fast")
            || r.get::<String, _>("owner_id") != owner.to_string()
            || r.get::<String, _>("conversation_id") != conversation.to_string()
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let completions: Vec<String> = sqlx::query_scalar("SELECT o.event_id FROM production_observations o JOIN events e ON e.id=o.event_id WHERE o.run_id=? AND o.kind='completed_proposal' AND o.receipt_state='awaiting_acceptance' AND e.owner_id=? AND e.conversation_id=? AND e.kind='provider_observed' AND e.schema_version=5")
            .bind(&run).bind(owner.to_string()).bind(conversation.to_string())
            .fetch_all(&mut *tx).await.map_err(db)?;
        let children: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs c JOIN worker_provider_delegations d ON d.id=c.worker_delegation_id WHERE d.parent_run_id=? AND c.state NOT IN ('cancelled','succeeded')")
            .bind(&run).fetch_one(&mut *tx).await.map_err(db)?;
        let busy: i64 = sqlx::query_scalar("SELECT count(*) FROM session_bindings b JOIN production_readiness rd ON rd.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND b.generation=? AND b.native_session_id=? AND b.provider_kind=? AND b.role=? AND b.state='busy' AND rd.context_id=? AND rd.incarnation_id=?")
            .bind(r.get::<String, _>("session_id")).bind(owner.to_string()).bind(conversation.to_string())
            .bind(r.get::<i64, _>("binding_generation")).bind(r.get::<String, _>("native_session_id"))
            .bind(r.get::<String, _>("provider_kind")).bind(r.get::<String, _>("role"))
            .bind(&context).bind(&incarnation)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if completions.len() != 1 || children != 0 || busy != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        abandon.push(Abandon {
            run,
            completion: completions[0].clone(),
            session: r.get("session_id"),
            binding_generation: r.get("binding_generation"),
        });
    }
    if !super::super::terminal_retirement::descendants_clear(tx, &context).await? {
        return Err(RuntimeStoreError::Fenced);
    }
    // The successor lineage is anchored on this window's own last Deep turn.
    let prior = runs
        .iter()
        .rev()
        .find(|r| r.get::<&str, _>("role") == "deep")
        .ok_or(RuntimeStoreError::Fenced)?;
    let prior_run: String = prior.get("id");
    let member: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM execution_window_inputs WHERE window_id=? AND event_id=?",
    )
    .bind(window.to_string())
    .bind(prior.get::<String, _>("event_id"))
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if member != 1 {
        return Err(RuntimeStoreError::Fenced);
    }
    let (outcome, terminal_event) = match abandon.iter().find(|a| a.run == prior_run) {
        Some(a) => (Outcome::Abandoned, a.completion.clone()),
        None => {
            let t = sqlx::query(
                "SELECT event_id,terminal_kind FROM production_terminal_evidence WHERE run_id=?",
            )
            .bind(&prior_run)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or(RuntimeStoreError::Fenced)?;
            let outcome =
                Outcome::parse(t.get("terminal_kind")).ok_or(RuntimeStoreError::Fenced)?;
            (outcome, t.get::<String, _>("event_id"))
        }
    };
    // Already recorded provenance (graceful teardown that lost its window
    // retirement) must name exactly this run; anything else is not ours.
    let provenance: Vec<String> = sqlx::query_scalar("SELECT prior_run_id FROM production_retirement_provenance WHERE context_id=? AND incarnation_id=? AND supervisor_generation=?")
        .bind(&context).bind(&incarnation).bind(supervisor_generation)
        .fetch_all(&mut *tx).await.map_err(db)?;
    if provenance.iter().any(|run| run != &prior_run) {
        return Err(RuntimeStoreError::Fenced);
    }
    // Inputs admitted to this window but never consumed by a Deep run return to
    // ordinary admission; nothing ever executed on their behalf in Deep.
    let release: Vec<String> = sqlx::query_scalar("SELECT wi.event_id FROM execution_window_inputs wi JOIN reasoning_inbox i ON i.event_id=wi.event_id WHERE wi.window_id=? AND i.state!='consumed' AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.event_id=wi.event_id AND r.role='deep') ORDER BY i.sequence")
        .bind(window.to_string()).fetch_all(&mut *tx).await.map_err(db)?;
    let abandoned_run_ids = abandon
        .iter()
        .map(|a| Ok(RunId(a.run.parse().map_err(db)?)))
        .collect::<Result<Vec<_>>>()?;
    Ok(Planned::Plan(Box::new(Plan {
        public: StrandedExecutionWindowPlan {
            window_id: window,
            conversation_id: conversation.clone(),
            generation,
            outcome,
            prior_run_id: RunId(prior_run.parse().map_err(db)?),
            terminal_event_id: EventId(terminal_event.parse().map_err(db)?),
            abandoned_run_ids,
            hard_deadline_passed,
        },
        context,
        incarnation,
        supervisor_generation,
        credential_hash,
        prior_session: prior.get("session_id"),
        provenance_exists: !provenance.is_empty(),
        abandon,
        release,
    })))
}
