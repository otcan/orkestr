//! Pauses and skip dates: which occurrences may not run, and moving a timer's
//! next occurrence past them when a pause or policy changes.
use super::authority::store_clock;
use super::policy::{read_in, write_in, TimerPolicy, FOREVER_MS};
use super::{calendar, schedule, *};

/// Which occurrences may not run: before the pause end or on a skipped local date.
pub(super) struct Suppression {
    pub until: i64,
    pub(super) skip: Vec<String>,
    pub(super) zone: String,
}
impl Suppression {
    pub fn blocks(&self, due_ms: i64) -> bool {
        due_ms < self.until
            || (!self.skip.is_empty()
                && calendar::local_date(&self.zone, due_ms).is_some_and(|d| self.skip.contains(&d)))
    }
}

pub(super) async fn conversation_until(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &str,
) -> Result<Option<i64>> {
    sqlx::query_scalar(
        "SELECT pause_until_ms FROM conversation_timer_pauses WHERE owner_id=? AND conversation_id=?",
    )
    .bind(owner.to_string())
    .bind(conversation)
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)
}

pub(super) async fn load(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
    schedule: &TimerSchedule,
    conversation: Option<&str>,
) -> Result<Suppression> {
    let policy = read_in(tx, owner, namespace).await?;
    let mut until = policy.pause_until_ms.unwrap_or(0);
    if let Some(conversation) = conversation {
        until = until.max(
            conversation_until(tx, owner, conversation)
                .await?
                .unwrap_or(0),
        );
    }
    let zone = match schedule {
        TimerSchedule::Calendar(rule) => rule.timezone.clone(),
        TimerSchedule::ZonedClock { timezone, .. } => timezone.clone(),
        _ => policy.skip_timezone.clone().unwrap_or_else(|| "UTC".into()),
    };
    Ok(Suppression {
        until,
        skip: policy.skip_dates,
        zone,
    })
}

/// Move a candidate occurrence past pauses and skip dates. An indefinite pause is
/// left to the scheduler's candidate filter; `resume` recomputes from "now".
pub(super) fn first_allowed(
    supp: &Suppression,
    schedule: &TimerSchedule,
    spread: i64,
    fired: Option<i64>,
    candidate: i64,
) -> i64 {
    let mut due = candidate;
    if supp.until >= FOREVER_MS {
        return due;
    }
    for _ in 0..2000 {
        if !supp.blocks(due) {
            return due;
        }
        let from = if due < supp.until {
            supp.until - 1
        } else {
            due
        };
        match schedule::next_spread_after(schedule, spread, from, fired) {
            Ok(next) => due = next,
            Err(_) => return due,
        }
    }
    due
}

pub(super) async fn adjust_next(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
    schedule: &TimerSchedule,
    conversation: &str,
    fired: Option<i64>,
    candidate: i64,
) -> Result<i64> {
    let supp = load(tx, owner, namespace, schedule, Some(conversation)).await?;
    Ok(first_allowed(
        &supp,
        schedule,
        schedule::spread_ms(namespace),
        fired,
        candidate,
    ))
}

/// Floor of the next occurrence: the later of the `due_ms` of the latest clock
/// occurrence claimed for this timer and the time it was last enabled
/// (`enable_floor_ms`), if any. Trigger-event claims (`event:` keys) are not
/// clock slots and are ignored. The enable time matters for a timer handed off
/// from V1: it has no V2 claims, and V1 may have just fired the slot at its raw
/// time, so a slot that started before the enable must not come back at its
/// spread time.
pub(super) async fn last_fired(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
) -> Result<Option<i64>> {
    sqlx::query_scalar("SELECT max(floor) FROM (SELECT max(due_ms) AS floor FROM dormant_timer_claims WHERE owner_id=?1 AND namespace=?2 AND request_key NOT LIKE 'event:%' UNION ALL SELECT enable_floor_ms FROM dormant_timers WHERE owner_id=?1 AND namespace=?2)")
        .bind(owner.to_string())
        .bind(namespace.to_string())
        .fetch_one(&mut **tx)
        .await
        .map_err(unavailable)
}

