//! Owner-only host metrics: a compact current summary with sparklines and a
//! ranged history for charts. Whole-host aggregates and request latency only;
//! no process, path, user or message data.
use serde::{Deserialize, Serialize};

/// Points in one sparkline of the summary.
pub const HOST_METRICS_SPARK_POINTS: usize = 60;
/// Most points one history response carries, whatever the range.
pub const HOST_METRICS_MAX_POINTS: usize = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostMetricsRange {
    #[serde(rename = "15m")]
    Minutes15,
    #[serde(rename = "1h")]
    Hour1,
    #[serde(rename = "24h")]
    Hours24,
    #[serde(rename = "7d")]
    Days7,
}

impl HostMetricsRange {
    pub const ALL: [Self; 4] = [Self::Minutes15, Self::Hour1, Self::Hours24, Self::Days7];
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|r| r.label() == value)
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Minutes15 => "15m",
            Self::Hour1 => "1h",
            Self::Hours24 => "24h",
            Self::Days7 => "7d",
        }
    }
    pub fn span_ms(self) -> i64 {
        match self {
            Self::Minutes15 => 15 * 60_000,
            Self::Hour1 => 60 * 60_000,
            Self::Hours24 => 24 * 3_600_000,
            Self::Days7 => 7 * 24 * 3_600_000,
        }
    }
    /// Width of one returned point (bucket).
    pub fn step_ms(self) -> i64 {
        match self {
            Self::Minutes15 => 5_000,
            Self::Hour1 => 10_000,
            Self::Hours24 => 5 * 60_000,
            Self::Days7 => 30 * 60_000,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostMetricsSummary {
    pub schema_version: u32,
    /// No sample yet (the sampler needs two CPU readings).
    pub collecting: bool,
    pub observed_at_ms: Option<i64>,
    pub interval_ms: u64,
    pub cores: u32,
    pub cpu_percent: Option<f32>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    /// Filesystem `/`: used and free for unprivileged users, like `df`.
    pub disk_used_bytes: Option<u64>,
    pub disk_free_bytes: Option<u64>,
    pub disk_total_bytes: Option<u64>,
    /// Oldest first, at most `HOST_METRICS_SPARK_POINTS`, percent 0..=100.
    pub spark_cpu: Vec<f32>,
    pub spark_memory: Vec<f32>,
    pub spark_disk: Vec<f32>,
    #[serde(default)]
    pub swap_used_bytes: Option<u64>,
    #[serde(default)]
    pub swap_total_bytes: Option<u64>,
    #[serde(default)]
    pub load: Option<(f32, f32, f32)>,
    /// Local filesystems (`/` first).
    #[serde(default)]
    pub mounts: Vec<HostMount>,
    /// Busy percent of each CPU thread (logical core) in the last sample.
    #[serde(default)]
    pub cpu_cores_percent: Vec<f32>,
    #[serde(default)]
    pub disk_read_bps: Option<f32>,
    #[serde(default)]
    pub disk_write_bps: Option<f32>,
    #[serde(default)]
    pub net_rx_bps: Option<f32>,
    #[serde(default)]
    pub net_tx_bps: Option<f32>,
}

/// One bucket of the history. Rates are per second; byte counts are averages
/// over the bucket. Request fields are `None` when no request was served.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostMetricsPoint {
    pub t_ms: i64,
    pub cpu: f32,
    pub cores: Vec<f32>,
    pub load1: f32,
    pub load5: f32,
    pub load15: f32,
    pub mem_used: u64,
    pub mem_cache: u64,
    pub swap_used: u64,
    pub disk_used: u64,
    pub disk_read_bps: f32,
    pub disk_write_bps: f32,
    pub net_rx_bps: f32,
    pub net_tx_bps: f32,
    pub req_rate: f32,
    pub req_p50_ms: Option<f32>,
    pub req_p95_ms: Option<f32>,
    pub req_error_rate: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    Active,
    Activating,
    Inactive,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceHealth {
    pub label: String,
    pub unit: String,
    pub state: ServiceState,
    pub sub_state: String,
    /// Last run result (`success`, `exit-code`, …); for timer jobs such as a probe.
    pub result: String,
    pub since_ms: Option<i64>,
    pub restarts: u32,
    /// Running, or a one-shot (timer) job whose last run succeeded.
    pub healthy: bool,
    /// A one-shot job (`Type=oneshot` or started by a timer): judged by its
    /// last run, not by being inactive between runs.
    #[serde(default)]
    pub oneshot: bool,
    /// End of the last run and its exit status (one-shot jobs).
    #[serde(default)]
    pub last_run_ms: Option<i64>,
    #[serde(default)]
    pub last_exit_status: Option<i32>,
    /// Whether the triggering timer is still scheduled, when there is one.
    #[serde(default)]
    pub timer_active: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostMetricsHistory {
    pub schema_version: u32,
    pub range: HostMetricsRange,
    pub step_ms: i64,
    pub collecting: bool,
    pub observed_at_ms: Option<i64>,
    /// Oldest sample still held for this range; earlier buckets are absent.
    pub history_from_ms: Option<i64>,
    pub cores: u32,
    pub memory_total_bytes: u64,
    pub swap_total_bytes: u64,
    pub disk_total_bytes: u64,
    pub points: Vec<HostMetricsPoint>,
    pub services: Vec<ServiceHealth>,
    pub services_observed_at_ms: Option<i64>,
}

impl HostMetricsHistory {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && self.points.len() <= HOST_METRICS_MAX_POINTS
            && self.points.windows(2).all(|w| w[0].t_ms < w[1].t_ms)
            && self.services.len() <= 32
    }
}

impl HostMetricsSummary {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && [&self.spark_cpu, &self.spark_memory, &self.spark_disk]
                .iter()
                .all(|s| s.len() <= HOST_METRICS_SPARK_POINTS)
    }
}

/// One mounted local filesystem, as `df` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostMount {
    pub mount: String,
    pub fs_type: String,
    pub device: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    /// Available to unprivileged users (df "Avail").
    pub free_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostDirectory {
    pub path: String,
    pub bytes: u64,
}

/// Largest directories on `/` (two levels), measured hourly at idle I/O
/// priority. Only what the service user can read is counted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostDirectories {
    pub observed_at_ms: Option<i64>,
    /// A measurement is running now.
    pub running: bool,
    /// Bytes under `/` the service user could read (compare with `used`).
    pub readable_bytes: u64,
    pub entries: Vec<HostDirectory>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostDisks {
    pub schema_version: u32,
    pub mounts: Vec<HostMount>,
    pub directories: HostDirectories,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsumerKind {
    /// Provider sessions and Workers of one V2 conversation.
    Conversation,
    /// Processes working in one workspace directory (V1 threads, tools).
    Workspace,
    Service,
    Container,
    Session,
    Other,
}

/// CPU, memory and I/O of one owner-meaningful group of processes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostConsumer {
    pub key: String,
    pub kind: ConsumerKind,
    pub label: String,
    /// For conversation groups: the V2 conversation, to link to.
    pub conversation_id: Option<String>,
    /// For conversation groups: running roles (`deep`, `fast`, `worker`).
    pub roles: Vec<String>,
    /// Share of the whole host (all cores), percent.
    pub cpu_percent: f32,
    /// Cores in use (100 % of one core = 1.0).
    pub cores: f32,
    /// Sum of resident memory of the group's processes.
    pub rss_bytes: u64,
    /// `None` when the kernel does not let the service user read it.
    pub io_read_bps: Option<f32>,
    pub io_write_bps: Option<f32>,
    pub processes: u32,
    /// Command name of the group's busiest process (e.g. `node`, `cargo`).
    #[serde(default)]
    pub top_command: Option<String>,
    /// Last samples, oldest first: CPU percent of host.
    pub spark_cpu: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostConsumers {
    pub schema_version: u32,
    pub collecting: bool,
    pub observed_at_ms: Option<i64>,
    pub interval_ms: u64,
    pub cores: u32,
    pub consumers: Vec<HostConsumer>,
}

impl HostConsumers {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && self.consumers.len() <= 64
            && self.consumers.iter().all(|c| {
                c.spark_cpu.len() <= HOST_METRICS_SPARK_POINTS && c.cpu_percent.is_finite()
            })
    }
}
