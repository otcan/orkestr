//! Per-timer policy and per-conversation pause: silent mode, pause-until, skip
//! dates, digest times and event triggers. A policy never grants execution
//! authority and never changes a timer's revision or generation; it only decides
//! whether a due occurrence may run and what happens to its result.
use super::authority::store_clock;
use super::policy_pause::refresh_timer;
use super::{calendar, schedule, zoned, *};
use serde::{Deserialize, Serialize};

pub const FOREVER_MS: i64 = schedule::EVENT_HORIZON_MS;
const MAX_SKIP_DATES: usize = 400;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SilentMode {
    #[default]
    Off,
    /// `NO_REPLY` and "no news" results send nothing; low-signal ones go to the digest.
    UnlessChanged,
}
impl SilentMode {
    fn text(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::UnlessChanged => "unless_changed",
        }
    }
    fn parse(value: &str) -> Result<Self> {
        match value {
            "off" => Ok(Self::Off),
            "unless_changed" => Ok(Self::UnlessChanged),
            _ => Err(HistoryError::Unavailable),
        }
    }
}

/// One digest message at each local time of day, summarising quiet runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DigestConfig {
    pub timezone: String,
    pub minutes: Vec<u16>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerSource {
    Message,
    Email,
    Other,
}
impl TriggerSource {
    pub(super) fn text(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Email => "email",
            Self::Other => "other",
        }
    }
}

/// Run on inbound events instead of (or as well as) the clock. Events inside
/// `min_interval_s` of the previous trigger run are coalesced into it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriggerConfig {
    pub sources: Vec<TriggerSource>,
    #[serde(default)]
    pub min_interval_s: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TimerPolicy {
    /// 0 until the first write.
    pub revision: i64,
    pub silent_mode: SilentMode,
    pub pause_until_ms: Option<i64>,
    pub skip_dates: Vec<String>,
    pub skip_timezone: Option<String>,
    pub digest: Option<DigestConfig>,
    pub digest_since_ms: Option<i64>,
    pub trigger: Option<TriggerConfig>,
    pub updated_ms: i64,
}
impl Default for TimerPolicy {
    fn default() -> Self {
        Self {
            revision: 0,
            silent_mode: SilentMode::Off,
            pause_until_ms: None,
            skip_dates: Vec::new(),
            skip_timezone: None,
            digest: None,
            digest_since_ms: None,
            trigger: None,
            updated_ms: 0,
        }
    }
}

/// Owner-editable fields; a full replace guarded by `expected_revision`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyUpdate {
    #[serde(default)]
    pub silent_mode: SilentMode,
    #[serde(default)]
    pub pause_until_ms: Option<i64>,
    #[serde(default)]
    pub skip_dates: Vec<String>,
    #[serde(default)]
    pub skip_timezone: Option<String>,
    #[serde(default)]
    pub digest: Option<DigestConfig>,
    #[serde(default)]
    pub trigger: Option<TriggerConfig>,
}

fn validate(update: &mut PolicyUpdate) -> Result<()> {
    if update
        .pause_until_ms
        .is_some_and(|v| !(0..=FOREVER_MS).contains(&v))
        || update.skip_dates.len() > MAX_SKIP_DATES
        || !update.skip_dates.iter().all(|d| calendar::valid_date(d))
        || update
            .skip_timezone
            .as_ref()
            .is_some_and(|z| !zoned::valid_zone(z))
    {
        return Err(HistoryError::Invalid);
    }
    update.skip_dates.sort_unstable();
    update.skip_dates.dedup();
    if let Some(digest) = &mut update.digest {
        digest.minutes.sort_unstable();
        digest.minutes.dedup();
        if digest.minutes.is_empty()
            || digest.minutes.len() > 24
            || digest.minutes.iter().any(|m| *m >= 1440)
            || !zoned::valid_zone(&digest.timezone)
        {
            return Err(HistoryError::Invalid);
        }
    }
    if let Some(trigger) = &mut update.trigger {
        trigger.sources.sort_by_key(|s| s.text());
        trigger.sources.dedup();
        if trigger.sources.is_empty() || trigger.min_interval_s > 86_400 {
            return Err(HistoryError::Invalid);
        }
    }
    Ok(())
}

fn from_row(row: &SqliteRow) -> Result<TimerPolicy> {
    let json = |column: &str| -> Option<String> { row.get(column) };
    Ok(TimerPolicy {
        revision: row.get("revision"),
        silent_mode: SilentMode::parse(row.get("silent_mode"))?,
        pause_until_ms: row.get("pause_until_ms"),
        skip_dates: serde_json::from_str(row.get("skip_dates_json")).map_err(unavailable)?,
        skip_timezone: row.get("skip_timezone"),
        digest: json("digest_json")
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(unavailable)?,
        digest_since_ms: row.get("digest_since_ms"),
        trigger: json("trigger_json")
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(unavailable)?,
        updated_ms: row.get("updated_ms"),
    })
}

