use super::*;
use serde_json::{json, Value};
const DAY: i64 = 86_400_000;
/// An event-triggered timer is never due by the clock.
pub(super) const EVENT_HORIZON_MS: i64 = 4_102_444_800_000;
// Bounded schedule horizon; arithmetic cannot wrap or silently create catch-up.
pub(super) fn clock(now_ms: i64) -> Result<()> {
    if !(0..=4_102_444_800_000).contains(&now_ms) {
        return Err(HistoryError::Invalid);
    }
    Ok(())
}
pub(super) fn encode(schedule: &TimerSchedule) -> Result<String> {
    let value = match schedule {
        TimerSchedule::Once { due_ms } => {
            clock(*due_ms)?;
            json!(["once", due_ms])
        }
        TimerSchedule::Interval { every_ms } => {
            if *every_ms < 60_000 || *every_ms > 366 * DAY || every_ms % 60_000 != 0 {
                return Err(HistoryError::Invalid);
            }
            json!(["interval", every_ms])
        }
        TimerSchedule::UtcClock {
            weekly,
            minute_of_day,
        } => {
            if *minute_of_day >= 1440 {
                return Err(HistoryError::Invalid);
            }
            json!(["utc_clock", weekly, minute_of_day])
        }
        TimerSchedule::ZonedClock {
            timezone,
            weekday,
            minute_of_day,
        } => {
            if *minute_of_day >= 1440
                || weekday.is_some_and(|day| !(1..=7).contains(&day))
                || !zoned::valid_zone(timezone)
            {
                return Err(HistoryError::Invalid);
            }
            json!(["zoned_clock", timezone, weekday, minute_of_day])
        }
        TimerSchedule::Calendar(rule) => {
            let normal = rule
                .clone()
                .normalized()
                .map_err(|_| HistoryError::Invalid)?;
            if &normal != rule || !zoned::valid_zone(&rule.timezone) {
                return Err(HistoryError::Invalid);
            }
            json!([
                "calendar",
                rule.timezone,
                rule.weekdays,
                rule.start_minute,
                rule.end_minute,
                rule.every_hours,
                rule.minutes
            ])
        }
        TimerSchedule::Event => json!(["event"]),
        TimerSchedule::Dormant {
            cadence,
            timezone,
            time,
            every,
            run_at,
            reason,
        } => {
            if !valid(cadence, 80)
                || [timezone, time, every, run_at]
                    .iter()
                    .any(|s| s.as_ref().is_some_and(|v| !valid(v, 128)))
            {
                return Err(HistoryError::Invalid);
            }
            json!([
                "dormant",
                cadence,
                timezone,
                time,
                every,
                run_at,
                reason_text(*reason)
            ])
        }
    };
    Ok(value.to_string())
}
pub(super) fn reason_text(reason: DormantTimerReason) -> &'static str {
    match reason {
        DormantTimerReason::MissingTimezone => "missing_timezone",
        DormantTimerReason::UnsupportedTimezone => "unsupported_timezone",
        DormantTimerReason::AmbiguousCadence => "ambiguous_cadence",
        DormantTimerReason::UncertainEffects => "uncertain_effects",
    }
}
pub(super) fn reason(schedule: &TimerSchedule) -> Option<String> {
    if let TimerSchedule::Dormant { reason, .. } = schedule {
        Some(reason_text(*reason).into())
    } else {
        None
    }
}
pub(super) fn decode(encoded: &str) -> Result<TimerSchedule> {
    let value: Value = serde_json::from_str(encoded).map_err(unavailable)?;
    let array = value.as_array().ok_or(HistoryError::Unavailable)?;
    let invalid = || HistoryError::Unavailable;
    let optional = |index: usize| -> Result<Option<String>> {
        if array[index].is_null() {
            Ok(None)
        } else {
            Ok(Some(array[index].as_str().ok_or_else(invalid)?.into()))
        }
    };
    let schedule = match array.first().and_then(Value::as_str) {
        Some("event") if array.len() == 1 => TimerSchedule::Event,
        Some("calendar") if array.len() == 7 => TimerSchedule::Calendar(CalendarRule {
            timezone: array[1].as_str().ok_or_else(invalid)?.into(),
            weekdays: serde_json::from_value(array[2].clone()).map_err(unavailable)?,
            start_minute: u16::try_from(array[3].as_u64().ok_or_else(invalid)?)
                .map_err(unavailable)?,
            end_minute: u16::try_from(array[4].as_u64().ok_or_else(invalid)?)
                .map_err(unavailable)?,
            every_hours: u8::try_from(array[5].as_u64().ok_or_else(invalid)?)
                .map_err(unavailable)?,
            minutes: serde_json::from_value(array[6].clone()).map_err(unavailable)?,
        }),
        Some("once") if array.len() == 2 => TimerSchedule::Once {
            due_ms: array[1].as_i64().ok_or_else(invalid)?,
        },
        Some("interval") if array.len() == 2 => TimerSchedule::Interval {
            every_ms: array[1].as_i64().ok_or_else(invalid)?,
        },
        Some("utc_clock") if array.len() == 3 => TimerSchedule::UtcClock {
            weekly: array[1].as_bool().ok_or_else(invalid)?,
            minute_of_day: u16::try_from(array[2].as_u64().ok_or_else(invalid)?)
                .map_err(unavailable)?,
        },
        Some("zoned_clock") if array.len() == 4 => TimerSchedule::ZonedClock {
            timezone: array[1].as_str().ok_or_else(invalid)?.into(),
            weekday: if array[2].is_null() {
                None
            } else {
                Some(u8::try_from(array[2].as_u64().ok_or_else(invalid)?).map_err(unavailable)?)
            },
            minute_of_day: u16::try_from(array[3].as_u64().ok_or_else(invalid)?)
                .map_err(unavailable)?,
        },
        Some("dormant") if array.len() == 7 => TimerSchedule::Dormant {
            cadence: array[1].as_str().ok_or_else(invalid)?.into(),
            timezone: optional(2)?,
            time: optional(3)?,
            every: optional(4)?,
            run_at: optional(5)?,
            reason: match array[6].as_str() {
                Some("missing_timezone") => DormantTimerReason::MissingTimezone,
                Some("unsupported_timezone") => DormantTimerReason::UnsupportedTimezone,
                Some("ambiguous_cadence") => DormantTimerReason::AmbiguousCadence,
                Some("uncertain_effects") => DormantTimerReason::UncertainEffects,
                _ => return Err(invalid()),
            },
        },
        _ => return Err(invalid()),
    };
    if encode(&schedule)? != encoded {
        return Err(invalid());
    }
    Ok(schedule)
}
pub(super) fn next(schedule: &TimerSchedule, now_ms: i64) -> Result<i64> {
    clock(now_ms)?;
    let due = match schedule {
        TimerSchedule::Once { due_ms } if *due_ms > now_ms => *due_ms,
        TimerSchedule::Interval { every_ms } => {
            now_ms.checked_add(*every_ms).ok_or(HistoryError::Invalid)?
        }
        TimerSchedule::UtcClock {
            weekly,
            minute_of_day,
        } => {
            let today = now_ms / DAY * DAY + i64::from(*minute_of_day) * 60_000;
            if today > now_ms {
                today
            } else {
                today + if *weekly { 7 * DAY } else { DAY }
            }
        }
        TimerSchedule::ZonedClock {
            timezone,
            weekday,
            minute_of_day,
        } => zoned::next(timezone, *weekday, *minute_of_day, now_ms)?,
        TimerSchedule::Calendar(rule) => calendar::next(rule, now_ms)?,
        TimerSchedule::Event => EVENT_HORIZON_MS,
        _ => return Err(HistoryError::Conflict),
    };
    clock(due)?;
    Ok(due)
}

