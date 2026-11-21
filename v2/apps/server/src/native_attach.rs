//! Native-attach holds (`orkestr attach`): while the owner works in a
//! conversation's native provider session from a terminal, V2 never resumes
//! that session in parallel.
//!
//! Root writes `<dir>/<conversation id>.json` by atomic rename while the
//! terminal is attached and renews it; Core only reads and never removes. A
//! hold is active while its record is valid and `now < min(expires_at_ms,
//! renewed_at_ms + 5 min)`, so a terminal that died stops holding within
//! minutes. Custody as for release interruptions (ORK-792): a root-owned
//! directory and record, neither group nor world writable, one link, at most
//! 4096 bytes. An invalid or foreign record is ignored (one static line, never
//! its content). While a hold is active, window admission and dispatch only
//! queue (no open, no join), an open window takes no further Deep input and
//! closes, and provider handoff and native reset are refused. The queued work
//! runs on the same native session after release or expiry. The optional
//! `<dir>/<conversation id>.ended.json` describes the last attach; the first
//! Deep run after it gets a one-line internal note. No other name in the
//! directory is ever read. Off unless the sealed configuration names
//! `native_attach_dir`; a server without this module ignores the directory.
use orkestr_v2_contracts::ConversationId;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicI64, Ordering},
};
use uuid::Uuid;

const REFUSED: &str = "native attach custody refused";
const HOLD_FORMAT: &str = "orkestr-native-attach-hold-v1";
const ENDED_FORMAT: &str = "orkestr-native-attach-ended-v1";
/// A hold lapses this long after its last renewal, whatever it states.
pub(crate) const RENEWAL_GRACE_MS: i64 = 5 * 60 * 1000;
/// How far a writer's clock may lead this process's clock.
const CLOCK_SKEW_MS: i64 = 60 * 1000;
/// At most one line of each kind (ignored record, too old, backlog) per this
/// interval.
const WARNING_INTERVAL_MS: i64 = 60 * 1000;
/// A hold acquired longer ago than this is ignored, however often renewed: a
/// forgotten or stuck terminal never holds a conversation indefinitely.
pub(crate) const MAX_HOLD_AGE_MS: i64 = 8 * 60 * 60 * 1000;
/// More queued window intents than this for one held conversation raise an
/// operator alert: they count toward the owner-wide queue cap (256).
pub(crate) const HELD_QUEUE_ALERT: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Provider {
    Claude,
    Codex,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct HoldRecord {
    format: String,
    conversation_id: ConversationId,
    /// The Deep `session_bindings.id` the terminal resumed.
    session_id: Uuid,
    native_session_id: Uuid,
    provider: Provider,
    binding_generation: u64,
    holder_pid: u32,
    acquired_at_ms: i64,
    renewed_at_ms: i64,
    expires_at_ms: i64,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct EndedRecord {
    format: String,
    conversation_id: ConversationId,
    native_session_id: Uuid,
    started_at_ms: i64,
    ended_at_ms: i64,
    reason: String,
}

/// An active hold, as stated by its record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Hold {
    pub session_id: Uuid,
    pub native_session_id: Uuid,
    pub provider: Provider,
    pub acquired_at_ms: i64,
    /// When the hold lapses unless renewed: min(expiry, renewal + grace).
    pub expires_at_ms: i64,
}

/// The last attach of a conversation that ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Ended {
    pub native_session_id: Uuid,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
}

pub(crate) struct NativeAttachHolds {
    dir: PathBuf,
    owner_uid: u32,
    warned_at_ms: AtomicI64,
    aged_at_ms: AtomicI64,
    backlog_at_ms: AtomicI64,
}

