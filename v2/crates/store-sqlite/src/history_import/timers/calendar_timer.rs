//! Natively created calendar and event timers (not imported from V1): create
//! dormant with an immutable conversation mapping, edit the schedule in place,
//! and preview upcoming runs. Enabling stays the explicit durable-owner step.
use super::authority::store_clock;
use super::import::timer_source_digest;
use super::policy::PolicyUpdate;
use super::{calendar, schedule, *};

pub const CALENDAR_SOURCE: &str = "orkestr:calendar";
const PREVIEW_MAX: usize = 20;

#[derive(Clone, Debug)]
pub struct CalendarTimerCreate {
    pub namespace: Uuid,
    pub conversation_id: ConversationId,
    pub label: String,
    /// `Calendar` or `Event` only.
    pub schedule: TimerSchedule,
    pub policy: PolicyUpdate,
}

fn native_schedule(schedule: &TimerSchedule) -> bool {
    matches!(schedule, TimerSchedule::Calendar(_) | TimerSchedule::Event)
}

fn import_request(namespace: Uuid, schedule: &TimerSchedule) -> TimerImportRequest {
    TimerImportRequest {
        namespace,
        source_namespace: CALENDAR_SOURCE.into(),
        source_timer_id: namespace.to_string(),
        source_enabled: false,
        schedule: schedule.clone(),
    }
}

/// Upcoming runs after `from_ms`, validating the schedule first.
pub fn preview_schedule(schedule: &TimerSchedule, from_ms: i64, count: usize) -> Result<Vec<i64>> {
    if !native_schedule(schedule) || count == 0 || count > PREVIEW_MAX {
        return Err(HistoryError::Invalid);
    }
    schedule::encode(schedule)?;
    match schedule {
        TimerSchedule::Calendar(rule) => calendar::upcoming(rule, from_ms, count),
        _ => Ok(Vec::new()),
    }
}

impl Store {
    /// Create (or replay) a dormant calendar/event timer mapped to a conversation,
    /// with its initial policy. Nothing runs until it is enabled.
    pub async fn create_calendar_timer(
        &self,
        credential: &str,
        owner: &OwnerId,
        request: &CalendarTimerCreate,
    ) -> Result<TimerReceipt> {
        if request.namespace.is_nil() || !native_schedule(&request.schedule) {
            return Err(HistoryError::Invalid);
        }
        let receipt = self
            .import_dormant_timer_for(
                credential,
                owner,
                &import_request(request.namespace, &request.schedule),
                &TimerTarget {
                    conversation_id: request.conversation_id.clone(),
                    label: request.label.clone(),
                    source_thread_id: "orkestr:calendar".into(),
                },
            )
            .await?;
        // The initial policy applies once; a replay keeps whatever it became since.
        if self
            .timer_policy(credential, owner, request.namespace)
            .await?
            .revision
            == 0
        {
            let update = request.policy.clone();
            self.set_timer_policy(credential, owner, request.namespace, 0, &update)
                .await?;
        }
        Ok(receipt)
    }

    /// Edit the schedule of a natively created timer (not an imported V1 one).
    pub async fn update_calendar_schedule(
        &self,
        credential: &str,
        owner: &OwnerId,
        namespace: Uuid,
        expected_revision: i64,
        new: &TimerSchedule,
    ) -> Result<TimerReceipt> {
        if !native_schedule(new) {
            return Err(HistoryError::Invalid);
        }
        let encoded = schedule::encode(new)?;
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let now_ms = store_clock(&mut tx).await?;
        let current = row(&mut tx, owner, namespace).await?;
        let state = TimerState::parse(current.get("state"))?;
        if current.get::<String, _>("source_namespace") != CALENDAR_SOURCE
            || current.get::<i64, _>("revision") != expected_revision
            || matches!(state, TimerState::Stopped | TimerState::RolledBack)
        {
            return Err(HistoryError::Conflict);
        }
        if current.get::<String, _>("schedule_json") == encoded {
            let result = receipt(&current)?;
            tx.commit().await.map_err(unavailable)?;
            return Ok(result);
        }
        let digest = timer_source_digest(&import_request(namespace, new))?;
        let revision = revision(expected_revision)?;
        let next = if state == TimerState::Enabled {
            let fired = policy_pause::last_fired(&mut tx, owner, namespace).await?;
            let natural = schedule::next_for_after(new, namespace, now_ms, fired)?;
            let conversation: String = current.get("conversation_id");
            Some(
                policy_pause::adjust_next(
                    &mut tx,
                    owner,
                    namespace,
                    new,
                    &conversation,
                    fired,
                    natural,
                )
                .await?,
            )
        } else {
            None
        };
        sqlx::query("UPDATE dormant_timers SET schedule_json=?,source_digest=?,revision=?,next_due_ms=COALESCE(?,next_due_ms) WHERE owner_id=? AND namespace=?")
            .bind(&encoded).bind(&digest).bind(revision).bind(next)
            .bind(owner.to_string()).bind(namespace.to_string())
            .execute(&mut *tx).await.map_err(unavailable)?;
        let result = receipt(&row(&mut tx, owner, namespace).await?)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
}
