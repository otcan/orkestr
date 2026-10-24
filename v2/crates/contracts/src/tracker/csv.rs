//! CSV export of tracker rows: UTF-8 with a byte-order mark (Excel opens it
//! as UTF-8), `,` or `;` (German locale) delimiters, ISO-8601 UTC dates and
//! spreadsheet formula injection neutralised.
use super::TrackerRow;

const HEADER: [&str; 13] = [
    "company",
    "role",
    "status",
    "source",
    "applied",
    "last_contact",
    "next_step",
    "link",
    "location",
    "notes",
    "needs_review",
    "archived",
    "events_count",
];

/// `2026-10-20T09:00:00Z` for Unix milliseconds.
pub fn tracker_iso_utc(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    // Civil from days (Howard Hinnant's algorithm).
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

fn field(value: &str, delimiter: char) -> String {
    // A leading = + - @ (or tab/CR) would run as a formula in a spreadsheet.
    let value = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if value.contains([delimiter, '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

/// The whole table; `delimiter` is `,` or `;`.
pub fn tracker_csv(rows: &[TrackerRow], delimiter: char) -> String {
    let sep = delimiter.to_string();
    let mut out = String::from("\u{feff}");
    out.push_str(&HEADER.join(&sep));
    out.push_str("\r\n");
    for row in rows {
        let cells = [
            row.company.clone(),
            row.role.clone(),
            row.status.as_str().to_owned(),
            row.source.clone(),
            row.applied_ms
                .map(|ms| tracker_iso_utc(ms)[..10].to_owned())
                .unwrap_or_default(),
            tracker_iso_utc(row.last_contact_ms),
            row.next_step.clone().unwrap_or_default(),
            row.link.clone().unwrap_or_default(),
            row.location.clone().unwrap_or_default(),
            row.notes.clone(),
            row.needs_review.to_string(),
            row.archived.to_string(),
            row.events_count.to_string(),
        ];
        let line: Vec<String> = cells.iter().map(|c| field(c, delimiter)).collect();
        out.push_str(&line.join(&sep));
        out.push_str("\r\n");
    }
    out
}
