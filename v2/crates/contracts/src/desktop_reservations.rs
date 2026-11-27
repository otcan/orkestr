//! Desk reservations: who may act on a desk between its single-step leases.
//!
//! A desktop lease lasts one tool step. A reservation keeps a desk for one
//! chat across its steps, for the owner while a chat has handed it over, and
//! away from other chats while the owner views it:
//!
//! - `task`: a chat's multi-step work. Every acquire of the chat (and every
//!   heartbeat that extends its lease) makes or extends its task to
//!   [`DESK_TASK_GRACE_MS`] past the lease's expiry. `reserve` keeps it longer
//!   (at most [`DESK_RESERVE_MAX_MS`]), `unreserve` ends it. Other chats are
//!   refused (`desk_busy`).
//! - `owner_handoff`: a chat handed the desk to the owner, for example with a
//!   sign-in link. No chat takes the desk, the handing chat included
//!   (`desk_handed_to_owner`), until that chat's `handback` (the desk then
//!   stays its task for the grace) or the end time. It does not end when the
//!   owner disconnects: the owner may come back.
//! - `owner_viewer`: the owner opened a viewing link to the desk. Until the
//!   link expires only the chat holding the desk's task keeps working (the
//!   owner usually watches that chat); every other chat is refused.
//!
//! A desk has at most one claim (`task` or `owner_handoff`) and at most one
//! `owner_viewer` window. Expiry is a timestamp: nothing has to end an old
//! reservation. A refusal names the holder (kind, chat name, until), never
//! another chat's conversation id, and up to [`DESK_FREE_DESKS_MAX`] free
//! desks.
use crate::ConversationId;
use serde::{Deserialize, Serialize};

pub const DESK_TASK_GRACE_MS: i64 = 10 * 60_000;
pub const DESK_RESERVE_DEFAULT_MS: i64 = 30 * 60_000;
pub const DESK_RESERVE_MAX_MS: i64 = 120 * 60_000;
pub const DESK_HANDOFF_DEFAULT_MS: i64 = 30 * 60_000;
pub const DESK_HANDOFF_MAX_MS: i64 = 120 * 60_000;
/// An owner link whose expiry V1 did not state lasts V1's default lifetime.
pub const DESK_VIEWER_DEFAULT_MS: i64 = 60 * 60_000;
pub const DESK_VIEWER_MAX_MS: i64 = 120 * 60_000;
pub const DESK_FREE_DESKS_MAX: usize = 3;
/// Desks a client may name as preferred free-desk candidates.
pub const DESK_CANDIDATES_MAX: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopReservationKind {
    Task,
    OwnerHandoff,
    OwnerViewer,
}
impl DesktopReservationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Task => "task",
            Self::OwnerHandoff => "owner_handoff",
            Self::OwnerViewer => "owner_viewer",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "task" => Some(Self::Task),
            "owner_handoff" => Some(Self::OwnerHandoff),
            "owner_viewer" => Some(Self::OwnerViewer),
            _ => None,
        }
    }
}

/// A reservation as the caller sees it. A chat never sees another chat's
/// conversation id; only the owner's inventory carries `conversation_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopReservationView {
    pub desk: String,
    pub kind: DesktopReservationKind,
    /// The holding chat's name; `None` for `owner_viewer`.
    pub chat: Option<String>,
    /// Held by the calling chat.
    pub mine: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<ConversationId>,
    pub since_ms: i64,
    pub until_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeskVerdict {
    Allowed,
    DeskBusy,
    DeskHandedToOwner,
}
impl DeskVerdict {
    pub fn code(self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::DeskBusy => "desk_busy",
            Self::DeskHandedToOwner => "desk_handed_to_owner",
        }
    }
}