impl NativeAttachHolds {
    pub(crate) fn bind(dir: &Path, home: &Path) -> Result<Self, &'static str> {
        Self::bind_owned(dir, home, 0)
    }

    pub(crate) fn bind_owned(
        dir: &Path,
        home: &Path,
        owner_uid: u32,
    ) -> Result<Self, &'static str> {
        if !crate::beta_config::conversation_workspace_path(dir) || dir.starts_with(home) {
            return Err(REFUSED);
        }
        crate::release_interruption::protected_directory(dir, owner_uid).map_err(|_| REFUSED)?;
        Ok(Self {
            dir: dir.to_owned(),
            owner_uid,
            warned_at_ms: AtomicI64::new(i64::MIN),
            aged_at_ms: AtomicI64::new(i64::MIN),
            backlog_at_ms: AtomicI64::new(i64::MIN),
        })
    }

    /// Whether the owner holds this conversation's native session now.
    pub(crate) fn held(&self, conversation: &ConversationId, now_ms: i64) -> bool {
        self.active(conversation, now_ms).is_some()
    }

    /// The active hold of this conversation, or None (V2 may resume it).
    pub(crate) fn active(&self, conversation: &ConversationId, now_ms: i64) -> Option<Hold> {
        let raw = self.read(conversation, "json", now_ms)?;
        let Ok(record) = serde_json::from_slice::<HoldRecord>(&raw) else {
            self.ignored(conversation, "hold_invalid", now_ms);
            return None;
        };
        let valid = record.format == HOLD_FORMAT
            && &record.conversation_id == conversation
            && !record.session_id.is_nil()
            && !record.native_session_id.is_nil()
            && record.binding_generation > 0
            && record.holder_pid > 0
            && record.acquired_at_ms > 0
            && record.acquired_at_ms <= record.renewed_at_ms
            && record.renewed_at_ms < record.expires_at_ms
            && record.renewed_at_ms <= now_ms.saturating_add(CLOCK_SKEW_MS);
        if !valid {
            self.ignored(conversation, "hold_invalid", now_ms);
            return None;
        }
        if now_ms.saturating_sub(record.acquired_at_ms) >= MAX_HOLD_AGE_MS {
            if due(&self.aged_at_ms, now_ms) {
                eprintln!(
                    "WARN orkestr-v2-server native_attach_hold_too_old conversation={conversation} max_age_ms={MAX_HOLD_AGE_MS}"
                );
            }
            return None;
        }
        let lapses = record
            .expires_at_ms
            .min(record.renewed_at_ms.saturating_add(RENEWAL_GRACE_MS));
        // An expired hold is a terminal that stopped renewing: not an error.
        (now_ms < lapses).then_some(Hold {
            session_id: record.session_id,
            native_session_id: record.native_session_id,
            provider: record.provider,
            acquired_at_ms: record.acquired_at_ms,
            expires_at_ms: lapses,
        })
    }

    /// The conversation's last ended attach, or None.
    pub(crate) fn ended(&self, conversation: &ConversationId, now_ms: i64) -> Option<Ended> {
        let raw = self.read(conversation, "ended.json", now_ms)?;
        let record = serde_json::from_slice::<EndedRecord>(&raw)
            .ok()
            .filter(|record| {
                record.format == ENDED_FORMAT
                    && &record.conversation_id == conversation
                    && !record.native_session_id.is_nil()
                    && record.started_at_ms > 0
                    && record.started_at_ms <= record.ended_at_ms
                    && record.ended_at_ms <= now_ms.saturating_add(CLOCK_SKEW_MS)
                    && (1..=64).contains(&record.reason.len())
            });
        let Some(record) = record else {
            self.ignored(conversation, "ended_invalid", now_ms);
            return None;
        };
        Some(Ended {
            native_session_id: record.native_session_id,
            started_at_ms: record.started_at_ms,
            ended_at_ms: record.ended_at_ms,
        })
    }

    /// `<dir>/<conversation id>.<suffix>` under Root custody; None when absent
    /// or refused.
    fn read(&self, conversation: &ConversationId, suffix: &str, now_ms: i64) -> Option<Vec<u8>> {
        let name = format!("{}.{suffix}", conversation.0);
        match crate::release_interruption::read_root_record(&self.dir, self.owner_uid, &name) {
            Ok(raw) => raw,
            Err(_) => {
                self.ignored(conversation, "custody_refused", now_ms);
                None
            }
        }
    }

    /// Identifiers and a closed cause only, at most once per interval.
    fn ignored(&self, conversation: &ConversationId, cause: &str, now_ms: i64) {
        if due(&self.warned_at_ms, now_ms) {
            eprintln!(
                "WARN orkestr-v2-server native_attach_record_ignored conversation={conversation} cause={cause}"
            );
        }
    }

    /// The operator alert for a held conversation with more than
    /// `HELD_QUEUE_ALERT` queued window intents, at most once per interval.
    pub(crate) fn backlog_alert(
        &self,
        conversation: &ConversationId,
        queued: usize,
        now_ms: i64,
    ) -> Option<String> {
        (queued > HELD_QUEUE_ALERT && due(&self.backlog_at_ms, now_ms)).then(|| {
            format!(
                "ALERT orkestr-v2-server native_attach_queue_backlog conversation={conversation} queued={queued} alert_above={HELD_QUEUE_ALERT}"
            )
        })
    }
}

/// Whether a rate-limited line is due now (and claim it).
fn due(last_at_ms: &AtomicI64, now_ms: i64) -> bool {
    let last = last_at_ms.load(Ordering::Acquire);
    now_ms.saturating_sub(last) >= WARNING_INTERVAL_MS
        && last_at_ms
            .compare_exchange(last, now_ms, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
}

/// The internal note for the first Deep run after `ended`; provider input
/// only, never the owner's message text.
pub(crate) fn note(ended: &Ended) -> String {
    format!(
        "[Orkestr: the owner worked directly in this native session from the terminal, {}–{} UTC (orkestr attach). Their messages there are earlier in this session.]",
        utc_minute(ended.started_at_ms),
        utc_minute(ended.ended_at_ms)
    )
}

/// `YYYY-MM-DD HH:MM` in UTC (proleptic Gregorian, days from civil).
fn utc_minute(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let (days, second) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}",
        second / 3600,
        second % 3600 / 60
    )
}

#[cfg(all(test, target_os = "linux"))]
#[path = "native_attach_fixture.rs"]
pub(crate) mod fixture;

#[cfg(all(test, target_os = "linux"))]
#[path = "native_attach_tests.rs"]
mod tests;
