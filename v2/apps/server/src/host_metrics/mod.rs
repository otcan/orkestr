//! Owner-only host metrics panel data. One background task samples `/proc`
//! every 5 s (kernel reads off the async workers) into a bounded history,
//! reads the listed systemd units every 30 s and persists the downsampled
//! tiers every 5 minutes so a restart keeps the 24 h and 7 d charts. Requests
//! only read the in-memory state: page loads never wait for a sample.
pub(crate) mod consumers;
pub(crate) mod disks;
pub(crate) mod history;
pub(crate) mod procfs;
pub(crate) mod services;
#[cfg(test)]
mod tests;

use crate::{observability::Observer, owner, AppState, Error};
use axum::{
    extract::{rejection::QueryRejection, Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use history::{History, Sample, SAMPLE_MS};
use orkestr_v2_contracts::{
    HostConsumer, HostConsumers, HostDirectories, HostDisks, HostMetricsHistory, HostMetricsRange,
    HostMetricsSummary, HostMount, ServiceHealth, HOST_METRICS_SPARK_POINTS,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};

const SERVICES_EVERY: u64 = 6;
const PERSIST_EVERY: u64 = 60;
const PERSIST_FILE: &str = "host-metrics.json";

#[derive(Default)]
pub(crate) struct Shared {
    history: History,
    gauges: procfs::Gauges,
    cores: u32,
    services: Vec<ServiceHealth>,
    services_at_ms: Option<i64>,
    mounts: Vec<HostMount>,
    consumers: Vec<HostConsumer>,
    consumers_at_ms: Option<i64>,
    directories: Option<HostDirectories>,
}

static SHARED: LazyLock<Arc<Mutex<Shared>>> = LazyLock::new(Default::default);

fn shared() -> std::sync::MutexGuard<'static, Shared> {
    SHARED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// Turns two readings `elapsed` apart into one history sample.
pub(crate) fn sample(
    before: &procfs::Reading,
    after: &procfs::Reading,
    elapsed: Duration,
    t_ms: i64,
    requests: Option<crate::observability::metrics::Window>,
    request_window: Duration,
) -> Option<Sample> {
    let seconds = elapsed.as_secs_f64();
    if seconds <= 0.0 {
        return None;
    }
    let rate = |a: u64, b: u64| (b.saturating_sub(a) as f64 / seconds) as f32;
    let (b, a) = (&before.counters, &after.counters);
    Some(Sample {
        t_ms,
        cpu: procfs::busy_percent(b.cpu_total, a.cpu_total)?,
        cores: b
            .cpu_cores
            .iter()
            .zip(&a.cpu_cores)
            .map(|(x, y)| procfs::busy_percent(*x, *y).unwrap_or(0.0))
            .collect(),
        load: after.gauges.load,
        mem_used: after.gauges.mem_used,
        mem_cache: after.gauges.mem_cache,
        swap_used: after.gauges.swap_used,
        disk_used: after.gauges.disk_used,
        disk_read_bps: rate(b.disk_read_bytes, a.disk_read_bytes),
        disk_write_bps: rate(b.disk_write_bytes, a.disk_write_bytes),
        net_rx_bps: rate(b.net_rx_bytes, a.net_rx_bytes),
        net_tx_bps: rate(b.net_tx_bytes, a.net_tx_bytes),
        req_rate: requests.map_or(0.0, |w| {
            (w.count as f64 / request_window.as_secs_f64()) as f32
        }),
        req_p50: requests.map(|w| w.p50 as f32),
        req_p95: requests.map(|w| w.p95 as f32),
        req_error_rate: requests.map(|w| (w.errors as f64 / w.count.max(1) as f64) as f32),
    })
}

fn restore(path: &Path) -> History {
    std::fs::read(path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<History>(&raw).ok())
        .map(|h| h.restored(now_ms()))
        .unwrap_or_default()
}

fn persist(path: &Path) {
    let raw = {
        let shared = shared();
        serde_json::to_vec(&shared.history)
    };
    let Ok(raw) = raw else { return };
    let next = path.with_extension("json.next");
    if std::fs::write(&next, raw).is_ok() {
        let _ = std::fs::rename(&next, path);
    }
}

/// How the sampler runs; tests shorten the tick and inject a fake `du`.
pub(crate) struct Options {
    pub(crate) tick: Duration,
    /// Ticks before the first directory measurement.
    pub(crate) first_directories_tick: u64,
    pub(crate) directories_command: fn() -> std::process::Command,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            tick: Duration::from_millis(SAMPLE_MS as u64),
            first_directories_tick: 24,
            directories_command: disks::du_command,
        }
    }
}

