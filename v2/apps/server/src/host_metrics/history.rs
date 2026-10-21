//! Bounded history: raw 5 s samples for an hour, one-minute averages for a
//! day and ten-minute averages for a week (about 3 200 points in all).
//! Responses re-bucket one tier to at most a few hundred points.
use orkestr_v2_contracts::{HostMetricsPoint, HostMetricsRange};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub(crate) const SAMPLE_MS: i64 = 5_000;
const RAW_KEEP_MS: i64 = 3_600_000;
const MINUTE_MS: i64 = 60_000;
const MINUTES_KEEP_MS: i64 = 24 * 3_600_000;
const TEN_MINUTES_MS: i64 = 600_000;
const TEN_MINUTES_KEEP_MS: i64 = 7 * 24 * 3_600_000;

/// One point; the serialized names keep the persisted file small.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Sample {
    #[serde(rename = "t")]
    pub t_ms: i64,
    #[serde(rename = "c")]
    pub cpu: f32,
    #[serde(rename = "k")]
    pub cores: Vec<f32>,
    #[serde(rename = "l")]
    pub load: (f32, f32, f32),
    #[serde(rename = "mu")]
    pub mem_used: u64,
    #[serde(rename = "mc")]
    pub mem_cache: u64,
    #[serde(rename = "su")]
    pub swap_used: u64,
    #[serde(rename = "du")]
    pub disk_used: u64,
    #[serde(rename = "dr")]
    pub disk_read_bps: f32,
    #[serde(rename = "dw")]
    pub disk_write_bps: f32,
    #[serde(rename = "nr")]
    pub net_rx_bps: f32,
    #[serde(rename = "nt")]
    pub net_tx_bps: f32,
    #[serde(rename = "rr")]
    pub req_rate: f32,
    #[serde(rename = "r5", default)]
    pub req_p50: Option<f32>,
    #[serde(rename = "r9", default)]
    pub req_p95: Option<f32>,
    #[serde(rename = "re", default)]
    pub req_error_rate: Option<f32>,
}

fn mean(values: impl Iterator<Item = f64>) -> Option<f64> {
    let (sum, count) = values.fold((0.0, 0usize), |(s, n), v| (s + v, n + 1));
    (count > 0).then(|| sum / count as f64)
}

/// Averages of a non-empty group stamped `t_ms`. Latency p95 keeps the worst
/// bucket so a downsampled spike stays visible.
pub(crate) fn aggregate(group: &[&Sample], t_ms: i64) -> Sample {
    let f = |get: &dyn Fn(&Sample) -> f64| mean(group.iter().map(|s| get(s))).unwrap_or(0.0);
    let cores = group.iter().map(|s| s.cores.len()).max().unwrap_or(0);
    Sample {
        t_ms,
        cpu: f(&|s| s.cpu.into()) as f32,
        cores: (0..cores)
            .map(|i| {
                mean(
                    group
                        .iter()
                        .filter_map(|s| s.cores.get(i).map(|v| f64::from(*v))),
                )
                .unwrap_or(0.0) as f32
            })
            .collect(),
        load: (
            f(&|s| s.load.0.into()) as f32,
            f(&|s| s.load.1.into()) as f32,
            f(&|s| s.load.2.into()) as f32,
        ),
        mem_used: f(&|s| s.mem_used as f64) as u64,
        mem_cache: f(&|s| s.mem_cache as f64) as u64,
        swap_used: f(&|s| s.swap_used as f64) as u64,
        disk_used: f(&|s| s.disk_used as f64) as u64,
        disk_read_bps: f(&|s| s.disk_read_bps.into()) as f32,
        disk_write_bps: f(&|s| s.disk_write_bps.into()) as f32,
        net_rx_bps: f(&|s| s.net_rx_bps.into()) as f32,
        net_tx_bps: f(&|s| s.net_tx_bps.into()) as f32,
        req_rate: f(&|s| s.req_rate.into()) as f32,
        req_p50: mean(group.iter().filter_map(|s| s.req_p50).map(f64::from)).map(|v| v as f32),
        req_p95: group.iter().filter_map(|s| s.req_p95).reduce(f32::max),
        req_error_rate: mean(group.iter().filter_map(|s| s.req_error_rate).map(f64::from))
            .map(|v| v as f32),
    }
}

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct History {
    #[serde(skip)]
    pub raw: VecDeque<Sample>,
    pub minutes: VecDeque<Sample>,
    pub ten_minutes: VecDeque<Sample>,
}

fn prune(tier: &mut VecDeque<Sample>, now: i64, keep: i64) {
    while tier.front().is_some_and(|s| s.t_ms < now - keep) {
        tier.pop_front();
    }
}

