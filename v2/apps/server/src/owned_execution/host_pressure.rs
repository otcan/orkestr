//! Live host headroom for extra concurrent Fast slots. Reads the host
//! governor's world-readable state file (rewritten every 15 s tick) while it
//! is fresh, else the same kernel signals. Unknown means no headroom: Fast
//! then stays at its single canonical lineage.
//!
//! One more extra slot starts only when the reading shows all of:
//! 1. the governor gate is closed (cpu some avg60 <= 40 %, memory some avg10
//!    <= 10 %, MemAvailable >= 4 GiB);
//! 2. no sustained memory stall: memory some avg60 <= 2 % and full avg10
//!    <= 1 %;
//! 3. projected headroom: MemAvailable - (active extra slots + 1) x measured
//!    slot peak RSS >= reserve, reserve = max(4 GiB, 10 % of RAM);
//! 4. no thrashing: swap-in <= 1 MiB/s averaged over two readings;
//! 5. swap only as an OOM backstop: MemAvailable + SwapFree covers the
//!    reserve plus the projected use.
//!
//! Swap *used* is never a signal by itself: cold pages parked in swap are
//! history, not demand. The limit scales with live demand, not a slot count.
//!
//! Admission is paced: one window starts at most one extra slot per
//! reading (the next reading shows the load that start added), and the
//! whole host starts at most one extra slot per `HOST_START_INTERVAL`.
use std::collections::VecDeque;
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
// Sustained stall: slow-building pressure that avg10 misses.
const MEMORY_SOME_AVG60: f64 = 2.0;
const MEMORY_FULL_AVG10: f64 = 1.0;
/// Reserve kept free after the projected slots: max(4 GiB, 10 % of RAM).
const RESERVE_MIN_BYTES: u64 = 4 << 30;
const RESERVE_RAM_PERCENT: u64 = 10;
const SWAP_IN_BYTES_PER_SEC: f64 = (1 << 20) as f64;
/// Two swap-in readings further apart than this are not one average.
const SWAP_IN_PAIR_GAP: Duration = Duration::from_secs(60);
const PAGE_BYTES: f64 = 4096.0;
/// Slot cost until a Fast native's peak RSS was measured.
pub(super) const DEFAULT_SLOT_COST: u64 = 512 << 20;
/// Recent measured Fast natives the slot cost is the peak of.
const SLOT_COST_SAMPLES: usize = 8;

/// Identity of one host reading.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Reading {
    Governor(SystemTime),
    Kernel(Instant),
}

/// The signals of one reading, from the governor or the kernel.
#[derive(Clone, Copy, PartialEq, Debug)]
struct Sample {
    /// The governor's own verdict; the kernel fallback has none.
    gate_open: bool,
    cpu_some_avg60: f64,
    memory_some_avg10: f64,
    memory_some_avg60: f64,
    memory_full_avg10: f64,
    mem_total: u64,
    mem_available: u64,
    swap_free: u64,
    /// This reading's swap-in rate; `None` before a kernel rate exists.
    swap_in_bps: Option<f64>,
}