/// The running sampler. `shutdown` stops it and kills a running `du`.
pub struct HostMetrics {
    cancel: Arc<AtomicBool>,
    wake: Arc<tokio::sync::Notify>,
    task: tokio::task::JoinHandle<()>,
}

impl HostMetrics {
    /// Stops sampling; a running directory measurement is killed and reaped.
    /// Returns within about `DU_POLL` plus one in-flight `/proc` read.
    pub async fn shutdown(self) {
        self.cancel.store(true, Ordering::Release);
        self.wake.notify_one();
        let mut task = self.task;
        if tokio::time::timeout(Duration::from_secs(2), &mut task)
            .await
            .is_err()
        {
            task.abort();
        }
    }
}

/// Starts the sampler (trusted startup only). No new directory measurement
/// starts while an operator deploy drain is requested.
pub fn start(home: &Path, drain: Arc<crate::deploy_drain::DeployDrain>) -> HostMetrics {
    start_with(home, drain, Options::default())
}

pub(crate) fn start_with(
    home: &Path,
    drain: Arc<crate::deploy_drain::DeployDrain>,
    options: Options,
) -> HostMetrics {
    let home: PathBuf = home.to_owned();
    let cancel = Arc::new(AtomicBool::new(false));
    let wake = Arc::new(tokio::sync::Notify::new());
    let (stop, notified) = (cancel.clone(), wake.clone());
    let task = tokio::spawn(async move {
        let cancel = stop;
        let file = home.join(PERSIST_FILE);
        let restored = {
            let file = file.clone();
            tokio::task::spawn_blocking(move || restore(&file))
                .await
                .unwrap_or_default()
        };
        shared().history = restored;
        let units = {
            let home = home.clone();
            tokio::task::spawn_blocking(move || services::load(&home))
                .await
                .unwrap_or_default()
        };
        let labels = consumers::unit_labels(&units);
        let scanner = Arc::new(Mutex::new(consumers::Scanner::new()));
        let mut directories_at: Option<Instant> = None;
        let mut measuring: Option<tokio::task::JoinHandle<()>> = None;
        let mut ticker = tokio::time::interval(options.tick);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut previous: Option<(Instant, procfs::Reading)> = None;
        let request_window = Duration::from_secs(60);
        let mut tick: u64 = 0;
        loop {
            tick = tick.wrapping_add(1);
            tokio::select! {
                _ = ticker.tick() => {}
                _ = notified.notified() => break,
            }
            if cancel.load(Ordering::Acquire) {
                break;
            }
            let reading = tokio::task::spawn_blocking(procfs::read)
                .await
                .ok()
                .flatten();
            let now = Instant::now();
            if let Some(reading) = reading {
                let requests = Observer::global().metrics.overall(request_window);
                let point = previous.as_ref().and_then(|(at, before)| {
                    sample(
                        before,
                        &reading,
                        now - *at,
                        now_ms(),
                        requests,
                        request_window,
                    )
                });
                {
                    let mut shared = shared();
                    shared.cores = reading.counters.cpu_cores.len() as u32;
                    shared.gauges = reading.gauges.clone();
                    if let Some(point) = point {
                        shared.history.push(point);
                    }
                }
                previous = Some((now, reading));
            } else {
                previous = None;
            }
            if let Ok(mounts) = tokio::task::spawn_blocking(disks::read_mounts).await {
                shared().mounts = mounts;
            }
            // Process attribution every 10 s (every second tick).
            if tick % 2 == 1 {
                let (scanner, labels) = (scanner.clone(), labels.clone());
                let top = tokio::task::spawn_blocking(move || {
                    let mut scanner = scanner.lock().unwrap_or_else(|p| p.into_inner());
                    scanner.sample(&labels).then(|| scanner.top())
                })
                .await
                .ok()
                .flatten();
                if let Some(top) = top {
                    let mut shared = shared();
                    shared.consumers = top;
                    shared.consumers_at_ms = Some(now_ms());
                }
            }
            // Largest directories: two minutes after start, then hourly, one
            // at a time, never while a deploy drain is requested.
            let due = match directories_at {
                None => tick >= options.first_directories_tick,
                Some(at) => at.elapsed() >= disks::DIRECTORY_EVERY,
            };
            let idle = measuring.as_ref().is_none_or(|task| task.is_finished());
            if due && idle && !drain.is_draining() {
                directories_at = Some(Instant::now());
                shared()
                    .directories
                    .get_or_insert_with(disks::empty_directories)
                    .running = true;
                let (cancel, command) = (cancel.clone(), (options.directories_command)());
                measuring = Some(tokio::task::spawn_blocking(move || {
                    let measured = disks::measure_directories(command, &cancel);
                    let mut shared = shared();
                    let directories = shared
                        .directories
                        .get_or_insert_with(disks::empty_directories);
                    directories.running = false;
                    if let Some((readable, entries)) = measured {
                        directories.readable_bytes = readable;
                        directories.entries = entries;
                        directories.observed_at_ms = Some(now_ms());
                    }
                }));
            }

            if tick % SERVICES_EVERY == 1 {
                let units = units.clone();
                if let Ok(services) =
                    tokio::task::spawn_blocking(move || services::read(&units)).await
                {
                    let mut shared = shared();
                    shared.services = services;
                    shared.services_at_ms = Some(now_ms());
                }
            }
            if tick.is_multiple_of(PERSIST_EVERY) {
                let file = file.clone();
                let _ = tokio::task::spawn_blocking(move || persist(&file)).await;
            }
        }
        // Cancel is set: a running `du` is killed and reaped within `DU_POLL`.
        if let Some(measuring) = measuring {
            let _ = measuring.await;
        }
    });
    HostMetrics { cancel, wake, task }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v2/host-metrics", get(summary))
        .route("/api/v2/host-metrics/history", get(history))
        .route("/api/v2/host-metrics/consumers", get(consumers_read))
        .route("/api/v2/host-metrics/disks", get(disks_read))
}

