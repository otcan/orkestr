use super::*;
use serde_json::{json, Value};
const DAY: i64 = 86_400_000;
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
        _ => return Err(HistoryError::Conflict),
    };
    clock(due)?;
    Ok(due)
}
