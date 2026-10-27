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
//! awaiting acceptance or a Worker left `cancel_requested` after its lease
//! deadline. Such proposals are explicitly ABANDONED, never accepted and never
//! re-executed; such Workers are FAILED with their cause, never stopped. The
//! private window credential is revoked, so a surviving holder of it is fenced.
//! Inputs admitted to the window that no Deep run consumed are released back to
//! ordinary admission. A window whose open failed before it ran anything of its
//! own is closed as `failed` instead (see `stranded_open.rs`). Every decision
//! leaves an immutable audit row; observations, payloads and receipts are kept.
use super::*;
use orkestr_v2_contracts::{
    ExecutionWindowOpenFailureCause as Cause, ExecutionWindowReconciliation,
    ExecutionWindowReconciliationActor as Actor, ExecutionWindowReconciliationDecision as Decision,
    ExecutionWindowTerminalOutcome as Outcome,
};

/// Locators for the trusted server's manager step. Not authority: commit
/// revalidates everything under its own write transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrandedExecutionWindowPlan {
    pub window_id: Uuid,
    pub conversation_id: ConversationId,
    pub generation: u64,
    pub outcome: Outcome,
    /// The window's own last Deep turn; None only for a `failed` open.
    pub prior_run_id: Option<RunId>,
    pub terminal_event_id: Option<EventId>,
    pub abandoned_run_ids: Vec<RunId>,
    pub failed_run_ids: Vec<RunId>,
    pub open_failure_cause: Option<Cause>,
    pub restored_window_id: Option<Uuid>,
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
    /// The owner can read and accept it: it keeps the acceptance grace.
    acceptable: bool,
    worker: bool,
}

struct Plan {
    public: StrandedExecutionWindowPlan,
    kind: Kind,
    /// The owner's acceptance grace after the hard deadline has passed.
    abandon_grace_passed: bool,
}

/// Proposals awaiting acceptance stay acceptable this long after their
/// window's hard deadline; only then may the automatic path abandon them.
/// The owner may abandon earlier through the explicit endpoint.
pub(super) const ACCEPTANCE_GRACE_MS: i64 = 86_400_000;

enum Kind {
    Turns(Box<Turns>),
    Open(Box<open::OpenPlan>),
}

struct Turns {
    context: String,
    incarnation: String,
    supervisor_generation: i64,
    credential_hash: String,
    prior_session: String,
    provenance_exists: bool,
    abandon: Vec<Abandon>,
    fail: Vec<Fail>,
    release: Vec<String>,
}

enum Planned {
    Plan(Box<Plan>),
    Replay(ExecutionWindowReconciliation),
}

#[path = "stranded_receipt.rs"]
mod receipt;
use receipt::receipt_in;
#[path = "stranded_open.rs"]
mod open;
#[path = "stranded_worker.rs"]
mod worker;
use worker::{descendants_clear_except, failed_worker, Fail};
#[path = "stranded_commit.rs"]
mod commit;
#[path = "stranded_lapse.rs"]
mod lapse;
use commit::commit_turns;

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
        let p = &plan.public;
        // The deadline flag may legitimately flip between plan and commit.
        if p.outcome != expected.outcome
            || p.prior_run_id != expected.prior_run_id
            || p.terminal_event_id != expected.terminal_event_id
            || p.abandoned_run_ids != expected.abandoned_run_ids
            || p.failed_run_ids != expected.failed_run_ids
            || p.open_failure_cause != expected.open_failure_cause
            || p.restored_window_id != expected.restored_window_id
        {
            return Err(RuntimeStoreError::Conflict);
        }
        let clock = now(&mut tx).await?;
        let id = Uuid::new_v4();
        match &plan.kind {
            Kind::Turns(turns) => {
                commit_turns(
                    &mut tx,
                    &owner,
                    conversation,
                    p,
                    turns,
                    id,
                    decision,
                    actor,
                    clock,
                )
                .await?
            }
            Kind::Open(failure) => {
                open::commit(&mut tx, &owner, p, failure, id, decision, actor, clock).await?
            }
        }
        let receipt = receipt_in(&mut tx, &p.window_id.to_string(), false).await?;
        tx.commit().await.map_err(db)?;
        Ok(receipt)
    }
}

