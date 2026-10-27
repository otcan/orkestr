//! Live host headroom for extra concurrent Fast slots. Reuses the host
//! governor's pressure gate (`gate.open` in its world-readable state file,
//! rewritten every 15 s tick) plus a swap floor. Without a fresh governor
//! sample, the same kernel signals and default thresholds decide. Unknown
//! means no headroom: Fast then stays at its single canonical lineage.
//!
//! Admission is paced: one window starts at most one extra slot per
//! governor reading (the next reading shows the load that start added), and
//! the whole host starts at most one extra slot per `HOST_START_INTERVAL`.
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

const GOVERNOR_STATE: &str = "/var/lib/orkestr-governor/state.json";
/// The governor ticks every 15 s; four missed ticks is no live signal.
const GOVERNOR_FRESH: Duration = Duration::from_secs(60);
const MAX_STATE_BYTES: u64 = 4 << 20;
/// Kernel fallback: one reading per this interval.
const KERNEL_READING: Duration = Duration::from_secs(15);
const HOST_START_INTERVAL: Duration = Duration::from_secs(1);
static HOST_LAST_START: Mutex<Option<Instant>> = Mutex::new(None);
// The governor's default gate: cpu some avg60 > 40 %, memory some avg10
// > 10 % or MemAvailable < 4 GiB opens it (pressure).
const CPU_SOME_AVG60: f64 = 40.0;
const MEMORY_SOME_AVG10: f64 = 10.0;
const MEM_AVAILABLE_BYTES: u64 = 4 << 30;
// Swap floor: a host with swap is pressured below 8 GiB free swap or while
// it swaps in faster than 1 MiB/s.
const SWAP_FREE_BYTES: u64 = 8 << 30;
const SWAP_IN_BYTES_PER_SEC: f64 = (1 << 20) as f64;
const PAGE_BYTES: f64 = 4096.0;

/// One host reading: whether it shows headroom, and its identity.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Reading {
    Governor(SystemTime),
    Kernel(Instant),
}

pub(super) struct HostPressure {
    governor: PathBuf,
    proc_root: PathBuf,
    /// Last kernel reading and its swap-in counter (pages, sampled at).
    kernel: Option<(Instant, bool)>,
    swap_in: Option<(Instant, u64)>,
    /// The reading this window last started a slot on.
    used: Option<Reading>,
}

impl HostPressure {
    pub(super) fn new() -> Self {
        Self::at(Path::new(GOVERNOR_STATE), Path::new("/proc"))
    }

    fn at(governor: &Path, proc_root: &Path) -> Self {
        Self {
            governor: governor.to_path_buf(),
            proc_root: proc_root.to_path_buf(),
            kernel: None,
            swap_in: None,
            used: None,
        }
    }

    /// True when this window may start ONE more extra slot now: the current
    /// reading shows headroom, this window has not started a slot on it yet,
    /// and the host-wide start interval has passed. Consumes the reading.
    pub(super) fn admit_one(&mut self) -> bool {
        self.admit_with(host_start)
    }

    fn admit_with(&mut self, host_start: impl FnOnce() -> bool) -> bool {
        let Some((reading, headroom)) = self.reading() else {
            return false;
        };
        if !headroom || self.used == Some(reading) || !host_start() {
            return false;
        }
        self.used = Some(reading);
        true
    }

    fn reading(&mut self) -> Option<(Reading, bool)> {
        if let Some((modified, pressure)) = governor_pressure(&self.governor, SystemTime::now()) {
            return Some((Reading::Governor(modified), !pressure));
        }
        let now = Instant::now();
        if let Some((at, headroom)) = self.kernel {
            if now.duration_since(at) < KERNEL_READING {
                return Some((Reading::Kernel(at), headroom));
            }
        }
        let headroom = self.kernel_headroom(now).unwrap_or(false);
        self.kernel = Some((now, headroom));
        Some((Reading::Kernel(now), headroom))
    }

    fn kernel_headroom(&mut self, now: Instant) -> Option<bool> {
        let cpu = psi(&self.proc_root, "cpu", "avg60")?;
        let memory = psi(&self.proc_root, "memory", "avg10")?;
        let meminfo = std::fs::read_to_string(self.proc_root.join("meminfo")).ok()?;
        let available = meminfo_bytes(&meminfo, "MemAvailable:")?;
        let swap_total = meminfo_bytes(&meminfo, "SwapTotal:")?;
        let swap_free = meminfo_bytes(&meminfo, "SwapFree:")?;
        let vmstat = std::fs::read_to_string(self.proc_root.join("vmstat")).ok()?;
        let pages = vmstat
            .lines()
            .find_map(|line| line.strip_prefix("pswpin "))?
            .trim()
            .parse::<u64>()
            .ok()?;
        // A first sample has no rate yet; it never proves headroom.
        let rate = self
            .swap_in
            .replace((now, pages))
            .and_then(|(at, before)| {
                let seconds = now.duration_since(at).as_secs_f64();
                (seconds > 0.0).then(|| pages.saturating_sub(before) as f64 * PAGE_BYTES / seconds)
            })?;
        Some(
            cpu <= CPU_SOME_AVG60
                && memory <= MEMORY_SOME_AVG10
                && available >= MEM_AVAILABLE_BYTES
                && !swap_pressure(swap_total, swap_free, rate),
        )
    }
}

fn swap_pressure(total: u64, free: u64, swap_in_bytes_per_sec: f64) -> bool {
    total > 0 && (free < SWAP_FREE_BYTES || swap_in_bytes_per_sec > SWAP_IN_BYTES_PER_SEC)
}

/// Host-wide pacing of extra slot starts across all windows.
fn host_start() -> bool {
    let Ok(mut last) = HOST_LAST_START.lock() else {
        return false;
    };
    let now = Instant::now();
    if last.is_some_and(|at| now.duration_since(at) < HOST_START_INTERVAL) {
        return false;
    }
    *last = Some(now);
    true
}

/// `Some((reading, true))` while the governor reports pressure: its gate is
/// open or its swap sample is under the floor.
fn governor_pressure(path: &Path, now: SystemTime) -> Option<(SystemTime, bool)> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_STATE_BYTES {
        return None;
    }
    let modified = meta.modified().ok()?;
    if now.duration_since(modified).ok()? > GOVERNOR_FRESH {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if value.get("version")?.as_i64()? != 1 {
        return None;
    }
    let gate = value.get("gate")?.get("open")?.as_bool()?;
    let memory = value.get("memory")?;
    let total = memory.get("swap_total")?.as_u64()?;
    let used = memory.get("swap_used")?.as_u64()?;
    let swap_in = memory.get("swap_in_bps")?.as_f64()?;
    let swap = swap_pressure(total, total.saturating_sub(used), swap_in);
    Some((modified, gate || swap))
}

fn meminfo_bytes(meminfo: &str, key: &str) -> Option<u64> {
    meminfo
        .lines()
        .find_map(|line| line.strip_prefix(key))?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?
        .checked_mul(1024)
}

fn psi(proc_root: &Path, resource: &str, window: &str) -> Option<f64> {
    let text = std::fs::read_to_string(proc_root.join("pressure").join(resource)).ok()?;
    let line = text.lines().find(|line| line.starts_with("some "))?;
    line.split_whitespace()
        .find_map(|field| field.strip_prefix(window)?.strip_prefix('='))?
        .parse()
        .ok()
}

#[cfg(test)]
#[path = "host_pressure_tests.rs"]
mod tests;
