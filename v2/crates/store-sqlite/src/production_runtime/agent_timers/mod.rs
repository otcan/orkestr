//! Agent-facing timers (TASK-52): a running Deep turn lists, creates,
//! cancels, pauses, resumes and skips timers of its OWN conversation.
//!
//! Authority follows the thread-ask grant (#341): the owner issues a
//! per-conversation agent-timer grant (shown once, stored as a hash). The
//! grant is separate from the thread-ask grant, so neither implies the other.
//! It only works while its conversation has a dispatched Deep run, and every
//! step is pinned to that run in the audit. The conversation always comes
//! from the grant: a request names no conversation, a created timer is
//! mapped to the grant's conversation immutably, and a namespace of any other
//! conversation reads as not found. Fast never gets this tool: it runs in the
//! read-only sandbox, it is never given the grant, and a Fast run alone does
//! not satisfy the running-Deep check.
//!
//! Caps: at most `AGENT_TIMER_ACTIVE_MAX` live agent-created timers and
//! `AGENT_TIMER_HOURLY_CREATES_MAX` creates per hour per conversation; a
//! one-shot run at least 2 minutes ahead; a recurring rule never more often
//! than every 30 minutes; pauses of at most 60 days. Stop and rollback stay
//! owner-only, and an agent cancel is an ordinary disable the owner can undo.
//! Every authenticated attempt is audited (refusals throttled).
use super::thread_asks::{name, running_deep, unavailable_conversation};
use super::*;
use crate::conversation_resources::{now_ms, owned};
use crate::history_import::timers::{
    agent::{
        agent_namespace, agent_schedule, agent_timer_control, agent_timer_create, agent_timer_list,
        agent_timer_one, agent_timers_created_since, agent_timers_live, AgentTimerFacts,
        AgentTimerNew,
    },
    authority::store_clock,
    local_time_label,
    policy::FOREVER_MS,
    TimerSchedule, TimerState,
};
use crate::ResourceError;
use orkestr_v2_contracts::{
    AgentTimerControl, AgentTimerCreate, AgentTimerGrant, AgentTimerGrantDirectory,
    AgentTimerGrantEntry, AgentTimerGrantIssued, AgentTimerList, AgentTimerReceipt, AgentTimerView,
    ConversationId, AGENT_TIMER_ACTIVE_MAX, AGENT_TIMER_HOURLY_CREATES_MAX,
    AGENT_TIMER_REFUSALS_MAX,
};
use sqlx::{sqlite::SqliteRow, Acquire, Sqlite, Transaction};
mod grant;

type R<T> = std::result::Result<T, ResourceError>;
fn unavailable(_: impl std::fmt::Display) -> ResourceError {
    ResourceError::Unavailable
}
fn grant_hash(grant: &str) -> String {
    crate::digest(&format!("orkestr-v2-agent-timer-grant:{grant}"))
}
fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn uuid(value: &str) -> R<Uuid> {
    Uuid::parse_str(value).map_err(unavailable)
}

/// Grant holder's derived scope; never constructed from request fields.
struct Caller {
    owner: OwnerId,
    generation: i64,
}
async fn caller_in(
    tx: &mut Transaction<'_, Sqlite>,
    grant: &str,
    conversation: &ConversationId,
) -> R<Caller> {
    let row = sqlx::query(
        "SELECT owner_id,generation FROM agent_timer_grants WHERE conversation_id=? AND grant_hash=?",
    )
    .bind(conversation.to_string())
    .bind(grant_hash(grant))
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?
    .ok_or(ResourceError::Unauthorized)?;
    let owner = OwnerId(uuid(row.get("owner_id")).map_err(|_| ResourceError::Unauthorized)?);
    owned(tx, &owner, conversation).await?;
    Ok(Caller {
        owner,
        generation: row.get("generation"),
    })
}

/// The instruction every run of an agent-created timer receives.
fn instruction(label: &str, text: &str) -> String {
    let label: String = label
        .chars()
        .map(|c| if c == '"' { '\'' } else { c })
        .collect();
    format!(
        "[Orkestr timer \"{label}\", set by this thread's agent with the agent timer tool. \
The instruction below was written by the agent when it set the timer, not typed by the owner now.]\n\n{text}"
    )
}
fn request_digest(request: &AgentTimerCreate) -> R<String> {
    let body = serde_json::to_string(&serde_json::json!([
        "orkestr.agent-timer.create.v1",
        request.label,
        request.schedule,
        request.text
    ]))
    .map_err(unavailable)?;
    Ok(crate::digest(&body))
}