/// Largest deterministic delay given to a top-of-the-hour occurrence.
pub const SPREAD_MAX_MS: i64 = 8 * 60_000;

/// Stable per-timer delay in whole seconds, `0..=SPREAD_MAX_MS`. Derived only
/// from the timer namespace, so every host and every recomputation agree.
pub fn spread_ms(namespace: Uuid) -> i64 {
    let hash = Sha256::digest(format!("orkestr.timer.spread.v1:{namespace}").as_bytes());
    let mut first = [0_u8; 8];
    first.copy_from_slice(&hash[..8]);
    let seconds = u64::from_be_bytes(first) % (SPREAD_MAX_MS as u64 / 1000 + 1);
    seconds as i64 * 1000
}

/// Spread applied to one natural occurrence. Only wall-clock schedules that fire
/// on the hour are spread, so many timers created as "every hour" or "at 13:00"
/// do not all call the provider in the same minute. Minute-specific schedules
/// (13:05, :30), intervals, one-shot and event timers stay exact, and a calendar
/// occurrence whose spread would leave the rule's hour window stays exact too.
fn occurrence_spread(schedule: &TimerSchedule, spread: i64, natural: i64) -> i64 {
    match schedule {
        TimerSchedule::UtcClock { minute_of_day, .. }
        | TimerSchedule::ZonedClock { minute_of_day, .. }
            if minute_of_day % 60 == 0 =>
        {
            spread
        }
        TimerSchedule::Calendar(rule) if rule.minutes == [0] => {
            match calendar::local_minute_of_day(&rule.timezone, natural) {
                Some(minute)
                    if minute % 60 == 0
                        && i64::from(minute) * 60_000 + spread
                            <= i64::from(rule.end_minute) * 60_000 =>
                {
                    spread
                }
                _ => 0,
            }
        }
        _ => 0,
    }
}

/// First occurrence of this timer strictly after `now_ms`, including its
/// deterministic top-of-the-hour spread. Every write of `next_due_ms` uses this,
/// so claims, enables, edits and pause refreshes agree on the same instant.
pub(super) fn next_for(schedule: &TimerSchedule, namespace: Uuid, now_ms: i64) -> Result<i64> {
    next_spread(schedule, spread_ms(namespace), now_ms)
}

/// `next_for` with an explicit spread (`0` is the natural schedule).
pub(super) fn next_spread(schedule: &TimerSchedule, spread: i64, now_ms: i64) -> Result<i64> {
    if spread == 0 || !occurrence_spread_possible(schedule) {
        return next(schedule, now_ms);
    }
    // A natural occurrence in (now - spread, now] may still be due after now.
    let mut from = now_ms.saturating_sub(spread).max(0);
    for _ in 0..4 {
        let natural = next(schedule, from)?;
        let due = natural + occurrence_spread(schedule, spread, natural);
        if due > now_ms {
            clock(due)?;
            return Ok(due);
        }
        from = natural;
    }
    next(schedule, now_ms)
}

fn occurrence_spread_possible(schedule: &TimerSchedule) -> bool {
    match schedule {
        TimerSchedule::UtcClock { minute_of_day, .. }
        | TimerSchedule::ZonedClock { minute_of_day, .. } => minute_of_day % 60 == 0,
        TimerSchedule::Calendar(rule) => rule.minutes == [0],
        _ => false,
    }
}
