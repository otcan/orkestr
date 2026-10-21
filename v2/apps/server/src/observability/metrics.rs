//! In-process request metrics: cumulative counters and latency histograms
//! per route template (Prometheus), plus recent samples for exact windowed
//! p50/p95/p99 and error rates (JSON, used by the owner's health check).
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    fmt::Write,
    sync::Mutex,
    time::{Duration, Instant},
};

/// Histogram upper bounds in milliseconds (`+Inf` is implicit).
const BUCKETS_MS: [f64; 14] = [
    1.0, 2.5, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0, 10000.0, 30000.0,
];
/// Recent samples kept per series for windowed percentiles.
const RECENT_MAX: usize = 4096;
const RECENT_AGE: Duration = Duration::from_secs(3600);
/// Route templates are bounded, but never let a bug create unbounded series.
const SERIES_MAX: usize = 512;

#[derive(Clone, Copy)]
struct Sample {
    at: Instant,
    micros: u64,
    status: u16,
}

#[derive(Default)]
struct Series {
    count: u64,
    sum: Duration,
    buckets: [u64; BUCKETS_MS.len() + 1],
    /// Responses by status class: 0 = none/unknown, 1..=5 = 1xx..5xx.
    classes: [u64; 6],
    streaming: bool,
    recent: VecDeque<Sample>,
}

impl Series {
    fn record(&mut self, status: u16, elapsed: Duration, now: Instant) {
        self.count += 1;
        self.sum += elapsed;
        let ms = elapsed.as_secs_f64() * 1000.0;
        let bucket = BUCKETS_MS
            .iter()
            .position(|bound| ms <= *bound)
            .unwrap_or(BUCKETS_MS.len());
        self.buckets[bucket] += 1;
        self.classes[usize::from(status / 100).min(5)] += 1;
        if self.recent.len() >= RECENT_MAX {
            self.recent.pop_front();
        }
        while self
            .recent
            .front()
            .is_some_and(|s| now.duration_since(s.at) > RECENT_AGE)
        {
            self.recent.pop_front();
        }
        self.recent.push_back(Sample {
            at: now,
            micros: u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX),
            status,
        });
    }

    fn window(&self, window: Duration, now: Instant) -> Option<Window> {
        let mut micros: Vec<u64> = Vec::new();
        let mut errors = 0;
        let mut oldest = None;
        for sample in self.recent.iter().rev() {
            if now.duration_since(sample.at) > window {
                break;
            }
            micros.push(sample.micros);
            errors += u64::from(is_error(sample.status));
            oldest = Some(sample.at);
        }
        if micros.is_empty() {
            return None;
        }
        micros.sort_unstable();
        let quantile = |q: f64| {
            // Nearest rank: the smallest value with at least q of samples at or below it.
            let rank = ((q * micros.len() as f64).ceil() as usize).clamp(1, micros.len());
            micros[rank - 1] as f64 / 1000.0
        };
        Some(Window {
            count: micros.len() as u64,
            errors,
            p50: quantile(0.50),
            p95: quantile(0.95),
            p99: quantile(0.99),
            max: *micros.last().unwrap() as f64 / 1000.0,
            // Fewer samples were kept than the window asked for (busy route).
            covered: oldest.map(|o| now.duration_since(o)).unwrap_or_default(),
            complete: self.recent.len() < RECENT_MAX
                || self
                    .recent
                    .front()
                    .is_some_and(|s| now.duration_since(s.at) >= window),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    pub count: u64,
    pub errors: u64,
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
    pub covered: Duration,
    pub complete: bool,
}

pub struct Metrics {
    started: Instant,
    http: Mutex<BTreeMap<(String, String), Series>>,
    upstream: Mutex<BTreeMap<(String, String), Series>>,
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            http: Mutex::default(),
            upstream: Mutex::default(),
        }
    }
}

fn record_into(
    map: &Mutex<BTreeMap<(String, String), Series>>,
    key: (&str, &str),
    status: u16,
    elapsed: Duration,
    streaming: bool,
) {
    let Ok(mut map) = map.lock() else { return };
    let now = Instant::now();
    let key = (key.0.to_owned(), key.1.to_owned());
    if !map.contains_key(&key) && map.len() >= SERIES_MAX {
        return;
    }
    let series = map.entry(key).or_default();
    series.streaming |= streaming;
    series.record(status, elapsed, now);
}

impl Metrics {
    pub fn record(
        &self,
        method: &str,
        route: &str,
        status: u16,
        elapsed: Duration,
        streaming: bool,
    ) {
        record_into(&self.http, (method, route), status, elapsed, streaming);
    }
    pub fn record_upstream(&self, target: &str, route: &str, status: u16, elapsed: Duration) {
        record_into(&self.upstream, (target, route), status, elapsed, false);
    }

    /// Windowed latency and error summary of one route, if it had requests.
    pub fn window(&self, method: &str, route: &str, window: Duration) -> Option<Window> {
        let map = self.http.lock().ok()?;
        map.get(&(method.to_owned(), route.to_owned()))?
            .window(window, Instant::now())
    }