fn state_text(state: TimerState) -> &'static str {
    match state {
        TimerState::Paused => "paused",
        TimerState::Enabled => "enabled",
        TimerState::Disabled => "disabled",
        TimerState::Stopped => "stopped",
        TimerState::RolledBack => "rolled_back",
        TimerState::Exhausted => "exhausted",
    }
}
fn describe(schedule: &TimerSchedule) -> String {
    let clock = |m: u16| format!("{:02}:{:02}", m / 60, m % 60);
    match schedule {
        TimerSchedule::Once { due_ms } => format!(
            "once at {}",
            local_time_label("UTC", *due_ms).unwrap_or_else(|| due_ms.to_string())
        ),
        TimerSchedule::Interval { every_ms } => format!("every {} minutes", every_ms / 60_000),
        TimerSchedule::UtcClock {
            weekly,
            minute_of_day,
        } => format!(
            "{} at {} UTC",
            if *weekly { "weekly" } else { "daily" },
            clock(*minute_of_day)
        ),
        TimerSchedule::ZonedClock {
            timezone,
            weekday,
            minute_of_day,
        } => match weekday {
            Some(day) => format!("weekly (day {day}) at {} {timezone}", clock(*minute_of_day)),
            None => format!("daily at {} {timezone}", clock(*minute_of_day)),
        },
        TimerSchedule::Calendar(rule) => rule.describe(),
        TimerSchedule::Event => "on trigger events".into(),
        TimerSchedule::Dormant { .. } => "dormant legacy cadence".into(),
    }
}
fn view(facts: &AgentTimerFacts, now: i64) -> AgentTimerView {
    let listing = &facts.listing;
    let receipt = &listing.detail.receipt;
    AgentTimerView {
        namespace: receipt.namespace,
        label: listing.label.clone(),
        state: state_text(receipt.state).into(),
        schedule: describe(&listing.detail.schedule),
        next_due_ms: receipt.next_due_ms.filter(|due| *due < FOREVER_MS),
        pause_until_ms: listing.policy.pause_until_ms.filter(|until| *until > now),
        created_by_agent: facts.created_by_agent,
    }
}

