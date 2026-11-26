//! Message times in Europe/Berlin (CET/CEST, EU summer time rules) and the
//! labels of recorded delivery receipts. Pure; the browser clock comes in as
//! `now_ms`.
use orkestr_v2_contracts::{MessageReceipt, MessageReceiptKind};

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}
/// Unix day of the last Sunday of `month`.
fn last_sunday(year: i64, month: i64) -> i64 {
    let next = if month == 12 {
        days_from_civil(year + 1, 1, 1)
    } else {
        days_from_civil(year, month + 1, 1)
    };
    let last = next - 1;
    // 1970-01-01 was a Thursday; Sunday is index 3 in WEEKDAYS.
    last - (last - 3).rem_euclid(7)
}

/// Berlin's UTC offset in minutes at `utc_ms`: +120 from the last Sunday of
/// March 01:00 UTC until the last Sunday of October 01:00 UTC, else +60.
pub fn berlin_offset_minutes(utc_ms: i64) -> i64 {
    let (year, _, _) = civil(utc_ms.div_euclid(86_400_000));
    let start = last_sunday(year, 3) * 86_400_000 + 3_600_000;
    let end = last_sunday(year, 10) * 86_400_000 + 3_600_000;
    if (start..end).contains(&utc_ms) {
        120
    } else {
        60
    }
}

struct Local {
    year: i64,
    month: i64,
    day: i64,
    days: i64,
    hour: i64,
    minute: i64,
    second: i64,
    summer: bool,
}
fn local(utc_ms: i64) -> Local {
    let offset = berlin_offset_minutes(utc_ms);
    let ms = utc_ms + offset * 60_000;
    let days = ms.div_euclid(86_400_000);
    let (year, month, day) = civil(days);
    let secs = ms.rem_euclid(86_400_000) / 1000;
    Local {
        year,
        month,
        day,
        days,
        hour: secs / 3600,
        minute: secs / 60 % 60,
        second: secs % 60,
        summer: offset == 120,
    }
}

/// `16:42` today (Berlin), `21 Oct, 16:42` this year, `21 Oct 2025, 16:42` before.
pub fn short(at_ms: i64, now_ms: i64) -> String {
    let at = local(at_ms);
    let now = local(now_ms);
    let clock = format!("{:02}:{:02}", at.hour, at.minute);
    if at.days == now.days {
        clock
    } else if at.year == now.year {
        format!("{} {}, {clock}", at.day, MONTHS[(at.month - 1) as usize])
    } else {
        format!(
            "{} {} {}, {clock}",
            at.day,
            MONTHS[(at.month - 1) as usize],
            at.year
        )
    }
}

/// `Tue 21 Oct 2026, 16:42:05 CEST`.
pub fn full(at_ms: i64) -> String {
    let at = local(at_ms);
    format!(
        "{} {} {} {}, {:02}:{:02}:{:02} {}",
        WEEKDAYS[at.days.rem_euclid(7) as usize],
        at.day,
        MONTHS[(at.month - 1) as usize],
        at.year,
        at.hour,
        at.minute,
        at.second,
        if at.summer { "CEST" } else { "CET" }
    )
}

/// RFC 3339 (`2026-10-21T14:42:05.123Z`, `+02:00`) to Unix ms.
pub fn parse(value: &str) -> Option<i64> {
    let b = value.as_bytes();
    if b.len() < 19
        || !value.is_ascii()
        || b[4] != b'-'
        || b[7] != b'-'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let num = |r: std::ops::Range<usize>| value.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (
        num(0..4)?,
        num(5..7)?,
        num(8..10)?,
        num(11..13)?,
        num(14..16)?,
        num(17..19)?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let mut rest = &value[19..];
    let mut millis = 0;
    if let Some(f) = rest.strip_prefix('.') {
        let digits = f.bytes().take_while(u8::is_ascii_digit).count();
        millis = format!("{:0<3}", &f[..digits.min(3)]).parse().ok()?;
        rest = &f[digits..];
    }
    let offset = match rest {
        "Z" | "z" | "" => 0,
        _ if rest.len() == 6 => {
            let sign = if rest.starts_with('-') { -1 } else { 1 };
            sign * (rest[1..3].parse::<i64>().ok()? * 60 + rest[4..6].parse::<i64>().ok()?)
        }
        _ => return None,
    };
    Some(
        (days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s - offset * 60) * 1000 + millis,
    )
}

/// Tick shown next to the time, and the receipt line in the details.
pub fn receipt_mark(receipts: &[MessageReceipt]) -> &'static str {
    use MessageReceiptKind as K;
    if receipts.iter().any(|r| r.kind == K::Failed) {
        "!"
    } else if receipts.iter().any(|r| {
        matches!(
            r.kind,
            K::SentToWhatsapp | K::DeliveredInApp | K::HandedToV1
        )
    }) {
        "✓"
    } else {
        ""
    }
}

pub fn receipt_label(receipt: &MessageReceipt) -> &'static str {
    use MessageReceiptKind as K;
    match receipt.kind {
        K::SentToWhatsapp => "✓ Sent to WhatsApp",
        K::DeliveredInApp => "✓ Delivered in the app",
        K::HandedToV1 => "✓ Handed to V1",
        K::SuppressedByV1 => "Not sent (no reply)",
        K::Pending => "Waiting to send",
        K::Failed => "! Delivery failed",
    }
}

/// The sequence the chat reads message times after: just before the oldest
/// row on screen, or `None` while no row is shown yet. Reading from 0 before
/// the rows arrive fetched the times of a long chat's oldest messages (five
/// pages, sequences 1 to about 5,500 of 9,300) and left the shown owner
/// messages without a time until the next refresh 15 s later.
pub fn times_after(oldest_shown: Option<i64>) -> Option<i64> {
    oldest_shown.map(|sequence| (sequence - 1).max(0))
}

/// Every this many reads of a chat's message times reads the whole window
/// again (a receipt recorded late for an older row); the reads in between
/// start at the last page, where new messages and their receipts land.
pub const TIMES_FULL_EVERY: u32 = 8;

/// Where the next read of message times starts. `start`: just before the
/// oldest row on screen; `read_from`: where the last whole-window read
/// started; `tail`: the `after` of the last page read; `reads`: reads so far.
/// The whole window when nothing was read yet, when older rows came on
/// screen, or on every [`TIMES_FULL_EVERY`]th read; otherwise the last page.
pub fn times_read_from(start: i64, read_from: Option<i64>, tail: i64, reads: u32) -> i64 {
    match read_from {
        Some(read) if start >= read && !reads.is_multiple_of(TIMES_FULL_EVERY) => tail.max(start),
        _ => start,
    }
}