/// May the calling chat take the desk's lease now? `claim` and `viewer` are
/// as that chat sees them (`mine`). Returns the verdict and what refuses it.
pub fn desk_verdict(
    claim: Option<&DesktopReservationView>,
    viewer: Option<&DesktopReservationView>,
) -> (DeskVerdict, Option<DesktopReservationView>) {
    match claim {
        Some(c) if c.mine && c.kind == DesktopReservationKind::OwnerHandoff => {
            return (DeskVerdict::DeskHandedToOwner, Some(c.clone()))
        }
        Some(c) if !c.mine => return (DeskVerdict::DeskBusy, Some(c.clone())),
        _ => {}
    }
    // The chat holding the desk's task keeps working while the owner watches.
    let holder = claim.is_some_and(|c| c.mine && c.kind == DesktopReservationKind::Task);
    match viewer {
        Some(v) if !holder => (DeskVerdict::DeskBusy, Some(v.clone())),
        _ => (DeskVerdict::Allowed, None),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopReservationOp {
    Reserve,
    Unreserve,
    Handoff,
    Handback,
}

/// A chat's change of its own reservation. `minutes` for `reserve` (default
/// 30) and `handoff` (default 30), at most 120; `until_ms` only for a
/// `handoff` that ends with a link (capped at the handoff maximum).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopReservationRequest {
    pub op: DesktopReservationOp,
    #[serde(default)]
    pub minutes: Option<i64>,
    #[serde(default)]
    pub until_ms: Option<i64>,
}
impl DesktopReservationRequest {
    pub fn is_valid(&self) -> bool {
        let minutes = |max_ms: i64| {
            self.minutes
                .is_none_or(|m| m >= 1 && m.saturating_mul(60_000) <= max_ms)
        };
        match self.op {
            DesktopReservationOp::Reserve => {
                self.until_ms.is_none() && minutes(DESK_RESERVE_MAX_MS)
            }
            DesktopReservationOp::Handoff => {
                !(self.minutes.is_some() && self.until_ms.is_some())
                    && minutes(DESK_HANDOFF_MAX_MS)
                    && self.until_ms.is_none_or(|u| u > 0)
            }
            DesktopReservationOp::Unreserve | DesktopReservationOp::Handback => {
                self.minutes.is_none() && self.until_ms.is_none()
            }
        }
    }
}

/// What a change does to the desk's claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimChange {
    Keep,
    Remove,
    Write {
        kind: DesktopReservationKind,
        since_ms: i64,
        until_ms: i64,
    },
}

/// The claim after `request` by the calling chat at `now`, or the refusal's
/// code. `claim` and `viewer` are as that chat sees them.
pub fn reservation_change(
    request: &DesktopReservationRequest,
    claim: Option<&DesktopReservationView>,
    viewer: Option<&DesktopReservationView>,
    now: i64,
) -> Result<ClaimChange, &'static str> {
    let mine = claim.filter(|c| c.mine);
    let other = claim.is_some() && mine.is_none();
    let ms = |default: i64| request.minutes.map_or(default, |m| m * 60_000);
    match request.op {
        DesktopReservationOp::Reserve => {
            if other {
                return Err("desk_busy");
            }
            if mine.is_some_and(|c| c.kind == DesktopReservationKind::OwnerHandoff) {
                return Err("desk_handed_to_owner");
            }
            // While the owner views the desk only the chat holding its task
            // may keep it; a reservation is no way around that.
            if viewer.is_some() && mine.is_none() {
                return Err("desk_busy");
            }
            Ok(ClaimChange::Write {
                kind: DesktopReservationKind::Task,
                since_ms: mine.map_or(now, |c| c.since_ms),
                until_ms: (now + ms(DESK_RESERVE_DEFAULT_MS)).max(mine.map_or(0, |c| c.until_ms)),
            })
        }
        DesktopReservationOp::Handoff => {
            if other {
                return Err("desk_busy");
            }
            let until = match request.until_ms {
                Some(until) => until.min(now + DESK_HANDOFF_MAX_MS),
                None => now + ms(DESK_HANDOFF_DEFAULT_MS),
            };
            if until <= now {
                return Err("reservation_until_invalid");
            }
            Ok(ClaimChange::Write {
                kind: DesktopReservationKind::OwnerHandoff,
                since_ms: now,
                until_ms: until,
            })
        }
        DesktopReservationOp::Handback => match mine {
            Some(c) if c.kind == DesktopReservationKind::OwnerHandoff => Ok(ClaimChange::Write {
                kind: DesktopReservationKind::Task,
                since_ms: now,
                until_ms: now + DESK_TASK_GRACE_MS,
            }),
            _ => Err("no_handoff_of_this_chat"),
        },
        DesktopReservationOp::Unreserve => match claim {
            None => Ok(ClaimChange::Keep),
            Some(_) if other => Err("reservation_of_another_chat"),
            Some(_) => Ok(ClaimChange::Remove),
        },
    }
}