#[allow(clippy::too_many_arguments)]
async fn audit(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    run: Option<&str>,
    generation: i64,
    operation: &str,
    namespace: Option<Uuid>,
    request_key: &str,
    outcome: &str,
) -> R<()> {
    sqlx::query("INSERT INTO agent_timer_audit(owner_id,conversation_id,run_id,grant_generation,operation,namespace,request_key,outcome,at_ms) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(run).bind(generation)
        .bind(operation).bind(namespace.map(|n| n.to_string())).bind(request_key).bind(outcome).bind(now_ms())
        .execute(tx).await.map_err(unavailable)?;
    Ok(())
}

/// Refusal codes of one step; mapped to HTTP statuses by the server.
type Step<T> = std::result::Result<T, &'static str>;

/// Settle one step inside its savepoint: an accepted step commits with its
/// audit row and receipt; a refused one is rolled back entirely.
#[allow(clippy::too_many_arguments)]
async fn settle(
    mut savepoint: Transaction<'_, Sqlite>,
    step: Step<bool>,
    caller: &Caller,
    conversation: &ConversationId,
    run: Option<&str>,
    operation: &str,
    namespace: Uuid,
    request_key: &str,
) -> R<Step<AgentTimerReceipt>> {
    let changed = match step {
        Ok(changed) => changed,
        Err(code) => {
            savepoint.rollback().await.map_err(unavailable)?;
            return Ok(Err(code));
        }
    };
    let owner = &caller.owner;
    let now = store_clock(&mut savepoint)
        .await
        .map_err(|_| ResourceError::Unavailable)?;
    let facts = match agent_timer_one(&mut savepoint, owner, conversation, namespace).await {
        Ok(facts) => facts,
        Err(refusal) => {
            savepoint.rollback().await.map_err(unavailable)?;
            return Ok(Err(refusal.code()));
        }
    };
    audit(
        &mut savepoint,
        owner,
        conversation,
        run,
        caller.generation,
        operation,
        Some(namespace),
        request_key,
        if changed { "accepted" } else { "replayed" },
    )
    .await?;
    savepoint.commit().await.map_err(unavailable)?;
    Ok(Ok(AgentTimerReceipt {
        changed,
        timer: view(&facts, now),
    }))
}
/// Commit the settled step, or only the refusal's audit row.
#[allow(clippy::too_many_arguments)]
async fn finish(
    mut tx: Transaction<'_, Sqlite>,
    settled: Step<AgentTimerReceipt>,
    caller: &Caller,
    conversation: &ConversationId,
    run: Option<&str>,
    operation: &str,
    namespace: Uuid,
    request_key: &str,
) -> R<AgentTimerReceipt> {
    match settled {
        Ok(receipt) => {
            tx.commit().await.map_err(unavailable)?;
            Ok(receipt)
        }
        Err(code) => {
            audit(
                &mut tx,
                &caller.owner,
                conversation,
                run,
                caller.generation,
                operation,
                Some(namespace),
                request_key,
                code,
            )
            .await?;
            tx.commit().await.map_err(unavailable)?;
            Err(ResourceError::Conflict(code))
        }
    }
}

impl Store {
    /// Validate the grant in a deferred read transaction. With `write`, the
    /// returned transaction is a fresh IMMEDIATE one that re-validated the
    /// grant, so an invalid grant can never take the write lock.
    async fn agent_timer_scope(
        &self,
        grant: &str,
        conversation: &ConversationId,
        write: bool,
    ) -> R<(Transaction<'_, Sqlite>, Caller)> {
        if self.authority.is_some() || !hex64(grant) {
            return Err(ResourceError::Unauthorized);
        }
        if conversation.0.is_nil() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let caller = caller_in(&mut tx, grant, conversation).await?;
        if !write {
            return Ok((tx, caller));
        }
        // Over the refusal budget: refuse without any write.
        let refused: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_timer_audit WHERE conversation_id=? AND outcome NOT IN ('accepted','replayed') AND at_ms>?")
            .bind(conversation.to_string()).bind(now_ms() - 600_000)
            .fetch_one(&mut *tx).await.map_err(unavailable)?;
        if refused >= AGENT_TIMER_REFUSALS_MAX {
            return Err(ResourceError::Conflict("agent_timer_rate_limited"));
        }
        tx.commit().await.map_err(unavailable)?;
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(unavailable)?;
        let caller = caller_in(&mut tx, grant, conversation).await?;
        Ok((tx, caller))
    }

    /// Every timer of the grant's conversation. Needs a running Deep turn.
    pub async fn agent_timers(
        &self,
        grant: &str,
        conversation: &ConversationId,
    ) -> R<AgentTimerList> {
        let (mut tx, caller) = self.agent_timer_scope(grant, conversation, false).await?;
        if running_deep(&mut tx, &caller.owner, conversation)
            .await?
            .is_none()
        {
            return Err(ResourceError::Conflict("agent_timer_no_running_turn"));
        }
        let now = store_clock(&mut tx)
            .await
            .map_err(|_| ResourceError::Unavailable)?;
        let facts = agent_timer_list(&mut tx, &caller.owner, conversation)
            .await
            .map_err(|r| ResourceError::Conflict(r.code()))?;
        tx.commit().await.map_err(unavailable)?;
        Ok(AgentTimerList {
            conversation_id: conversation.clone(),
            timers: facts.iter().map(|f| view(f, now)).collect(),
        })
    }

    /// Create and enable one timer in the grant's conversation (or replay the
    /// same request key with the same body).
    pub async fn create_agent_timer(
        &self,
        grant: &str,
        conversation: &ConversationId,
        request: &AgentTimerCreate,
    ) -> R<AgentTimerReceipt> {
        if !request.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let digest = request_digest(request)?;
        let (mut tx, caller) = self.agent_timer_scope(grant, conversation, true).await?;
        let owner = caller.owner.clone();
        let namespace = agent_namespace(&owner, conversation, &request.request_key);
        let run = running_deep(&mut tx, &owner, conversation)
            .await?
            .map(|(run, _)| run);
        let mut savepoint = tx.begin().await.map_err(unavailable)?;
        let step: Step<bool> = async {
            let run = run.as_deref().ok_or("agent_timer_no_running_turn")?;
            if unavailable_conversation(&mut savepoint, &owner, &conversation.to_string())
                .await
                .map_err(|_| "agent_timer_unavailable")?
            {
                return Err("agent_timer_conversation_unavailable");
            }
            let prior: Option<String> = sqlx::query_scalar("SELECT request_digest FROM agent_timers WHERE owner_id=? AND conversation_id=? AND request_key=?")
                .bind(owner.to_string()).bind(conversation.to_string()).bind(&request.request_key)
                .fetch_optional(&mut *savepoint).await.map_err(|_| "agent_timer_unavailable")?;
            match prior {
                Some(prior) if prior == digest => return Ok(false),
                Some(_) => return Err("agent_timer_conflict"),
                None => {}
            }
            let now = store_clock(&mut savepoint)
                .await
                .map_err(|_| "agent_timer_unavailable")?;
            let live = agent_timers_live(&mut savepoint, &owner, conversation)
                .await
                .map_err(|r| r.code())?;
            let recent =
                agent_timers_created_since(&mut savepoint, &owner, conversation, now - 3_600_000)
                    .await
                    .map_err(|r| r.code())?;
            if live >= AGENT_TIMER_ACTIVE_MAX {
                return Err("agent_timer_limit_reached");
            }
            if recent >= AGENT_TIMER_HOURLY_CREATES_MAX {
                return Err("agent_timer_rate_limited");
            }
            let schedule = agent_schedule(&request.schedule, now).map_err(|r| r.code())?;
            agent_timer_create(
                &mut savepoint,
                &owner,
                conversation,
                &AgentTimerNew {
                    namespace,
                    label: request.label.trim(),
                    schedule,
                    instruction: instruction(request.label.trim(), &request.text),
                    request_key: &request.request_key,
                    request_digest: &digest,
                    run_id: run,
                    grant_generation: caller.generation,
                },
            )
            .await
            .map_err(|r| r.code())
        }
        .await;
        let settled = settle(
            savepoint,
            step,
            &caller,
            conversation,
            run.as_deref(),
            "create",
            namespace,
            &request.request_key,
        )
        .await?;
        finish(
            tx,
            settled,
            &caller,
            conversation,
            run.as_deref(),
            "create",
            namespace,
            &request.request_key,
        )
        .await
    }

    /// Cancel, pause, resume or skip the next run of one timer of the grant's
    /// conversation. Any other conversation's timer is not found.
    pub async fn control_agent_timer(
        &self,
        grant: &str,
        conversation: &ConversationId,
        namespace: Uuid,
        request: &AgentTimerControl,
    ) -> R<AgentTimerReceipt> {
        if !request.is_valid() || namespace.is_nil() {
            return Err(ResourceError::Invalid);
        }
        let (mut tx, caller) = self.agent_timer_scope(grant, conversation, true).await?;
        let owner = caller.owner.clone();
        let run = running_deep(&mut tx, &owner, conversation)
            .await?
            .map(|(run, _)| run);
        let mut savepoint = tx.begin().await.map_err(unavailable)?;
        let step: Step<bool> = async {
            run.as_deref().ok_or("agent_timer_no_running_turn")?;
            if unavailable_conversation(&mut savepoint, &owner, &conversation.to_string())
                .await
                .map_err(|_| "agent_timer_unavailable")?
            {
                return Err("agent_timer_conversation_unavailable");
            }
            // The same request key for the same step replays (a lost
            // response is retried without skipping a second run).
            let done: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_timer_audit WHERE owner_id=? AND conversation_id=? AND namespace=? AND operation=? AND request_key=? AND outcome='accepted'")
                .bind(owner.to_string()).bind(conversation.to_string()).bind(namespace.to_string())
                .bind(request.operation.text()).bind(&request.request_key)
                .fetch_one(&mut *savepoint).await.map_err(|_| "agent_timer_unavailable")?;
            if done != 0 {
                return Ok(false);
            }
            agent_timer_control(
                &mut savepoint,
                &owner,
                conversation,
                namespace,
                request.operation,
                request.until_ms,
                &request.request_key,
            )
            .await
            .map_err(|r| r.code())
        }
        .await;
        let operation = request.operation.text();
        let settled = settle(
            savepoint,
            step,
            &caller,
            conversation,
            run.as_deref(),
            operation,
            namespace,
            &request.request_key,
        )
        .await?;
        finish(
            tx,
            settled,
            &caller,
            conversation,
            run.as_deref(),
            operation,
            namespace,
            &request.request_key,
        )
        .await
    }

    /// Owner diagnostics: the audit rows of one conversation, newest first.
    pub async fn agent_timer_audit_outcomes(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> R<Vec<(String, String)>> {
        sqlx::query_as("SELECT operation,outcome FROM agent_timer_audit WHERE owner_id=? AND conversation_id=? ORDER BY row_sequence DESC LIMIT 100")
            .bind(owner.to_string()).bind(conversation.to_string())
            .fetch_all(&self.pool).await.map_err(unavailable)
    }
}

#[cfg(test)]
mod tests;