fn percent(part: u64, whole: u64) -> f32 {
    if whole == 0 {
        0.0
    } else {
        ((part as f64 * 1000.0 / whole as f64).round() / 10.0) as f32
    }
}

pub(crate) fn summary_of(shared: &Shared) -> HostMetricsSummary {
    let latest = shared.history.latest();
    let g = &shared.gauges;
    let known = g.mem_total > 0;
    let disk = g.disk_total > 0;
    let recent: Vec<&Sample> = shared.history.recent(HOST_METRICS_SPARK_POINTS).collect();
    let disk_whole = g.disk_used + g.disk_free;
    HostMetricsSummary {
        schema_version: 1,
        collecting: latest.is_none(),
        observed_at_ms: latest.map(|s| s.t_ms),
        interval_ms: SAMPLE_MS as u64,
        cores: shared.cores,
        cpu_percent: latest.map(|s| (s.cpu * 10.0).round() / 10.0),
        memory_used_bytes: known.then_some(g.mem_used),
        memory_total_bytes: known.then_some(g.mem_total),
        disk_used_bytes: disk.then_some(g.disk_used),
        disk_free_bytes: disk.then_some(g.disk_free),
        disk_total_bytes: disk.then_some(g.disk_total),
        spark_cpu: recent
            .iter()
            .map(|s| (s.cpu * 10.0).round() / 10.0)
            .collect(),
        spark_memory: recent
            .iter()
            .map(|s| percent(s.mem_used, g.mem_total))
            .collect(),
        spark_disk: recent
            .iter()
            .map(|s| percent(s.disk_used, disk_whole))
            .collect(),
        swap_used_bytes: known.then_some(g.swap_used),
        swap_total_bytes: known.then_some(g.swap_total),
        load: latest.map(|s| s.load),
        mounts: shared.mounts.clone(),
        cpu_cores_percent: latest
            .map(|s| s.cores.iter().map(|v| (v * 10.0).round() / 10.0).collect())
            .unwrap_or_default(),
        disk_read_bps: latest.map(|s| s.disk_read_bps.round()),
        disk_write_bps: latest.map(|s| s.disk_write_bps.round()),
        net_rx_bps: latest.map(|s| s.net_rx_bps.round()),
        net_tx_bps: latest.map(|s| s.net_tx_bps.round()),
    }
}