/// Recompute one enabled timer's next occurrence after a policy or pause change.
///
/// `was_paused`: a pause was in force until now. A run that came due while paused
/// is dropped when the pause is edited or lifted, so resuming never replays it.
pub(super) async fn refresh_one(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    row: &SqliteRow,
    now_ms: i64,
    was_paused: bool,
) -> Result<()> {
    let (Some(conversation), Some(current)) = (
        row.get::<Option<String>, _>("conversation_id"),
        row.get::<Option<i64>, _>("next_due_ms"),
    ) else {
        return Ok(());
    };
    if row.get::<&str, _>("state") != "enabled" {
        return Ok(());
    }
    let namespace = Uuid::parse_str(row.get("namespace")).map_err(unavailable)?;
    let schedule = schedule::decode(row.get("schedule_json"))?;
    let fired = last_fired(tx, owner, namespace).await?;
    let Ok(natural) = schedule::next_for_after(&schedule, namespace, now_ms, fired) else {
        return Ok(());
    };
    let supp = load(tx, owner, namespace, &schedule, Some(&conversation)).await?;
    let allowed = first_allowed(
        &supp,
        &schedule,
        schedule::spread_ms(namespace),
        fired,
        natural,
    );
    if supp.blocks(current) || current > allowed || (was_paused && current <= now_ms) {
        sqlx::query("UPDATE dormant_timers SET next_due_ms=? WHERE owner_id=? AND namespace=? AND state='enabled'")
            .bind(allowed)
            .bind(owner.to_string())
            .bind(namespace.to_string())
            .execute(&mut **tx)
            .await
            .map_err(unavailable)?;
    }
    Ok(())
}

pub(super) async fn refresh_timer(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
    now_ms: i64,
    was_paused: bool,
) -> Result<()> {
    let current = row(tx, owner, namespace).await?;
    refresh_one(tx, owner, &current, now_ms, was_paused).await
}

pub(super) async fn refresh_conversation(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &str,
    now_ms: i64,
    was_paused: bool,
) -> Result<()> {
    let rows = sqlx::query(
        "SELECT * FROM dormant_timers WHERE owner_id=? AND conversation_id=? AND state='enabled'",
    )
    .bind(owner.to_string())
    .bind(conversation)
    .fetch_all(&mut **tx)
    .await
    .map_err(unavailable)?;
    for current in rows {
        refresh_one(tx, owner, &current, now_ms, was_paused).await?;
    }
    Ok(())
}

impl Store {
    /// Pause one timer until an instant (`None` resumes). Does not need a revision.
    pub async fn pause_timer(
        &self,
        credential: &str,
        owner: &OwnerId,
        namespace: Uuid,
        until_ms: Option<i64>,
    ) -> Result<TimerPolicy> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let now_ms = store_clock(&mut tx).await?;
        let policy = write_in(&mut tx, owner, namespace, None, now_ms, |u, _| {
            u.pause_until_ms = until_ms
        })
        .await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(policy)
    }

    /// Pause every timer of a conversation until an instant (`None` resumes).
    pub async fn pause_conversation_timers(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        until_ms: Option<i64>,
    ) -> Result<Option<i64>> {
        if until_ms.is_some_and(|v| !(0..=FOREVER_MS).contains(&v)) {
            return Err(HistoryError::Invalid);
        }
        let mut tx = self.history_transaction(credential, owner, true).await?;
        target(&mut tx, owner, conversation).await?;
        let now_ms = store_clock(&mut tx).await?;
        let id = conversation.to_string();
        let was_paused = conversation_until(&mut tx, owner, &id)
            .await?
            .is_some_and(|u| u > now_ms);
        match until_ms {
            Some(until) if until > now_ms => {
                sqlx::query("INSERT INTO conversation_timer_pauses(owner_id,conversation_id,pause_until_ms,updated_ms) VALUES(?,?,?,?) ON CONFLICT(owner_id,conversation_id) DO UPDATE SET pause_until_ms=excluded.pause_until_ms,updated_ms=excluded.updated_ms")
                    .bind(owner.to_string()).bind(&id).bind(until).bind(now_ms)
                    .execute(&mut *tx).await.map_err(unavailable)?;
            }
            // A pause in the past is a resume.
            _ => {
                sqlx::query(
                    "DELETE FROM conversation_timer_pauses WHERE owner_id=? AND conversation_id=?",
                )
                .bind(owner.to_string())
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
            }
        }
        refresh_conversation(&mut tx, owner, &id, now_ms, was_paused).await?;
        let current = conversation_until(&mut tx, owner, &id).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(current)
    }

    /// Active conversation-wide pause end, if any (expired pauses read as none).
    pub async fn conversation_timer_pause(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<Option<i64>> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        target(&mut tx, owner, conversation).await?;
        let now_ms = store_clock(&mut tx).await?;
        let until = conversation_until(&mut tx, owner, &conversation.to_string()).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(until.filter(|u| *u > now_ms))
    }
}
