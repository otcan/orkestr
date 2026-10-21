//! Host metrics panel: units, freshness and chart geometry. Pure functions,
//! so the numbers the owner reads are tested without a browser.
use orkestr_v2_contracts::{HostMetricsHistory, HostMetricsRange, HostMetricsSummary};

/// The compact panel refreshes this often.
pub const SUMMARY_REFRESH_MS: u64 = 10_000;
/// A sample older than this is shown as stale.
pub const STALE_MS: i64 = 30_000;

/// Details refresh: fast ranges follow the 5 s sampler, long ones are calm.
pub fn history_refresh_ms(range: HostMetricsRange) -> u64 {
    match range {
        HostMetricsRange::Minutes15 | HostMetricsRange::Hour1 => 10_000,
        HostMetricsRange::Hours24 | HostMetricsRange::Days7 => 60_000,
    }
}

/// Binary units as `free -h` and `df -h` print them (GiB shown as "GiB").
pub fn bytes(value: f64) -> String {
    const UNITS: [&str; 6] = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    let mut value = value.max(0.0);
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{value:.0} B")
    } else if value >= 100.0 {
        format!("{value:.0} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// Decimal transfer rates (network and disk tools use powers of ten).
pub fn rate(bytes_per_second: f64) -> String {
    const UNITS: [&str; 5] = ["B/s", "kB/s", "MB/s", "GB/s", "TB/s"];
    let mut value = bytes_per_second.max(0.0);
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 || value >= 100.0 {
        format!("{value:.0} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

pub fn percent(value: f64) -> String {
    if value < 10.0 {
        format!("{value:.1}%")
    } else {
        format!("{value:.0}%")
    }
}

pub fn millis(value: f64) -> String {
    if value >= 1000.0 {
        format!("{:.2} s", value / 1000.0)
    } else if value >= 10.0 {
        format!("{value:.0} ms")
    } else {
        format!("{value:.1} ms")
    }
}

/// `"12s ago"`, `"4m ago"`, `"3h ago"`.
pub fn ago(now_ms: i64, at_ms: i64) -> String {
    let seconds = (now_ms - at_ms).max(0) / 1000;
    match seconds {
        0..=59 => format!("{seconds}s ago"),
        60..=3599 => format!("{}m ago", seconds / 60),
        3600..=172_799 => format!("{}h ago", seconds / 3600),
        _ => format!("{}d ago", seconds / 86_400),
    }
}

/// Local wall clock `HH:MM` (with a `D/M` date for multi-day ranges).
pub fn clock(t_ms: i64, offset_minutes: i64, with_date: bool) -> String {
    let local = t_ms.div_euclid(1000) - offset_minutes * 60;
    let days = local.div_euclid(86_400);
    let seconds = local.rem_euclid(86_400);
    let (hour, minute) = (seconds / 3600, seconds % 3600 / 60);
    if !with_date {
        return format!("{hour:02}:{minute:02}");
    }
    // Civil date from days since 1970-01-01 (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{day}/{month} {hour:02}:{minute:02}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
    /// No sample yet.
    Collecting,
    Live,
    Stale,
}

pub fn freshness(
    summary: Option<&HostMetricsSummary>,
    now_ms: i64,
    received_ms: Option<i64>,
) -> Freshness {
    match (summary, received_ms) {
        (Some(s), Some(received)) if !s.collecting => {
            let observed = s.observed_at_ms.unwrap_or(0);
            if now_ms - received > STALE_MS || now_ms - observed > STALE_MS {
                Freshness::Stale
            } else {
                Freshness::Live
            }
        }
        (Some(_), _) => Freshness::Collecting,
        _ => Freshness::Collecting,
    }
}

/// Used share in percent; `None` without a total.
pub fn share(used: Option<u64>, whole: Option<u64>) -> Option<f64> {
    let whole = whole.filter(|w| *w > 0)? as f64;
    Some(used? as f64 * 100.0 / whole)
}

/// A "nice" axis maximum at or above `value` (1, 2, 2.5, 5 × 10^n).
pub fn nice_max(value: f64) -> f64 {
    if value <= 0.0 || !value.is_finite() {
        return 1.0;
    }
    let magnitude = 10f64.powf(value.log10().floor());
    [1.0, 2.0, 2.5, 5.0, 10.0]
        .into_iter()
        .map(|m| m * magnitude)
        .find(|candidate| *candidate >= value * 0.999)
        .unwrap_or(10.0 * magnitude)
}

/// The plotting box of one chart: time from `from_ms` over `span_ms` across
/// `width`, values 0..=`max` up `height`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub from_ms: i64,
    pub span_ms: i64,
    pub step_ms: i64,
    pub width: f64,
    pub height: f64,
    pub max: f64,
}

impl Frame {
    pub fn x(&self, t_ms: i64) -> f64 {
        ((t_ms - self.from_ms) as f64 / self.span_ms.max(1) as f64).clamp(0.0, 1.0) * self.width
    }
    pub fn y(&self, value: f64) -> f64 {
        let max = if self.max > 0.0 { self.max } else { 1.0 };
        self.height - (value / max).clamp(0.0, 1.0) * self.height
    }
    /// Time at horizontal position `x`.
    pub fn t(&self, x: f64) -> i64 {
        self.from_ms + ((x / self.width).clamp(0.0, 1.0) * self.span_ms as f64) as i64
    }
}

/// SVG polyline point lists for `(t, value)` pairs, oldest first. Missing
/// values and gaps longer than three steps (no samples) split the line.
pub fn polylines(points: &[(i64, Option<f64>)], frame: &Frame) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut last_t: Option<i64> = None;
    for (t, value) in points {
        let gap = last_t.is_some_and(|last| t - last > frame.step_ms * 3);
        if (value.is_none() || gap) && !current.is_empty() {
            lines.push(std::mem::take(&mut current));
        }
        if let Some(v) = value {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(&format!("{:.1},{:.1}", frame.x(*t), frame.y(*v)));
            last_t = Some(*t);
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

/// Index of the point nearest to time `t_ms`.
pub fn nearest(times: &[i64], t_ms: i64) -> Option<usize> {
    times
        .iter()
        .enumerate()
        .min_by_key(|(_, t)| (**t - t_ms).abs())
        .map(|(index, _)| index)
}

/// Spans of the range without history (before the first sample) as a share
/// of the width, for the "collecting" shading.
pub fn coverage(history: &HostMetricsHistory, now_ms: i64) -> f64 {
    let span = history.range.span_ms() as f64;
    match history.history_from_ms {
        Some(from) => (((now_ms - from) as f64) / span).clamp(0.0, 1.0),
        None => 0.0,
    }
}