/// Compact panel: current values and short sparklines.
pub(crate) async fn summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HostMetricsSummary>, Error> {
    // Host-wide aggregates: owner only, like the host resources sample.
    owner(&state, &headers).await?;
    Ok(Json(summary_of(&shared())))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RangeQuery {
    range: String,
}

pub(crate) fn history_of(shared: &Shared, range: HostMetricsRange, now: i64) -> HostMetricsHistory {
    let (points, history_from_ms) = shared.history.range(range, now);
    HostMetricsHistory {
        schema_version: 1,
        range,
        step_ms: range.step_ms(),
        collecting: points.is_empty(),
        observed_at_ms: shared.history.latest().map(|s| s.t_ms),
        history_from_ms,
        cores: shared.cores,
        memory_total_bytes: shared.gauges.mem_total,
        swap_total_bytes: shared.gauges.swap_total,
        disk_total_bytes: shared.gauges.disk_total,
        points,
        services: shared.services.clone(),
        services_observed_at_ms: shared.services_at_ms,
    }
}

/// Details view: one range of charted history plus service health.
pub(crate) async fn history(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<RangeQuery>, QueryRejection>,
) -> Result<Json<HostMetricsHistory>, Error> {
    owner(&state, &headers).await?;
    let range = query
        .ok()
        .and_then(|Query(q)| HostMetricsRange::parse(&q.range))
        .ok_or(Error(
            StatusCode::BAD_REQUEST,
            "invalid_range",
            "Range must be 15m, 1h, 24h or 7d",
        ))?;
    Ok(Json(history_of(&shared(), range, now_ms())))
}

/// Top consumers by CPU and memory, with conversation names for the owner.
pub(crate) async fn consumers_read(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HostConsumers>, Error> {
    owner(&state, &headers).await?;
    let (mut consumers, observed_at_ms, cores) = {
        let shared = shared();
        (
            shared.consumers.clone(),
            shared.consumers_at_ms,
            shared.cores,
        )
    };
    if consumers.iter().any(|c| c.conversation_id.is_some()) {
        if let Ok(credential) = crate::browser::credential(&headers) {
            if let Ok(page) = state
                .store
                .conversations_authenticated(
                    &credential,
                    0,
                    orkestr_v2_contracts::LIVE_MAP_MAX_CONVERSATIONS as u32,
                )
                .await
            {
                for consumer in &mut consumers {
                    if let Some(found) = page
                        .conversations
                        .iter()
                        .find(|c| Some(c.conversation_id.to_string()) == consumer.conversation_id)
                    {
                        consumer.label = found.name.clone();
                    }
                }
            }
        }
    }
    Ok(Json(HostConsumers {
        schema_version: 1,
        collecting: observed_at_ms.is_none(),
        observed_at_ms,
        interval_ms: consumers::SAMPLE_EVERY.as_millis() as u64,
        cores,
        consumers,
    }))
}

/// Filesystems and the largest directories on `/`.
pub(crate) async fn disks_read(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HostDisks>, Error> {
    owner(&state, &headers).await?;
    let (mounts, directories) = {
        let shared = shared();
        (shared.mounts.clone(), shared.directories.clone())
    };
    Ok(Json(HostDisks {
        schema_version: 1,
        mounts,
        directories: directories.unwrap_or_else(disks::empty_directories),
    }))
}
