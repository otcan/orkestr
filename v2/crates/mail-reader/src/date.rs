//! RFC 2822 `Date` header to Unix milliseconds (lenient: optional weekday,
//! optional seconds, numeric or named zones, two-digit years).

pub fn parse_rfc2822_ms(value: &str) -> Option<i64> {
    let value = value.split('(').next()?.trim();
    let value = match value.split_once(',') {
        Some((_, rest)) => rest,
        None => value,
    };
    let mut parts = value.split_whitespace();
    let day: i64 = parts.next()?.parse().ok()?;
    let month = month(parts.next()?)?;
    let mut year: i64 = parts.next()?.parse().ok()?;
    if year < 50 {
        year += 2000;
    } else if year < 1000 {
        year += 1900;
    }
    let time = parts.next()?;
    let mut hms = time.split(':');
    let hour: i64 = hms.next()?.parse().ok()?;
    let minute: i64 = hms.next()?.parse().ok()?;
    let second: i64 = hms.next().map_or(Some(0), |s| s.parse().ok())?;
    let offset = zone(parts.next().unwrap_or("+0000"))?;
    if !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset;
    Some(seconds * 1000)
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
        _ => return Some(0),
    };
    if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let hours: i64 = digits[..2].parse().ok()?;
    let minutes: i64 = digits[2..].parse().ok()?;
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
        assert_eq!(parse_rfc2822_ms("Tue, 20 Oct 2026 09:00:00 +0000"), Some(base));
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
}
