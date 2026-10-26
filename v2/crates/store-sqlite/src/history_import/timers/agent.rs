//! Timer steps for the agent-facing timer tool (TASK-52). Each runs inside a
//! write transaction the caller already authorized for exactly one owner and
//! one conversation (`production_runtime::agent_timers`): the conversation is
//! the grant's, never a request field. Only timers mapped to that
//! conversation are visible or controllable; any other namespace reads as
//! not found. Nothing here stops, rolls back or re-homes a timer, and every
//! step reuses the owner path's own transitions (import, mapping, durable
//! enable, disable, policy pause), so the scheduler treats agent timers like
//! any other.
use super::authority::{enable_durable_in, store_clock, DurableTimerEnable};
use super::calendar_timer::{preview_schedule, CALENDAR_SOURCE};
use super::policy::{read_in, write_in, TimerPolicy, FOREVER_MS};
use super::target::{import_for_in, listings_in};
use super::*;
use orkestr_v2_contracts::{
    AgentTimerOperation, AgentTimerSchedule, AGENT_TIMER_MAX_HORIZON_MS, AGENT_TIMER_MAX_PAUSE_MS,
    AGENT_TIMER_MIN_INTERVAL_MS, AGENT_TIMER_MIN_LEAD_MS,
};

/// `source_thread_id` of a timer created through the agent tool.
pub const AGENT_SOURCE_THREAD: &str = "orkestr:agent";

/// Why a schedule or step was refused, as a stable code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentTimerRefusal {
    TooSoon,
    TooFar,
    TooFrequent,
    InvalidSchedule,
    NotFound,
    Conflict,
    NotRunning,
    SkipOnce,
    PauseInvalid,
    Ended,
    Unavailable,
}
impl AgentTimerRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::TooSoon => "agent_timer_too_soon",
            Self::TooFar => "agent_timer_too_far",
            Self::TooFrequent => "agent_timer_too_frequent",
            Self::InvalidSchedule => "agent_timer_invalid_schedule",
            Self::NotFound => "agent_timer_not_found",
            Self::Conflict => "agent_timer_conflict",
            Self::NotRunning => "agent_timer_not_running",
            Self::SkipOnce => "agent_timer_skip_once",
            Self::PauseInvalid => "agent_timer_pause_invalid",
            Self::Ended => "agent_timer_ended",
            Self::Unavailable => "agent_timer_unavailable",
        }
    }
}
impl From<HistoryError> for AgentTimerRefusal {
    fn from(error: HistoryError) -> Self {
        match error {
            HistoryError::Invalid => Self::InvalidSchedule,
            HistoryError::NotFound => Self::NotFound,
            HistoryError::Conflict => Self::Conflict,
            HistoryError::Unauthorized | HistoryError::Unavailable => Self::Unavailable,
        }
    }
}
type Step<T> = std::result::Result<T, AgentTimerRefusal>;

/// One timer of the conversation as the agent sees it.
#[derive(Debug, Clone)]
pub struct AgentTimerFacts {
    pub listing: TimerListing,
    pub created_by_agent: bool,
}

/// The schedule an agent asked for, with its caps applied: a one-shot run at
/// least `AGENT_TIMER_MIN_LEAD_MS` and at most the horizon ahead; a calendar
/// rule whose upcoming runs are never closer than the minimum interval.
pub(crate) fn agent_schedule(value: &AgentTimerSchedule, now_ms: i64) -> Step<TimerSchedule> {
    match value {
        AgentTimerSchedule::Once { due_ms } => {
            if *due_ms < now_ms.saturating_add(AGENT_TIMER_MIN_LEAD_MS) {
                Err(AgentTimerRefusal::TooSoon)
            } else if *due_ms > now_ms.saturating_add(AGENT_TIMER_MAX_HORIZON_MS) {
                Err(AgentTimerRefusal::TooFar)
            } else {
                Ok(TimerSchedule::Once { due_ms: *due_ms })
            }
        }
        AgentTimerSchedule::Calendar { .. } => {
            let rule = value
                .calendar_rule()
                .ok_or(AgentTimerRefusal::InvalidSchedule)?
                .normalized()
                .map_err(|_| AgentTimerRefusal::InvalidSchedule)?;
            let schedule = TimerSchedule::Calendar(rule);
            let upcoming = preview_schedule(&schedule, now_ms, 20)
                .map_err(|_| AgentTimerRefusal::InvalidSchedule)?;
            if upcoming.is_empty() {
                return Err(AgentTimerRefusal::InvalidSchedule);
            }
            if upcoming
                .windows(2)
                .any(|pair| pair[1] - pair[0] < AGENT_TIMER_MIN_INTERVAL_MS)
            {
                return Err(AgentTimerRefusal::TooFrequent);
            }
            Ok(schedule)
        }
    }
}