/// Window inputs no Deep run consumed return to ordinary admission; the
/// original receipt is archived under the deciding audit row.
async fn release_inputs(
    tx: &mut SqliteConnection,
    reconciliation: &Uuid,
    window: Uuid,
    release: &[String],
    failed_open: bool,
) -> Result<()> {
    // Closed constant identifiers, never caller data.
    let (table, column) = if failed_open {
        ("execution_window_open_failure_inputs", "failure_id")
    } else {
        ("execution_window_released_inputs", "reconciliation_id")
    };
    for event in release {
        sqlx::query(&format!("INSERT INTO {table}(event_id,{column},window_id,owner_id,conversation_id,request_key,semantic_digest,message_id,input_request_key,receipt_json) SELECT event_id,?,window_id,owner_id,conversation_id,request_key,semantic_digest,message_id,input_request_key,receipt_json FROM execution_window_inputs WHERE event_id=? AND window_id=?"))
            .bind(reconciliation.to_string()).bind(event).bind(window.to_string())
            .execute(&mut *tx).await.map_err(db)?;
        let deleted =
            sqlx::query("DELETE FROM execution_window_inputs WHERE event_id=? AND window_id=?")
                .bind(event)
                .bind(window.to_string())
                .execute(&mut *tx)
                .await
                .map_err(db)?
                .rows_affected();
        if deleted != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
    }
    Ok(())
}

/// Inputs admitted to this window but never consumed by a Deep run.
/// An input a parallel slot deferred back to the writer counts as unconsumed:
/// only a canonical run consumes for good.
async fn unconsumed_inputs(tx: &mut SqliteConnection, window: Uuid) -> Result<Vec<String>> {
    let canonical = if super::super::parallel_deep::present(tx).await? {
        format!(" AND {}", super::super::parallel_deep::canonical_run("r"))
    } else {
        String::new()
    };
    sqlx::query_scalar(&format!("SELECT wi.event_id FROM execution_window_inputs wi JOIN reasoning_inbox i ON i.event_id=wi.event_id WHERE wi.window_id=? AND i.state IN ('queued','claimed') AND NOT EXISTS(SELECT 1 FROM production_runs r WHERE r.event_id=wi.event_id AND r.role='deep'{canonical}) ORDER BY i.sequence"))
        .bind(window.to_string()).fetch_all(&mut *tx).await.map_err(db)
}

async fn lapsed_in(tx: &mut SqliteConnection, run: &str) -> Result<bool> {
    let lapsed: i64 =
        sqlx::query_scalar("SELECT count(*) FROM production_run_lapses WHERE run_id=?")
            .bind(run)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
    Ok(lapsed == 1)
}