pub(super) struct HostPressure {
    governor: PathBuf,
    proc_root: PathBuf,
    /// Last governor reading, re-parsed only when the file changes.
    governor_seen: Option<(SystemTime, Sample)>,
    /// Last kernel reading and its swap-in counter (pages, sampled at).
    kernel: Option<(Instant, Option<Sample>)>,
    swap_in: Option<(Instant, u64)>,
    /// Swap-in rates of the last two distinct readings, with when seen.
    swap_history: VecDeque<(Reading, Instant, f64)>,
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
            governor_seen: None,
            kernel: None,
            swap_in: None,
            swap_history: VecDeque::new(),
            used: None,
        }
    }

    /// Record the current reading (cheap while it is unchanged) so the
    /// swap-in average is warm before a burst needs it.
    pub(super) fn observe(&mut self) {
        let _ = self.reading();
    }

    /// True when this window may start ONE more extra slot now, with
    /// `active` extra slots already live: the current reading shows headroom
    /// for one more, this window has not started a slot on it yet, and the
    /// host-wide start interval has passed. Consumes the reading.
    pub(super) fn admit_one(&mut self, active: usize) -> bool {
        self.admit_with(active, slot_cost(), host_start)
    }

    /// The same rule for one more read-only parallel Deep slot, projected
    /// with the measured Deep slot cost (heavier than Fast).
    pub(super) fn admit_one_deep(&mut self, active: usize) -> bool {
        self.admit_with(
            active,
            DEEP_SLOT_COST.current_or(DEFAULT_DEEP_SLOT_COST),
            host_start,
        )
    }

    fn admit_with(
        &mut self,
        active: usize,
        slot_cost: u64,
        host_start: impl FnOnce() -> bool,
    ) -> bool {
        let Some((reading, Some(sample))) = self.reading() else {
            return false;
        };
        let Some(swap_in) = self.swap_in_average() else {
            return false;
        };
        if !headroom(&sample, swap_in, active, slot_cost)
            || self.used == Some(reading)
            || !host_start()
        {
            return false;
        }
        self.used = Some(reading);
        true
    }

    /// The current reading; its sample is `None` when its signals are
    /// incomplete. Each new reading's swap-in rate joins the history.
    fn reading(&mut self) -> Option<(Reading, Option<Sample>)> {
        let now = Instant::now();
        let (reading, sample) = if let Some((modified, sample)) = self.governor_reading() {
            (Reading::Governor(modified), Some(sample))
        } else {
            match self.kernel {
                Some((at, sample)) if now.duration_since(at) < KERNEL_READING => {
                    (Reading::Kernel(at), sample)
                }
                _ => {
                    let sample = self.kernel_sample(now);
                    self.kernel = Some((now, sample));
                    (Reading::Kernel(now), sample)
                }
            }
        };
        self.remember_swap_in(reading, now, sample.and_then(|s| s.swap_in_bps));
        Some((reading, sample))
    }

    fn remember_swap_in(&mut self, reading: Reading, now: Instant, rate: Option<f64>) {
        if self
            .swap_history
            .back()
            .is_some_and(|(seen, _, _)| *seen == reading)
        {
            return;
        }
        match rate {
            Some(rate) => {
                self.swap_history.push_back((reading, now, rate));
                while self.swap_history.len() > 2 {
                    self.swap_history.pop_front();
                }
            }
            // A reading without a rate breaks the pair: fail closed.
            None => self.swap_history.clear(),
        }
    }

    /// Mean swap-in of the last two readings; `None` until two close
    /// readings exist.
    fn swap_in_average(&self) -> Option<f64> {
        if self.swap_history.len() < 2 {
            return None;
        }
        let (_, before, a) = self.swap_history.front()?;
        let (_, after, b) = self.swap_history.back()?;
        if after.duration_since(*before) > SWAP_IN_PAIR_GAP {
            return None;
        }
        Some((a + b) / 2.0)
    }

    fn governor_reading(&mut self) -> Option<(SystemTime, Sample)> {
        let modified = governor_fresh(&self.governor, SystemTime::now())?;
        if let Some((seen, sample)) = self.governor_seen {
            if seen == modified {
                return Some((seen, sample));
            }
        }
        let sample = governor_sample(&self.governor)?;
        self.governor_seen = Some((modified, sample));
        Some((modified, sample))
    }

    fn kernel_sample(&mut self, now: Instant) -> Option<Sample> {
        let cpu = psi(&self.proc_root, "cpu", "some", "avg60")?;
        let memory_some_avg10 = psi(&self.proc_root, "memory", "some", "avg10")?;
        let memory_some_avg60 = psi(&self.proc_root, "memory", "some", "avg60")?;
        let memory_full_avg10 = psi(&self.proc_root, "memory", "full", "avg10")?;
        let meminfo = std::fs::read_to_string(self.proc_root.join("meminfo")).ok()?;
        let mem_total = meminfo_bytes(&meminfo, "MemTotal:")?;
        let mem_available = meminfo_bytes(&meminfo, "MemAvailable:")?;
        let swap_free = meminfo_bytes(&meminfo, "SwapFree:")?;
        let vmstat = std::fs::read_to_string(self.proc_root.join("vmstat")).ok()?;
        let pages = vmstat
            .lines()
            .find_map(|line| line.strip_prefix("pswpin "))?
            .trim()
            .parse::<u64>()
            .ok()?;
        // A first counter sample has no rate yet; it never proves headroom.
        let swap_in_bps = self.swap_in.replace((now, pages)).and_then(|(at, before)| {
            let seconds = now.duration_since(at).as_secs_f64();
            (seconds > 0.0).then(|| pages.saturating_sub(before) as f64 * PAGE_BYTES / seconds)
        });
        Some(Sample {
            gate_open: false,
            cpu_some_avg60: cpu,
            memory_some_avg10,
            memory_some_avg60,
            memory_full_avg10,
            mem_total,
            mem_available,
            swap_free,
            swap_in_bps,
        })
    }
}