pub(super) async fn read_in(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
) -> Result<TimerPolicy> {
    let row = sqlx::query("SELECT * FROM timer_policies WHERE owner_id=? AND namespace=?")
        .bind(owner.to_string())
        .bind(namespace.to_string())
        .fetch_optional(&mut **tx)
        .await
        .map_err(unavailable)?;
    row.map_or_else(|| Ok(TimerPolicy::default()), |r| from_row(&r))
}

/// The zone a timer's times are shown in: its schedule's, else the policy's.
pub fn display_zone(schedule: &TimerSchedule, policy: &TimerPolicy) -> String {
    match schedule {
        TimerSchedule::Calendar(rule) => rule.timezone.clone(),
        TimerSchedule::ZonedClock { timezone, .. } => timezone.clone(),
        _ => policy
            .skip_timezone
            .clone()
            .or_else(|| policy.digest.as_ref().map(|d| d.timezone.clone()))
            .unwrap_or_else(|| "UTC".into()),
    }
}

/// Insert or replace the policy row under optimistic concurrency.
pub(super) async fn write_in(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    namespace: Uuid,
    expected: Option<i64>,
    now_ms: i64,
    change: impl FnOnce(&mut PolicyUpdate, &TimerPolicy),
) -> Result<TimerPolicy> {
    row(tx, owner, namespace).await?;
    let old = read_in(tx, owner, namespace).await?;
    if expected.is_some_and(|e| e != old.revision) {
        return Err(HistoryError::Conflict);
    }
    let mut update = PolicyUpdate {
        silent_mode: old.silent_mode,
        pause_until_ms: old.pause_until_ms,
        skip_dates: old.skip_dates.clone(),
        skip_timezone: old.skip_timezone.clone(),
        digest: old.digest.clone(),
        trigger: old.trigger.clone(),
    };
    change(&mut update, &old);
    validate(&mut update)?;
    // A new or changed digest only covers runs from now on.
    let digest_since = match (&update.digest, &old.digest) {
        (None, _) => None,
        (Some(new), Some(prev)) if new == prev => old.digest_since_ms,
        _ => Some(now_ms),
    };
    let revision = old.revision.checked_add(1).ok_or(HistoryError::Conflict)?;
    let encode = |v: &Option<String>| v.clone();
    let digest_json = update
        .digest
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(unavailable)?;
    let trigger_json = update
        .trigger
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(unavailable)?;
    sqlx::query("INSERT INTO timer_policies(owner_id,namespace,revision,silent_mode,pause_until_ms,skip_dates_json,skip_timezone,digest_json,digest_since_ms,trigger_json,updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,namespace) DO UPDATE SET revision=excluded.revision,silent_mode=excluded.silent_mode,pause_until_ms=excluded.pause_until_ms,skip_dates_json=excluded.skip_dates_json,skip_timezone=excluded.skip_timezone,digest_json=excluded.digest_json,digest_since_ms=excluded.digest_since_ms,trigger_json=excluded.trigger_json,updated_ms=excluded.updated_ms")
        .bind(owner.to_string())
        .bind(namespace.to_string())
        .bind(revision)
        .bind(update.silent_mode.text())
        .bind(update.pause_until_ms)
        .bind(serde_json::to_string(&update.skip_dates).map_err(unavailable)?)
        .bind(&update.skip_timezone)
        .bind(encode(&digest_json))
        .bind(digest_since)
        .bind(encode(&trigger_json))
        .bind(now_ms)
        .execute(&mut **tx)
        .await
        .map_err(unavailable)?;
    let was_paused = old.pause_until_ms.is_some_and(|u| u > now_ms);
    refresh_timer(tx, owner, namespace, now_ms, was_paused).await?;
    read_in(tx, owner, namespace).await
}

impl Store {
    pub async fn timer_policy(
        &self,
        credential: &str,
        owner: &OwnerId,
        namespace: Uuid,
    ) -> Result<TimerPolicy> {
        let mut tx = self.history_transaction(credential, owner, false).await?;
        row(&mut tx, owner, namespace).await?;
        let policy = read_in(&mut tx, owner, namespace).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(policy)
    }

    /// Replace the policy (silent mode, pause, skip dates, digest, trigger).
    pub async fn set_timer_policy(
        &self,
        credential: &str,
        owner: &OwnerId,
        namespace: Uuid,
        expected_revision: i64,
        update: &PolicyUpdate,
    ) -> Result<TimerPolicy> {
        let mut tx = self.history_transaction(credential, owner, true).await?;
        let now_ms = store_clock(&mut tx).await?;
        let new = update.clone();
        let policy = write_in(
            &mut tx,
            owner,
            namespace,
            Some(expected_revision),
            now_ms,
            |u, _| *u = new,
        )
        .await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(policy)
    }
}
#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