fn startup_allowed(plan: &Plan, actor: Actor) -> Result<()> {
    // Automatic recovery only after the hard deadline: the window could never
    // have legitimately produced more work. Earlier abandonment is owner-only.
    if actor == Actor::Startup && !plan.public.hard_deadline_passed {
        return Err(RuntimeStoreError::Fenced);
    }
    // A proposal the owner can still accept is never abandoned automatically
    // before the acceptance grace has passed.
    let acceptable = match &plan.kind {
        Kind::Turns(turns) => turns.abandon.iter().any(|a| a.acceptable),
        Kind::Open(_) => false,
    };
    if actor == Actor::Startup && acceptable && !plan.abandon_grace_passed {
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
            "SELECT decision FROM execution_window_reconciliations WHERE window_id=? UNION ALL SELECT decision FROM execution_window_open_failures WHERE window_id=?",
        )
        .bind(window.to_string())
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
    if state != "reconciliation_required" {
        return Err(RuntimeStoreError::Fenced);
    }
    let clock = now(tx).await?;
    let hard_deadline_passed = w.get::<i64, _>("expires_at_ms") <= clock;
    // A window that never ran anything of its own failed to open.
    if let Some(failure) = open::plan(tx, owner, conversation, &w, hard_deadline_passed).await? {
        return Ok(Planned::Plan(failure));
    }
    if w.get::<i64, _>("credential_issued") != 1 || w.get::<i64, _>("credential_bound") != 1 {
        return Err(RuntimeStoreError::Fenced);
    }
    let (Some(context), Some(incarnation), Some(credential_hash)) = (
        w.get::<Option<String>, _>("context_id"),
        w.get::<Option<String>, _>("incarnation_id"),
        w.get::<Option<String>, _>("credential_hash"),
    ) else {
        return Err(RuntimeStoreError::Fenced);
    };
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
    // A read-only parallel Deep run (slot > 0) settles like any proposal but
    // never anchors the successor lineage.
    let slot = if super::super::parallel_deep::present(tx).await? {
        "(SELECT b.deep_slot FROM session_bindings b WHERE b.id=r.session_id)"
    } else {
        "0"
    };
    let runs = sqlx::query(&format!("SELECT r.*,(SELECT t.terminal_kind FROM production_terminal_evidence t WHERE t.run_id=r.id) AS terminal,{slot} AS parallel_slot FROM production_runs r WHERE r.context_id=? AND r.incarnation_id=? ORDER BY r.scope_sequence,r.id"))
        .bind(&context).bind(&incarnation).fetch_all(&mut *tx).await.map_err(db)?;
    let unresolved: Vec<&SqliteRow> = runs
        .iter()
        .filter(|r| r.get::<Option<String>, _>("terminal").is_none())
        .collect();
    // Workers first: a Deep parent may only be abandoned once each of its
    // admitted children is terminal or planned to fail or be abandoned here.
    let mut fail = Vec::new();
    let mut abandon = Vec::new();
    let workers = unresolved
        .iter()
        .filter(|r| r.get::<&str, _>("role") == "worker");
    for r in workers.clone() {
        if r.get::<&str, _>("state") != "awaiting_acceptance" {
            fail.push(failed_worker(tx, owner, conversation, &context, r, clock).await?);
        }
    }
    let proposals = workers
        .filter(|r| r.get::<&str, _>("state") == "awaiting_acceptance")
        .chain(
            unresolved
                .iter()
                .filter(|r| r.get::<&str, _>("role") != "worker"),
        );
    for r in proposals {
        let run: String = r.get("id");
        if decision != Decision::AbandonUnaccepted
            || r.get::<&str, _>("state") != "awaiting_acceptance"
            || r.get::<String, _>("owner_id") != owner.to_string()
            || r.get::<String, _>("conversation_id") != conversation.to_string()
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let completions: Vec<String> = sqlx::query_scalar("SELECT o.event_id FROM production_observations o JOIN events e ON e.id=o.event_id WHERE o.run_id=? AND o.kind='completed_proposal' AND o.receipt_state='awaiting_acceptance' AND e.owner_id=? AND e.conversation_id=? AND e.kind='provider_observed' AND e.schema_version=5")
            .bind(&run).bind(owner.to_string()).bind(conversation.to_string())
            .fetch_all(&mut *tx).await.map_err(db)?;
        let children: Vec<String> = sqlx::query_scalar("SELECT c.id FROM production_runs c JOIN worker_provider_delegations d ON d.id=c.worker_delegation_id WHERE d.parent_run_id=? AND c.state NOT IN ('cancelled','succeeded')")
            .bind(&run).fetch_all(&mut *tx).await.map_err(db)?;
        let busy: i64 = sqlx::query_scalar("SELECT count(*) FROM session_bindings b JOIN production_readiness rd ON rd.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND b.generation=? AND b.native_session_id=? AND b.provider_kind=? AND b.role=? AND b.state='busy' AND rd.context_id=? AND rd.incarnation_id=?")
            .bind(r.get::<String, _>("session_id")).bind(owner.to_string()).bind(conversation.to_string())
            .bind(r.get::<i64, _>("binding_generation")).bind(r.get::<String, _>("native_session_id"))
            .bind(r.get::<String, _>("provider_kind")).bind(r.get::<String, _>("role"))
            .bind(&context).bind(&incarnation)
            .fetch_one(&mut *tx).await.map_err(db)?;
        let settled = |c: &String| {
            fail.iter().any(|f| &f.run == c) || abandon.iter().any(|a: &Abandon| &a.run == c)
        };
        // A proposal without one readable completion is settled first.
        if completions.len() != 1 || !children.iter().all(settled) {
            return Err(RuntimeStoreError::Fenced);
        }
        // Readable and acceptable through the owner's surfaces: a Deep or
        // Worker proposal on its own busy session. A Fast proposal of a window
        // no process owns has no readable execution record (its status needs
        // the window's live Fast scope), so the owner cannot accept it.
        let acceptable = r.get::<&str, _>("role") != "fast" && busy == 1;
        abandon.push(Abandon {
            run,
            completion: completions[0].clone(),
            session: r.get("session_id"),
            binding_generation: r.get("binding_generation"),
            acceptable,
            worker: r.get::<&str, _>("role") == "worker",
        });
    }
    // Failed or abandoned Workers clear their own effects at commit (the
    // commit rechecks every descendant); anything else pending (tasks,
    // tool effects) still refuses here.
    let settled_workers = abandon.iter().any(|a| a.worker);
    if fail.is_empty()
        && !settled_workers
        && !super::super::terminal_retirement::descendants_clear(tx, &context).await?
    {
        return Err(RuntimeStoreError::Fenced);
    }
    if (!fail.is_empty() || settled_workers)
        && !descendants_clear_except(tx, &context, &fail).await?
    {
        return Err(RuntimeStoreError::Fenced);
    }
    // The successor lineage is anchored on this window's own last canonical
    // Deep turn, never on a read-only parallel slot run.
    let prior = runs
        .iter()
        .rev()
        .find(|r| {
            r.get::<&str, _>("role") == "deep"
                && r.get::<Option<i64>, _>("parallel_slot").unwrap_or(0) == 0
        })
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
            let outcome = match t.get::<&str, _>("terminal_kind") {
                "accepted" => Outcome::Accepted,
                "stopped" => Outcome::Stopped,
                "abandoned" => Outcome::Abandoned,
                // Only a lapsed Deep turn (0054) is a failed prior run.
                "failed" if lapsed_in(tx, &prior_run).await? => Outcome::Failed,
                _ => return Err(RuntimeStoreError::Fenced),
            };
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
    let release = unconsumed_inputs(tx, window).await?;
    let ids = |runs: Vec<&String>| {
        runs.into_iter()
            .map(|run| Ok(RunId(run.parse().map_err(db)?)))
            .collect::<Result<Vec<_>>>()
    };
    let abandoned_run_ids = ids(abandon.iter().map(|a| &a.run).collect())?;
    let failed_run_ids = ids(fail.iter().map(|f| &f.run).collect())?;
    Ok(Planned::Plan(Box::new(Plan {
        public: StrandedExecutionWindowPlan {
            window_id: window,
            conversation_id: conversation.clone(),
            generation,
            outcome,
            prior_run_id: Some(RunId(prior_run.parse().map_err(db)?)),
            terminal_event_id: Some(EventId(terminal_event.parse().map_err(db)?)),
            abandoned_run_ids,
            failed_run_ids,
            open_failure_cause: None,
            restored_window_id: None,
            hard_deadline_passed,
        },
        kind: Kind::Turns(Box::new(Turns {
            context,
            incarnation,
            supervisor_generation,
            credential_hash,
            prior_session: prior.get("session_id"),
            provenance_exists: !provenance.is_empty(),
            abandon,
            fail,
            release,
        })),
        abandon_grace_passed: w.get::<i64, _>("expires_at_ms") + ACCEPTANCE_GRACE_MS <= clock,
    })))
}