/// The namespace an agent request maps to: derived, so a replay of the same
/// key in the same conversation always names the same timer.
pub(crate) fn agent_namespace(owner: &OwnerId, conversation: &ConversationId, key: &str) -> Uuid {
    let digest = Sha256::digest(
        serde_json::json!([
            "orkestr.agent-timer.namespace.v1",
            owner.to_string(),
            conversation.to_string(),
            key
        ])
        .to_string()
        .as_bytes(),
    );
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Builder::from_random_bytes(bytes).into_uuid()
}

/// Every timer of the conversation (owner-created, imported and agent-created).
pub(crate) async fn agent_timer_list(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Step<Vec<AgentTimerFacts>> {
    let listings = listings_in(tx, owner, conversation).await?;
    let mut result = Vec::with_capacity(listings.len());
    for listing in listings {
        let created: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM agent_timers WHERE owner_id=? AND namespace=? AND conversation_id=?",
        )
        .bind(owner.to_string())
        .bind(listing.detail.receipt.namespace.to_string())
        .bind(conversation.to_string())
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| AgentTimerRefusal::Unavailable)?;
        result.push(AgentTimerFacts {
            listing,
            created_by_agent: created == 1,
        });
    }
    Ok(result)
}

/// One timer of exactly this conversation, else `NotFound` (another
/// conversation's or owner's timer is indistinguishable from none).
pub(crate) async fn agent_timer_one(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    namespace: Uuid,
) -> Step<AgentTimerFacts> {
    agent_timer_list(tx, owner, conversation)
        .await?
        .into_iter()
        .find(|t| t.listing.detail.receipt.namespace == namespace)
        .ok_or(AgentTimerRefusal::NotFound)
}

pub(crate) struct AgentTimerNew<'a> {
    pub namespace: Uuid,
    pub label: &'a str,
    pub schedule: TimerSchedule,
    /// The exact instruction every run receives (attribution included).
    pub instruction: String,
    pub request_key: &'a str,
    pub request_digest: &'a str,
    pub run_id: &'a str,
    pub grant_generation: i64,
}

/// Create and enable one timer in this conversation, or replay it. Returns
/// whether anything changed. The timer is mapped to the conversation
/// immutably and enabled under a durable grant there, exactly like an owner
/// calendar timer; it can never run in another conversation.
pub(crate) async fn agent_timer_create(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    new: &AgentTimerNew<'_>,
) -> Step<bool> {
    let prior: Option<(String, String)> = sqlx::query_as(
        "SELECT namespace,request_digest FROM agent_timers WHERE owner_id=? AND conversation_id=? AND request_key=?",
    )
    .bind(owner.to_string())
    .bind(conversation.to_string())
    .bind(new.request_key)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| AgentTimerRefusal::Unavailable)?;
    if let Some((namespace, digest)) = prior {
        return if namespace == new.namespace.to_string() && digest == new.request_digest {
            Ok(false)
        } else {
            Err(AgentTimerRefusal::Conflict)
        };
    }
    let now_ms = store_clock(tx).await?;
    let receipt = import_for_in(
        tx,
        owner,
        &TimerImportRequest {
            namespace: new.namespace,
            source_namespace: CALENDAR_SOURCE.into(),
            source_timer_id: new.namespace.to_string(),
            source_enabled: false,
            schedule: new.schedule.clone(),
        },
        &TimerTarget {
            conversation_id: conversation.clone(),
            label: new.label.to_owned(),
            source_thread_id: AGENT_SOURCE_THREAD.into(),
        },
    )
    .await?;
    if receipt.state != TimerState::Paused || receipt.generation != 0 {
        // The derived namespace already names a timer that was used before.
        return Err(AgentTimerRefusal::Conflict);
    }
    enable_durable_in(
        tx,
        owner,
        &DurableTimerEnable {
            timer: TimerEnableRequest {
                namespace: new.namespace,
                expected_revision: receipt.revision,
                request_key: format!("agent-enable:{}", new.namespace),
                conversation_id: conversation.clone(),
            },
            instruction: new.instruction.clone(),
        },
        now_ms,
    )
    .await?;
    sqlx::query("INSERT INTO agent_timers(owner_id,namespace,conversation_id,request_key,request_digest,created_run_id,grant_generation,created_ms) VALUES(?,?,?,?,?,?,?,?)")
        .bind(owner.to_string()).bind(new.namespace.to_string()).bind(conversation.to_string())
        .bind(new.request_key).bind(new.request_digest).bind(new.run_id).bind(new.grant_generation).bind(now_ms)
        .execute(&mut **tx).await.map_err(|_| AgentTimerRefusal::Unavailable)?;
    Ok(true)
}