/// The calling chat's task after a step whose lease ends at `lease_end_ms`
/// (`since_ms`, `until_ms`), or `None` to leave the claim as it is (another
/// chat's claim, or the chat's own handoff).
pub fn touched_task(
    claim: Option<&DesktopReservationView>,
    now: i64,
    lease_end_ms: i64,
) -> Option<(i64, i64)> {
    let until = lease_end_ms.max(now) + DESK_TASK_GRACE_MS;
    match claim {
        None => Some((now, until)),
        Some(c) if c.mine && c.kind == DesktopReservationKind::Task => {
            Some((c.since_ms, until.max(c.until_ms)))
        }
        Some(_) => None,
    }
}

/// The desk as the calling chat sees it (`GET …/reservation`, and the result
/// of a change).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopReservationState {
    pub schema_version: u32,
    pub desk: String,
    /// Whether the calling chat may take the desk's lease now.
    pub verdict: DeskVerdict,
    /// What refuses it.
    pub holder: Option<DesktopReservationView>,
    /// The desk's claim: a chat's task or a handoff to the owner.
    pub reservation: Option<DesktopReservationView>,
    /// The owner's viewing window.
    pub owner_viewer: Option<DesktopReservationView>,
    /// Desks the chat may use instead; filled when refused or asked for.
    #[serde(default)]
    pub free_desks: Vec<String>,
}

/// Every reservation of the owner that still holds, as the caller sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopReservationList {
    pub schema_version: u32,
    pub reservations: Vec<DesktopReservationView>,
}

/// UTC `YYYY-MM-DDTHH:MM:SSZ` for refusal texts.
pub fn desk_time(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// The refusal's text for the calling chat: what holds the desk, until when,
/// that nothing was done, and where to go instead.
pub fn desk_refusal_hint(
    verdict: DeskVerdict,
    holder: &DesktopReservationView,
    free_desks: &[String],
) -> String {
    let (desk, until) = (&holder.desk, desk_time(holder.until_ms));
    let chat = holder.chat.as_deref().unwrap_or("another chat");
    let text = match (verdict, holder.kind) {
        (DeskVerdict::DeskHandedToOwner, _) => format!(
            "You handed {desk} to the owner until {until}; nothing was done. No chat acts on it meanwhile, you neither. When the owner says they are done, run handback (then continue here), or wait for the time to end."
        ),
        (_, DesktopReservationKind::OwnerHandoff) => format!(
            "The owner is using {desk} (handed over by {chat}) until {until}; nothing was done. Use a free desk."
        ),
        (_, DesktopReservationKind::OwnerViewer) => format!(
            "The owner is viewing {desk} until {until} and no task of your chat holds it; nothing was done. Use a free desk, or wait."
        ),
        (_, DesktopReservationKind::Task) => format!(
            "{desk} is reserved for another chat's task ({chat}) until {until}; nothing was done. Use a free desk, or wait."
        ),
    };
    if !free_desks.is_empty() {
        format!("{text} Free now: {}.", free_desks.join(", "))
    } else if verdict == DeskVerdict::DeskBusy {
        format!("{text} No other desk is free right now.")
    } else {
        text
    }
}

#[cfg(test)]
#[path = "desktop_reservations_tests.rs"]
mod tests;
