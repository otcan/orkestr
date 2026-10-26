//! Next-occurrence arithmetic for calendar rules, in the bundled tz database.
//!
//! A local time skipped by a forward transition resolves to the instant after
//! the gap and a repeated local time resolves to its first instant (jiff
//! "compatible" disambiguation, the same rule as `zoned_clock`). Occurrences are
//! always computed strictly after a given instant, normally the previous claim,
//! so a repeated hour can never fire twice and downtime coalesces to one run.
use super::{zoned, CalendarRule, HistoryError, Result};
use jiff::{civil, Timestamp, ToSpan};

const SCAN_DAYS: i64 = 16;

/// First occurrence strictly after `now_ms`.
pub(super) fn next(rule: &CalendarRule, now_ms: i64) -> Result<i64> {
    let invalid = |_| HistoryError::Invalid;
    let tz = zoned::zone(&rule.timezone).ok_or(HistoryError::Invalid)?;
    let times = rule.day_minutes();
    if times.is_empty() {
        return Err(HistoryError::Invalid);
    }
    let now = Timestamp::from_millisecond(now_ms).map_err(invalid)?;
    // Start one local day back so an offset near midnight can never be missed.
    let first = now
        .to_zoned(tz.clone())
        .date()
        .checked_add(1.day().negate())
        .map_err(invalid)?;
    let mut best: Option<i64> = None;
    let mut extra = 0;
    for offset in 0..=SCAN_DAYS {
        let date = first.checked_add(offset.days()).map_err(invalid)?;
        if rule.runs_on(date.weekday().to_monday_one_offset() as u8) {
            for minute in &times {
                let time = civil::Time::new((minute / 60) as i8, (minute % 60) as i8, 0, 0)
                    .map_err(invalid)?;
                let instant = date
                    .to_datetime(time)
                    .to_zoned(tz.clone())
                    .map_err(invalid)?
                    .timestamp()
                    .as_millisecond();
                if instant > now_ms && best.is_none_or(|b| instant < b) {
                    best = Some(instant);
                }
            }
        }
        if best.is_some() {
            // One more day covers a gap that pushes a late time across midnight.
            extra += 1;
            if extra > 1 {
                break;
            }
        }
    }
    best.ok_or(HistoryError::Invalid)
}

/// Local minute of the day (0..1440) of an instant in a zone.
pub(super) fn local_minute_of_day(zone_name: &str, ms: i64) -> Option<u16> {
    let tz = zoned::zone(zone_name)?;
    let at = Timestamp::from_millisecond(ms).ok()?.to_zoned(tz);
    u16::try_from(i32::from(at.hour()) * 60 + i32::from(at.minute())).ok()
}

/// Local calendar date (`YYYY-MM-DD`) of an instant in a zone, for skip dates.
pub(super) fn local_date(zone_name: &str, ms: i64) -> Option<String> {
    let tz = zoned::zone(zone_name)?;
    let ts = Timestamp::from_millisecond(ms).ok()?;
    Some(ts.to_zoned(tz).date().to_string())
}

/// "Wed 21 Oct 14:00 CEST": an instant in a zone, for display only.
pub fn local_time_label(zone_name: &str, ms: i64) -> Option<String> {
    const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let tz = zoned::zone(zone_name)?;
    let ts = Timestamp::from_millisecond(ms).ok()?;
    let at = ts.to_zoned(tz.clone());
    let abbreviation = tz.to_offset_info(ts).abbreviation().to_owned();
    Some(format!(
        "{} {} {} {:02}:{:02} {}",
        DAYS[usize::try_from(at.weekday().to_monday_zero_offset()).ok()?],
        at.day(),
        MONTHS[usize::try_from(at.month() - 1).ok()?],
        at.hour(),
        at.minute(),
        abbreviation
    ))
}

pub(super) fn valid_date(text: &str) -> bool {
    text.len() == 10
        && text
            .parse::<civil::Date>()
            .is_ok_and(|d| d.to_string() == text)
}

/// Latest of the given local minutes-of-day that is at or before `now_ms`.
pub(super) fn latest_slot(zone_name: &str, minutes: &[u16], now_ms: i64) -> Option<i64> {
    let tz = zoned::zone(zone_name)?;
    let today = Timestamp::from_millisecond(now_ms)
        .ok()?
        .to_zoned(tz.clone())
        .date();
    let mut best: Option<i64> = None;
    for back in 0..=2 {
        let date = today.checked_sub(i64::from(back).days()).ok()?;
        for minute in minutes {
            let time = civil::Time::new((minute / 60) as i8, (minute % 60) as i8, 0, 0).ok()?;
            let instant = date
                .to_datetime(time)
                .to_zoned(tz.clone())
                .ok()?
                .timestamp()
                .as_millisecond();
            if instant <= now_ms && best.is_none_or(|b| instant > b) {
                best = Some(instant);
            }
        }
    }
    best
}

/// `HH:MM` (and `MM-DD` when not the same local day as `reference_ms`) in a zone.
pub(super) fn local_label(zone_name: &str, ms: i64, reference_ms: i64) -> String {
    let (Some(tz), Ok(ts), Ok(reference)) = (
        zoned::zone(zone_name),
        Timestamp::from_millisecond(ms),
        Timestamp::from_millisecond(reference_ms),
    ) else {
        return String::new();
    };
    let at = ts.to_zoned(tz.clone());
    let clock = format!("{:02}:{:02}", at.hour(), at.minute());
    if at.date() == reference.to_zoned(tz).date() {
        clock
    } else {
        format!("{:02}-{:02} {clock}", at.month(), at.day())
    }
}

/// The next `count` occurrences after `from_ms`, for previews and tests.
pub(super) fn upcoming(rule: &CalendarRule, from_ms: i64, count: usize) -> Result<Vec<i64>> {
    let mut out = Vec::with_capacity(count);
    let mut at = from_ms;
    for _ in 0..count {
        at = next(rule, at)?;
        out.push(at);
    }
    Ok(out)
}

#[cfg(test)]
#[path = "calendar_tests.rs"]
mod tests;