/// Live agent-created timers of the conversation (enabled or paused).
pub(crate) async fn agent_timers_live(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Step<i64> {
    sqlx::query_scalar("SELECT count(*) FROM agent_timers a JOIN dormant_timers t ON t.owner_id=a.owner_id AND t.namespace=a.namespace WHERE a.owner_id=? AND a.conversation_id=? AND t.state IN ('enabled','paused')")
        .bind(owner.to_string()).bind(conversation.to_string())
        .fetch_one(&mut **tx).await.map_err(|_| AgentTimerRefusal::Unavailable)
}

/// Agent-created timers of the conversation since `since_ms`.
pub(crate) async fn agent_timers_created_since(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    since_ms: i64,
) -> Step<i64> {
    sqlx::query_scalar(
        "SELECT count(*) FROM agent_timers WHERE owner_id=? AND conversation_id=? AND created_ms>?",
    )
    .bind(owner.to_string())
    .bind(conversation.to_string())
    .bind(since_ms)
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| AgentTimerRefusal::Unavailable)
}

fn paused(policy: &TimerPolicy, now_ms: i64) -> bool {
    policy.pause_until_ms.is_some_and(|until| until > now_ms)
}

/// Cancel (disable), pause, resume or skip the next run of one timer of this
/// conversation. Returns whether anything changed; a repeat of a step already
/// in effect changes nothing. Stop and rollback stay owner-only.
pub(crate) async fn agent_timer_control(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    namespace: Uuid,
    operation: AgentTimerOperation,
    until_ms: Option<i64>,
    request_key: &str,
) -> Step<bool> {
    let facts = agent_timer_one(tx, owner, conversation, namespace).await?;
    let receipt = &facts.listing.detail.receipt;
    let now_ms = store_clock(tx).await?;
    let live = matches!(receipt.state, TimerState::Enabled | TimerState::Paused);
    match operation {
        AgentTimerOperation::Cancel => {
            if !live {
                return Ok(false);
            }
            super::control::control_in_transaction(
                tx,
                owner,
                &TimerControlRequest {
                    namespace,
                    expected_revision: receipt.revision,
                    request_key: format!("agent-cancel:{request_key}"),
                    action: TimerControl::Disable,
                },
            )
            .await?;
            Ok(true)
        }
        AgentTimerOperation::Pause => {
            if !live {
                return Err(AgentTimerRefusal::Ended);
            }
            let until = until_ms.unwrap_or(now_ms.saturating_add(AGENT_TIMER_MAX_PAUSE_MS));
            if until <= now_ms || until > now_ms.saturating_add(AGENT_TIMER_MAX_PAUSE_MS) {
                return Err(AgentTimerRefusal::PauseInvalid);
            }
            let policy = read_in(tx, owner, namespace).await?;
            if policy.pause_until_ms == Some(until) {
                return Ok(false);
            }
            write_in(tx, owner, namespace, None, now_ms, |u, _| {
                u.pause_until_ms = Some(until)
            })
            .await?;
            Ok(true)
        }
        AgentTimerOperation::Resume => {
            let policy = read_in(tx, owner, namespace).await?;
            if !paused(&policy, now_ms) {
                return Ok(false);
            }
            if policy.pause_until_ms.is_some_and(|u| u >= FOREVER_MS) {
                // An indefinite pause is the owner's; only the owner lifts it.
                return Err(AgentTimerRefusal::Conflict);
            }
            write_in(tx, owner, namespace, None, now_ms, |u, _| {
                u.pause_until_ms = None
            })
            .await?;
            Ok(true)
        }
        AgentTimerOperation::SkipNext => {
            if matches!(facts.listing.detail.schedule, TimerSchedule::Once { .. }) {
                return Err(AgentTimerRefusal::SkipOnce);
            }
            let next = match (receipt.state, receipt.next_due_ms) {
                (TimerState::Enabled, Some(next)) if next < FOREVER_MS => next,
                _ => return Err(AgentTimerRefusal::NotRunning),
            };
            // Pausing until just after the next run drops exactly that run;
            // the scheduler then moves to the following one.
            let policy = read_in(tx, owner, namespace).await?;
            let until = next
                .saturating_add(1)
                .max(policy.pause_until_ms.unwrap_or(0));
            if until > now_ms.saturating_add(AGENT_TIMER_MAX_HORIZON_MS) {
                return Err(AgentTimerRefusal::TooFar);
            }
            write_in(tx, owner, namespace, None, now_ms, |u, _| {
                u.pause_until_ms = Some(until)
            })
            .await?;
            Ok(true)
        }
    }
}
