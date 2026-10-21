//! IANA wall-clock schedule arithmetic. Rules come from the bundled tz database,
//! never host tzdata or the process TZ, so every host computes the same instants.
use super::{HistoryError, Result};
use jiff::{civil, tz::TimeZone, Timestamp, ToSpan};

pub(super) fn zone(name: &str) -> Option<TimeZone> {
    // Only canonical-looking area names; no POSIX strings, paths or offsets.
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b))
        || name.starts_with('/')
        || name.contains("..")
    {
        return None;
    }
    TimeZone::get(name).ok()
}

pub(super) fn valid_zone(name: &str) -> bool {
    zone(name).is_some()
}

/// First wall-clock occurrence strictly after `now_ms`.
///
/// A local time skipped by a forward transition resolves to the instant after
/// the gap (02:30 becomes 03:30). A repeated local time resolves to its first
/// instant; because the next occurrence is always computed from the time of the
/// previous claim, the repeated hour can never fire twice.
pub(super) fn next(
    name: &str,
    weekday: Option<u8>,
    minute_of_day: u16,
    now_ms: i64,
) -> Result<i64> {
    let invalid = |_| HistoryError::Invalid;
    let tz = zone(name).ok_or(HistoryError::Invalid)?;
    if minute_of_day >= 1440 || weekday.is_some_and(|day| !(1..=7).contains(&day)) {
        return Err(HistoryError::Invalid);
    }
    let now = Timestamp::from_millisecond(now_ms).map_err(invalid)?;
    let today = now.to_zoned(tz.clone()).date();
    let time = civil::Time::new(
        i8::try_from(minute_of_day / 60).map_err(|_| HistoryError::Invalid)?,
        i8::try_from(minute_of_day % 60).map_err(|_| HistoryError::Invalid)?,
        0,
        0,
    )
    .map_err(invalid)?;
    // Eight local days always include the next matching weekday after today.
    for offset in 0..=8_i64 {
        let date = today.checked_add(offset.days()).map_err(invalid)?;
        if weekday.is_some_and(|day| {
            i8::try_from(day).ok() != Some(date.weekday().to_monday_one_offset())
        }) {
            continue;
        }
        let instant = date
            .to_datetime(time)
            .to_zoned(tz.clone())
            .map_err(invalid)?
            .timestamp()
            .as_millisecond();
        if instant > now_ms {
            return Ok(instant);
        }
    }
    Err(HistoryError::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(text: &str) -> i64 {
        text.parse::<Timestamp>().unwrap().as_millisecond()
    }
    fn iso(ms: i64) -> String {
        Timestamp::from_millisecond(ms).unwrap().to_string()
    }

    #[test]
    fn daily_local_time_follows_daylight_saving_changes() {
        // 09:00 Berlin is 07:00Z in summer and 08:00Z in winter.
        let before = next("Europe/Berlin", None, 540, ms("2026-10-24T08:00:00Z")).unwrap();
        assert_eq!(iso(before), "2026-10-25T08:00:00Z");
        let summer = next("Europe/Berlin", None, 540, ms("2026-10-24T06:00:00Z")).unwrap();
        assert_eq!(iso(summer), "2026-10-24T07:00:00Z");
        let spring = next("Europe/Berlin", None, 540, ms("2026-03-28T09:00:00Z")).unwrap();
        assert_eq!(iso(spring), "2026-03-29T07:00:00Z");
    }

    #[test]
    fn skipped_hour_resolves_forward_once() {
        // 2026-03-29 02:30 does not exist in Berlin; it runs at 03:30 CEST (01:30Z).
        let gap = next("Europe/Berlin", None, 150, ms("2026-03-28T02:00:00Z")).unwrap();
        assert_eq!(iso(gap), "2026-03-29T01:30:00Z");
        let after = next("Europe/Berlin", None, 150, gap).unwrap();
        assert_eq!(iso(after), "2026-03-30T00:30:00Z");
    }

    #[test]
    fn repeated_hour_fires_exactly_once() {
        // 2026-10-25 02:30 happens twice in Berlin (00:30Z and 01:30Z).
        let first = next("Europe/Berlin", None, 150, ms("2026-10-24T12:00:00Z")).unwrap();
        assert_eq!(iso(first), "2026-10-25T00:30:00Z");
        // Claimed at the first instant, or late during the repeated hour: next day.
        for claimed in [
            first,
            ms("2026-10-25T01:30:00Z"),
            ms("2026-10-25T01:45:00Z"),
        ] {
            assert_eq!(
                iso(next("Europe/Berlin", None, 150, claimed).unwrap()),
                "2026-10-26T01:30:00Z"
            );
        }
    }

    #[test]
    fn weekly_selects_weekday_and_coalesces_missed_weeks() {
        // 2026-10-20 is a Tuesday. Friday (5) 20:05 Berlin.
        let due = next("Europe/Berlin", Some(5), 1205, ms("2026-10-20T10:00:00Z")).unwrap();
        assert_eq!(iso(due), "2026-10-23T18:05:00Z");
        // Three missed weeks still produce exactly one next occurrence.
        let late = next("Europe/Berlin", Some(5), 1205, ms("2026-11-14T00:00:00Z")).unwrap();
        assert_eq!(iso(late), "2026-11-20T19:05:00Z");
        // Same weekday, time already passed today: one week later.
        let same = next("Europe/Berlin", Some(2), 540, ms("2026-10-20T10:00:00Z")).unwrap();
        assert_eq!(iso(same), "2026-10-27T08:00:00Z");
    }

    #[test]
    fn zones_are_bundled_and_strict() {
        assert!(valid_zone("Europe/Istanbul"));
        assert!(valid_zone("UTC"));
        for bad in [
            "",
            "Mars/Olympus",
            "../etc/passwd",
            "/usr/share/zoneinfo/UTC",
            "CET-1CEST,M3.5.0,M10.5.0/3",
        ] {
            assert!(!valid_zone(bad), "{bad}");
        }
        assert!(next("Europe/Berlin", Some(8), 0, 0).is_err());
        assert!(next("Europe/Berlin", None, 1440, 0).is_err());
    }
}
