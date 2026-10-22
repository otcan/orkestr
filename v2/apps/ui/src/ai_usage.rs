//! Claude & Codex usage on the host page: number formats, countdowns, pace
//! sentences and chart aggregation. Pure functions, tested without a browser.
use crate::host_metrics::clock;
use orkestr_v2_contracts::{AiLimit, AiProvider, AiTokens, AiUsageWindow};

/// The section refreshes this often (the server reads transcripts each minute).
pub const REFRESH_MS: u64 = 30_000;

/// `950`, `12.3k`, `4.5M`, `1.2B` tokens.
pub fn tokens(value: u64) -> String {
    let v = value as f64;
    let (scaled, unit) = if v >= 1e9 {
        (v / 1e9, "B")
    } else if v >= 1e6 {
        (v / 1e6, "M")
    } else if v >= 1e3 {
        (v / 1e3, "k")
    } else {
        return format!("{value}");
    };
    if scaled >= 100.0 {
        format!("{scaled:.0}{unit}")
    } else {
        format!("{scaled:.1}{unit}")
    }
}

/// `$0.42`, `$12.40`, `$315`, `$1.2k`.
pub fn usd(value: f64) -> String {
    let v = value.max(0.0);
    if v >= 10_000.0 {
        format!("${:.0}k", v / 1000.0)
    } else if v >= 1000.0 {
        format!("${:.1}k", v / 1000.0)
    } else if v >= 100.0 {
        format!("${v:.0}")
    } else {
        format!("${v:.2}")
    }
}

/// `45 min`, `3 h 20 min`, `2 days 4 h`.
pub fn duration(ms: i64) -> String {
    let minutes = (ms.max(0) + 30_000) / 60_000;
    match minutes {
        0 => "under a minute".into(),
        1..=59 => format!("{minutes} min"),
        60..=2879 => {
            let (h, m) = (minutes / 60, minutes % 60);
            if m == 0 {
                format!("{h} h")
            } else {
                format!("{h} h {m} min")
            }
        }
        _ => format!("{} days {} h", minutes / 1440, minutes % 1440 / 60),
    }
}

/// `in 2 h 14 min` or `now`.
pub fn countdown(now_ms: i64, at_ms: i64) -> String {
    if at_ms <= now_ms + 30_000 {
        "now".into()
    } else {
        format!("in {}", duration(at_ms - now_ms))
    }
}

/// Local time of day, with the date when it is not today.
pub fn when(t_ms: i64, now_ms: i64, offset_minutes: i64) -> String {
    let day = |t: i64| (t / 1000 - offset_minutes * 60).div_euclid(86_400);
    clock(t_ms, offset_minutes, day(t_ms) != day(now_ms))
}

/// One plain sentence about a limit's pace.
pub fn pace(limit: &AiLimit, now_ms: i64, offset_minutes: i64) -> String {
    let name = limit.label.to_lowercase();
    let resets = limit
        .resets_at_ms
        .map(|r| format!(" It resets at {} ({}).", when(r, now_ms, offset_minutes), countdown(now_ms, r)))
        .unwrap_or_default();
    if limit.reached {
        return format!("The {name} is reached.{resets}");
    }
    match (limit.projected_full_at_ms, limit.used_percent) {
        (Some(eta), _) => format!(
            "At this rate, the {name} is reached at {} ({}).{resets}",
            when(eta, now_ms, offset_minutes),
            countdown(now_ms, eta)
        ),
        (None, Some(_)) => format!("At this rate, it lasts until the reset.{resets}"),
        (None, None) => resets.trim().to_owned(),
    }
}

/// Model colour slots, in a fixed order that does not change with the range.
pub fn model_order(window: &AiUsageWindow) -> Vec<(AiProvider, String)> {
    let mut models: Vec<(AiProvider, String)> = window
        .by_model
        .iter()
        .map(|m| (m.provider, m.model.clone()))
        .collect();
    models.sort();
    models
}

/// The CSS class of the `index`-th model (five colours, then muted).
pub fn series_class(index: Option<usize>) -> &'static str {
    match index {
        Some(0) => "series-1",
        Some(1) => "series-2",
        Some(2) => "series-3",
        Some(3) => "series-4",
        Some(4) => "series-5",
        _ => "series-muted",
    }
}

/// Stacked total per point.
pub fn stacked_max(window: &AiUsageWindow) -> u64 {
    let n = window.series.iter().map(|s| s.points.len()).max().unwrap_or(0);
    (0..n)
        .map(|i| window.series.iter().map(|s| s.points.get(i).copied().unwrap_or(0)).sum())
        .max()
        .unwrap_or(0)
}

/// The local hour of day with the most tokens over a window, and its share.
pub fn busiest_hour(window: &AiUsageWindow, offset_minutes: i64) -> Option<(u8, f64)> {
    let mut hours = [0u64; 24];
    for series in &window.series {
        for (i, v) in series.points.iter().enumerate() {
            let t = window.from_ms + i as i64 * window.step_ms;
            let local = (t / 1000 - offset_minutes * 60).rem_euclid(86_400);
            hours[(local / 3600) as usize] += v;
        }
    }
    let total: u64 = hours.iter().sum();
    let (hour, top) = hours.iter().enumerate().max_by_key(|(_, v)| **v)?;
    (*top > 0).then(|| (hour as u8, *top as f64 * 100.0 / total as f64))
}

/// Shares of the four token kinds, in percent of all tokens.
pub fn kind_shares(t: &AiTokens) -> [(&'static str, &'static str, u64, f64); 4] {
    let all = t.total().max(1) as f64;
    let share = |v: u64| v as f64 * 100.0 / all;
    [
        ("Read from cache", "series-2", t.cache_read, share(t.cache_read)),
        ("Written to cache", "series-3", t.cache_write, share(t.cache_write)),
        ("New input", "series-1", t.input, share(t.input)),
        ("Output", "series-4", t.output, share(t.output)),
    ]
}

/// Point labels of a window's x axis: start, middle and end.
pub fn axis_labels(window: &AiUsageWindow, now_ms: i64, offset_minutes: i64) -> [String; 3] {
    let n = window.series.iter().map(|s| s.points.len()).max().unwrap_or(1) as i64;
    let end = window.from_ms + n * window.step_ms;
    let mid = window.from_ms + n / 2 * window.step_ms;
    [
        when(window.from_ms, now_ms, offset_minutes),
        when(mid, now_ms, offset_minutes),
        if end >= now_ms - window.step_ms { "now".into() } else { when(end, now_ms, offset_minutes) },
    ]
}
