//! RFC 2822 `Date` header to Unix milliseconds (lenient: optional weekday,
//! optional seconds, numeric or named zones, two-digit years).

pub fn parse_rfc2822_ms(value: &str) -> Option<i64> {
    let value = value.split('(').next()?.trim();
    let value = match value.split_once(',') {
        Some((_, rest)) => rest,
        None => value,
    };
    let mut parts = value.split_whitespace();
    let day = decimal(parts.next()?, 2)?;
    let month = month(parts.next()?)?;
    let year_text = parts.next()?;
    let mut year = decimal(year_text, 19)?;
    if year_text.len() == 2 && year < 50 {
        year += 2000;
    } else if matches!(year_text.len(), 2 | 3) {
        year += 1900;
    }
    if !(1900..=i64::MAX / 366).contains(&year) {
        return None;
    }
    let time = parts.next()?;
    let mut hms = time.split(':');
    let hour = decimal(hms.next()?, 2)?;
    let minute = decimal(hms.next()?, 2)?;
    let second = hms.next().map_or(Some(0), |s| decimal(s, 2))?;
    let offset = zone(parts.next().unwrap_or("+0000"))?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=month_days[(month - 1) as usize]).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
        || hms.next().is_some()
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    days.checked_mul(86_400)?
        .checked_add(hour * 3600 + minute * 60 + second)?
        .checked_sub(offset)?
        .checked_mul(1000)
}

fn decimal(value: &str, max_digits: usize) -> Option<i64> {
    (!value.is_empty() && value.len() <= max_digits && value.bytes().all(|b| b.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}

fn month(name: &str) -> Option<i64> {
    let name = name.get(..3)?.to_ascii_lowercase();
    let index = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ]
    .iter()
    .position(|m| *m == name)?;
    Some(index as i64 + 1)
}

/// Zone offset in seconds east of UTC.
fn zone(value: &str) -> Option<i64> {
    let named = match value.to_ascii_uppercase().as_str() {
        "UT" | "UTC" | "GMT" | "Z" => Some(0),
        "EST" => Some(-5),
        "EDT" => Some(-4),
        "CST" => Some(-6),
        "CDT" => Some(-5),
        "MST" => Some(-7),
        "MDT" => Some(-6),
        "PST" => Some(-8),
        "PDT" => Some(-7),
        _ => None,
    };
    if let Some(hours) = named {
        return Some(hours * 3600);
    }
    let (sign, digits) = match value.as_bytes().first()? {
        b'+' => (1, &value[1..]),
        b'-' => (-1, &value[1..]),
        _ => {
            return (value.len() == 1
                && value.as_bytes()[0].is_ascii_alphabetic()
                && !value.eq_ignore_ascii_case("j"))
            .then_some(0)
        }
    };
    if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let hours: i64 = digits[..2].parse().ok()?;
    let minutes: i64 = digits[2..].parse().ok()?;
    if minutes > 59 {
        return None;
    }
    Some(sign * (hours * 3600 + minutes * 60))
}

/// Days since 1970-01-01 (proleptic Gregorian; Howard Hinnant's algorithm).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_shapes() {
        // 2026-10-20T09:00:00Z
        let base = 1_792_486_800_000;
        assert_eq!(
            parse_rfc2822_ms("Tue, 20 Oct 2026 09:00:00 +0000"),
            Some(base)
        );
        assert_eq!(parse_rfc2822_ms("20 Oct 2026 11:00:00 +0200"), Some(base));
        assert_eq!(parse_rfc2822_ms("Tue, 20 Oct 2026 09:00 GMT"), Some(base));
        assert_eq!(parse_rfc2822_ms("Tue, 20 Oct 26 04:00:00 EST"), Some(base));
        assert_eq!(
            parse_rfc2822_ms("Tue, 20 Oct 2026 09:00:00 +0000 (UTC)"),
            Some(base)
        );
        assert_eq!(parse_rfc2822_ms("1 Jan 1970 00:00:00 +0000"), Some(0));
        assert_eq!(parse_rfc2822_ms("not a date"), None);
        assert_eq!(parse_rfc2822_ms("32 Oct 2026 09:00:00 +0000"), None);
    }

    #[test]
    fn malformed_calendar_dates_and_huge_years_are_not_timestamps() {
        for date in [
            "31 Apr 2026 09:00:00 +0000",
            "29 Feb 2026 09:00:00 +0000",
            "20 Oct 2026 -1:00:00 +0000",
            "20 Oct 2026 09:-1:00 +0000",
            "20 Oct 2026 09:00:-1 +0000",
            "20 Oct 2026 09:00:00:00 +0000",
            "20 Oct 2026 09:00:00 +0060",
            "20 Oct 2026 09:00:00 INVALID",
            "20 Oct -1 09:00:00 +0000",
            "20 Oct 0049 09:00:00 +0000",
            "20 Oct 9223372036854775807 09:00:00 +0000",
            "20 Oct 999999999 09:00:00 +0000",
        ] {
            assert_eq!(parse_rfc2822_ms(date), None, "{date}");
        }
        assert!(parse_rfc2822_ms("29 Feb 2024 09:00:00 +0000").is_some());
    }
}