/// Folds every complete `width` bucket of `source` newer than `tier`'s last
/// point into `tier`.
fn roll(source: &VecDeque<Sample>, tier: &mut VecDeque<Sample>, width: i64, now: i64) {
    let current = now.div_euclid(width) * width;
    let after = tier.back().map_or(i64::MIN, |s| s.t_ms);
    // Only the samples after the tier's last bucket (from the back: cheap).
    let fresh = source
        .iter()
        .rev()
        .take_while(|s| s.t_ms.div_euclid(width) * width > after)
        .count();
    let mut bucket: Option<i64> = None;
    let mut group: Vec<&Sample> = Vec::new();
    for sample in source
        .iter()
        .skip(source.len() - fresh)
        .filter(|s| s.t_ms < current)
    {
        let start = sample.t_ms.div_euclid(width) * width;
        if bucket.is_some_and(|b| b != start) {
            tier.push_back(aggregate(&group, bucket.unwrap()));
            group.clear();
        }
        bucket = Some(start);
        group.push(sample);
    }
    if let Some(start) = bucket {
        tier.push_back(aggregate(&group, start));
    }
}

impl History {
    pub fn push(&mut self, sample: Sample) {
        let now = sample.t_ms;
        if self.raw.back().is_some_and(|last| last.t_ms >= now) {
            return;
        }
        self.raw.push_back(sample);
        roll(&self.raw, &mut self.minutes, MINUTE_MS, now);
        roll(&self.minutes, &mut self.ten_minutes, TEN_MINUTES_MS, now);
        prune(&mut self.raw, now, RAW_KEEP_MS);
        prune(&mut self.minutes, now, MINUTES_KEEP_MS);
        prune(&mut self.ten_minutes, now, TEN_MINUTES_KEEP_MS);
    }

    /// Drops what a restart cannot trust (future or expired points).
    pub fn restored(mut self, now: i64) -> Self {
        for (tier, keep) in [
            (&mut self.minutes, MINUTES_KEEP_MS),
            (&mut self.ten_minutes, TEN_MINUTES_KEEP_MS),
        ] {
            tier.retain(|s| s.t_ms <= now);
            tier.make_contiguous().sort_by_key(|s| s.t_ms);
            prune(tier, now, keep);
        }
        self
    }

    pub fn latest(&self) -> Option<&Sample> {
        self.raw.back()
    }

    /// Last `count` raw samples, oldest first.
    pub fn recent(&self, count: usize) -> impl Iterator<Item = &Sample> {
        self.raw.iter().skip(self.raw.len().saturating_sub(count))
    }

    /// Points of `range` ending at `now`, at most one per step, oldest first.
    pub fn range(&self, range: HostMetricsRange, now: i64) -> (Vec<HostMetricsPoint>, Option<i64>) {
        let tier = match range {
            HostMetricsRange::Minutes15 | HostMetricsRange::Hour1 => &self.raw,
            HostMetricsRange::Hours24 => &self.minutes,
            HostMetricsRange::Days7 => &self.ten_minutes,
        };
        let from = now - range.span_ms();
        let step = range.step_ms();
        let mut points = Vec::new();
        let mut group: Vec<&Sample> = Vec::new();
        let mut bucket = None;
        let mut oldest = None;
        for sample in tier.iter().filter(|s| s.t_ms > from && s.t_ms <= now) {
            oldest.get_or_insert(sample.t_ms);
            let start = sample.t_ms.div_euclid(step) * step;
            if bucket.is_some_and(|b| b != start) {
                points.push(point(&aggregate(&group, bucket.unwrap())));
                group.clear();
            }
            bucket = Some(start);
            group.push(sample);
        }
        if let Some(start) = bucket {
            points.push(point(&aggregate(&group, start)));
        }
        (points, oldest)
    }
}

pub(crate) fn point(s: &Sample) -> HostMetricsPoint {
    let round = |v: f32| (v * 10.0).round() / 10.0;
    HostMetricsPoint {
        t_ms: s.t_ms,
        cpu: round(s.cpu),
        cores: s.cores.iter().map(|v| round(*v)).collect(),
        load1: (s.load.0 * 100.0).round() / 100.0,
        load5: (s.load.1 * 100.0).round() / 100.0,
        load15: (s.load.2 * 100.0).round() / 100.0,
        mem_used: s.mem_used,
        mem_cache: s.mem_cache,
        swap_used: s.swap_used,
        disk_used: s.disk_used,
        disk_read_bps: s.disk_read_bps.round(),
        disk_write_bps: s.disk_write_bps.round(),
        net_rx_bps: s.net_rx_bps.round(),
        net_tx_bps: s.net_tx_bps.round(),
        req_rate: (s.req_rate * 100.0).round() / 100.0,
        req_p50_ms: s.req_p50.map(round),
        req_p95_ms: s.req_p95.map(round),
        req_error_rate: s.req_error_rate.map(|v| (v * 10_000.0).round() / 10_000.0),
    }
}