/// The admission rule for one more extra slot with `active` already live.
fn headroom(sample: &Sample, swap_in_bps: f64, active: usize, slot_cost: u64) -> bool {
    let reserve = RESERVE_MIN_BYTES.max(sample.mem_total / 100 * RESERVE_RAM_PERCENT);
    let projected = (active as u64).saturating_add(1).saturating_mul(slot_cost);
    let gate_closed = !sample.gate_open
        && sample.cpu_some_avg60 <= CPU_SOME_AVG60
        && sample.memory_some_avg10 <= MEMORY_SOME_AVG10
        && sample.mem_available >= MEM_AVAILABLE_BYTES;
    let no_stall = sample.memory_some_avg60 <= MEMORY_SOME_AVG60
        && sample.memory_full_avg10 <= MEMORY_FULL_AVG10;
    let fits = sample
        .mem_available
        .checked_sub(projected)
        .is_some_and(|left| left >= reserve);
    let no_thrash = swap_in_bps <= SWAP_IN_BYTES_PER_SEC;
    let backstop =
        sample.mem_available.saturating_add(sample.swap_free) >= reserve.saturating_add(projected);
    gate_closed && no_stall && fits && no_thrash && backstop
}

/// Measured cost of one Fast native: the peak of recent measured peaks.
pub(super) struct SlotCost(Mutex<VecDeque<u64>>);
static SLOT_COST: SlotCost = SlotCost::new();

impl SlotCost {
    const fn new() -> Self {
        Self(Mutex::new(VecDeque::new()))
    }
    fn record(&self, peak: u64) {
        if peak == 0 {
            return;
        }
        if let Ok(mut peaks) = self.0.lock() {
            peaks.push_back(peak);
            while peaks.len() > SLOT_COST_SAMPLES {
                peaks.pop_front();
            }
        }
    }
    fn current(&self) -> u64 {
        self.current_or(DEFAULT_SLOT_COST)
    }
    fn current_or(&self, default: u64) -> u64 {
        self.0
            .lock()
            .ok()
            .and_then(|peaks| peaks.iter().copied().max())
            .unwrap_or(default)
    }
}

/// Measured cost of one read-only parallel Deep native. Until measured: 1 GiB,
/// about twice the 431-493 MiB tree peaks read on the pilot host (2026-10-27).
pub(super) const DEFAULT_DEEP_SLOT_COST: u64 = 1 << 30;
static DEEP_SLOT_COST: SlotCost = SlotCost::new();

/// One finished parallel Deep native's measured peak RSS (its whole tree).
pub(super) fn record_deep_slot_peak(peak: u64) {
    DEEP_SLOT_COST.record(peak);
}

/// One finished Fast native's measured peak RSS (bytes, its whole tree).
pub(super) fn record_slot_peak(peak: u64) {
    SLOT_COST.record(peak);
}

fn slot_cost() -> u64 {
    SLOT_COST.current()
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

/// The governor file's modification time while it is a fresh reading.
fn governor_fresh(path: &Path, now: SystemTime) -> Option<SystemTime> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_STATE_BYTES {
        return None;
    }
    let modified = meta.modified().ok()?;
    if now.duration_since(modified).ok()? > GOVERNOR_FRESH {
        return None;
    }
    Some(modified)
}

/// One governor reading's signals; any missing field is no reading.
fn governor_sample(path: &Path) -> Option<Sample> {
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if value.get("version")?.as_i64()? != 1 {
        return None;
    }
    let field = |path: &[&str]| -> Option<&serde_json::Value> {
        path.iter().try_fold(&value, |node, key| node.get(key))
    };
    let number = |path: &[&str]| field(path)?.as_f64();
    let bytes = |path: &[&str]| field(path)?.as_u64();
    let swap_total = bytes(&["memory", "swap_total"])?;
    let swap_used = bytes(&["memory", "swap_used"])?;
    Some(Sample {
        gate_open: field(&["gate", "open"])?.as_bool()?,
        cpu_some_avg60: number(&["pressure", "cpu", "some", "avg60"])?,
        memory_some_avg10: number(&["pressure", "memory", "some", "avg10"])?,
        memory_some_avg60: number(&["pressure", "memory", "some", "avg60"])?,
        memory_full_avg10: number(&["pressure", "memory", "full", "avg10"])?,
        mem_total: bytes(&["memory", "total"])?,
        mem_available: bytes(&["memory", "available"])?,
        swap_free: swap_total.saturating_sub(swap_used),
        swap_in_bps: Some(number(&["memory", "swap_in_bps"])?),
    })
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

fn psi(proc_root: &Path, resource: &str, kind: &str, window: &str) -> Option<f64> {
    let text = std::fs::read_to_string(proc_root.join("pressure").join(resource)).ok()?;
    let line = text
        .lines()
        .find(|line| line.split_whitespace().next() == Some(kind))?;
    line.split_whitespace()
        .find_map(|field| field.strip_prefix(window)?.strip_prefix('='))?
        .parse()
        .ok()
}

#[cfg(test)]
#[path = "host_pressure_tests.rs"]
mod tests;