    /// JSON summary over the last `window`: per route, per upstream and overall.
    pub fn summary(&self, window: Duration, slow: Duration) -> Value {
        let now = Instant::now();
        let describe = |map: &BTreeMap<(String, String), Series>, first: &str, second: &str| {
            let mut rows = Vec::new();
            let mut all = Series::default();
            for ((a, b), series) in map {
                if !series.streaming {
                    for sample in series
                        .recent
                        .iter()
                        .filter(|s| now.duration_since(s.at) <= window)
                    {
                        all.recent.push_back(*sample);
                    }
                }
                let Some(w) = series.window(window, now) else {
                    continue;
                };
                rows.push(json!({
                    first: a, second: b,
                    "count": w.count, "errors": w.errors,
                    "error_rate": rate(w.errors, w.count),
                    "p50_ms": round(w.p50), "p95_ms": round(w.p95), "p99_ms": round(w.p99),
                    "max_ms": round(w.max),
                    "window_complete": w.complete,
                    "streaming": series.streaming,
                    "total_count": series.count,
                    "total_errors": series.classes[5] + series.classes[0],
                }));
            }
            // Overall: every non-streaming request in the window.
            all.recent.make_contiguous().sort_by_key(|s| s.at);
            let overall = all.window(window, now).map(|w| {
                json!({
                    "count": w.count, "errors": w.errors,
                    "error_rate": rate(w.errors, w.count),
                    "p50_ms": round(w.p50), "p95_ms": round(w.p95), "p99_ms": round(w.p99),
                    "max_ms": round(w.max),
                })
            });
            (rows, overall)
        };
        let (routes, overall) = self
            .http
            .lock()
            .map(|m| describe(&m, "method", "route"))
            .unwrap_or_default();
        let (upstream, _) = self
            .upstream
            .lock()
            .map(|m| describe(&m, "target", "route"))
            .unwrap_or_default();
        json!({
            "schema": 1,
            "uptime_s": self.started.elapsed().as_secs(),
            "window_s": window.as_secs(),
            "slow_threshold_ms": slow.as_millis() as u64,
            "overall": overall,
            "routes": routes,
            "upstream": upstream,
        })
    }

    /// Prometheus text exposition (version 0.0.4).
    pub fn prometheus(&self, window: Duration) -> String {
        let now = Instant::now();
        let mut out = String::new();
        let _ = writeln!(
            out,
            "# HELP orkestr_v2_uptime_seconds Seconds since the server started.\n# TYPE orkestr_v2_uptime_seconds gauge\norkestr_v2_uptime_seconds {}",
            self.started.elapsed().as_secs()
        );
        if let Ok(map) = self.http.lock() {
            family(
                &mut out,
                &map,
                "orkestr_v2_http",
                "HTTP requests",
                ("method", "route"),
                window,
                now,
            );
        }
        if let Ok(map) = self.upstream.lock() {
            family(
                &mut out,
                &map,
                "orkestr_v2_upstream",
                "Upstream calls",
                ("target", "route"),
                window,
                now,
            );
        }
        out
    }
}

/// Server failures: 5xx, the handler deadline (408) and no answer at all (0).
pub fn is_error(status: u16) -> bool {
    status >= 500 || status == 408 || status == 0
}

fn rate(errors: u64, count: u64) -> f64 {
    (errors as f64 / count.max(1) as f64 * 10_000.0).round() / 10_000.0
}

fn round(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

fn family(
    out: &mut String,
    map: &BTreeMap<(String, String), Series>,
    prefix: &str,
    what: &str,
    names: (&str, &str),
    window: Duration,
    now: Instant,
) {
    let _ = writeln!(out, "# HELP {prefix}_requests_total {what} by status class.\n# TYPE {prefix}_requests_total counter");
    for ((a, b), s) in map {
        for (class, count) in s.classes.iter().enumerate().filter(|(_, c)| **c > 0) {
            let class = if class == 0 {
                "none".to_owned()
            } else {
                format!("{class}xx")
            };
            let _ = writeln!(
                out,
                "{prefix}_requests_total{{{}=\"{}\",{}=\"{}\",status_class=\"{class}\"}} {count}",
                names.0,
                escape(a),
                names.1,
                escape(b)
            );
        }
    }
    let _ = writeln!(out, "# HELP {prefix}_duration_seconds {what} latency.\n# TYPE {prefix}_duration_seconds histogram");
    for ((a, b), s) in map {
        let labels = format!(
            "{}=\"{}\",{}=\"{}\"",
            names.0,
            escape(a),
            names.1,
            escape(b)
        );
        let mut cumulative = 0;
        for (index, bound) in BUCKETS_MS.iter().enumerate() {
            cumulative += s.buckets[index];
            let _ = writeln!(
                out,
                "{prefix}_duration_seconds_bucket{{{labels},le=\"{}\"}} {cumulative}",
                bound / 1000.0
            );
        }
        let _ = writeln!(
            out,
            "{prefix}_duration_seconds_bucket{{{labels},le=\"+Inf\"}} {}",
            s.count
        );
        let _ = writeln!(
            out,
            "{prefix}_duration_seconds_sum{{{labels}}} {}",
            s.sum.as_secs_f64()
        );
        let _ = writeln!(
            out,
            "{prefix}_duration_seconds_count{{{labels}}} {}",
            s.count
        );
    }
    let _ = writeln!(out, "# HELP {prefix}_window_duration_seconds {what} latency quantiles over the last {}s.\n# TYPE {prefix}_window_duration_seconds gauge", window.as_secs());
    for ((a, b), s) in map {
        if let Some(w) = s.window(window, now) {
            let labels = format!(
                "{}=\"{}\",{}=\"{}\"",
                names.0,
                escape(a),
                names.1,
                escape(b)
            );
            for (q, v) in [("0.5", w.p50), ("0.95", w.p95), ("0.99", w.p99)] {
                let _ = writeln!(
                    out,
                    "{prefix}_window_duration_seconds{{{labels},quantile=\"{q}\"}} {}",
                    v / 1000.0
                );
            }
        }
    }
}
