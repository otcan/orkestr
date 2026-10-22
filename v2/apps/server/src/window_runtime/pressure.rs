//! Live host pressure for window admission. A new window opens when the host
//! has room, measured by Linux PSI (CPU and memory stall time) and available
//! memory, not by a fixed slot count. The configured count stays only as a
//! high safety backstop. Owner (interactive) input tolerates more pressure
//! than timers and other background work, so it goes first on a busy host.
//!
//! Reading never fails admission: an unreadable /proc admits (the backstop
//! still applies), so a container without PSI behaves like before.
use orkestr_v2_contracts::{HostBusyReason, WindowHostAdmission};
use std::path::PathBuf;

/// Who is asking for a new window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Priority {
    /// An owner message (web UI or WhatsApp) the owner is waiting for.
    Interactive,
    /// Timer occurrences and other scheduled work.
    Background,
}
impl Priority {
    /// Timer windows are queued by Core with these keys (`timer-window:` for
    /// the window intent, `timer:` for the occurrence's input message).
    pub(crate) fn of(request_key: &str, input_request_key: &str) -> Self {
        if request_key.starts_with("timer-window:") || input_request_key.starts_with("timer:") {
            Priority::Background
        } else {
            Priority::Interactive
        }
    }
}

/// Admission thresholds per priority. CPU uses avg60 so a window's own
/// start-up burst does not flap admission; memory uses avg10 because memory
/// stalls escalate quickly.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Thresholds {
    pub(crate) cpu_some_avg60: f64,
    pub(crate) memory_some_avg10: f64,
    pub(crate) memory_available_bytes: u64,
}
const GIB: u64 = 1024 * 1024 * 1024;
pub(crate) const BACKGROUND: Thresholds = Thresholds {
    cpu_some_avg60: 40.0,
    memory_some_avg10: 10.0,
    memory_available_bytes: 4 * GIB,
};
pub(crate) const INTERACTIVE: Thresholds = Thresholds {
    cpu_some_avg60: 75.0,
    memory_some_avg10: 25.0,
    memory_available_bytes: 2 * GIB,
};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct HostPressure {
    pub(crate) cpu_some_avg10: f64,
    pub(crate) cpu_some_avg60: f64,
    pub(crate) memory_some_avg10: f64,
    pub(crate) memory_available_bytes: Option<u64>,
}
impl HostPressure {
    /// Why a new window of this priority must wait now, if it must.
    pub(crate) fn busy(&self, priority: Priority) -> Option<HostBusyReason> {
        let limits = match priority {
            Priority::Interactive => INTERACTIVE,
            Priority::Background => BACKGROUND,
        };
        if self
            .memory_available_bytes
            .is_some_and(|bytes| bytes < limits.memory_available_bytes)
        {
            Some(HostBusyReason::MemoryLow)
        } else if self.memory_some_avg10 >= limits.memory_some_avg10 {
            Some(HostBusyReason::MemoryPressure)
        } else if self.cpu_some_avg60 >= limits.cpu_some_avg60 {
            Some(HostBusyReason::CpuPressure)
        } else {
            None
        }
    }

    pub(crate) fn view(&self, max_window_ms: i64) -> WindowHostAdmission {
        let pct = |value: f64| value.clamp(0.0, 100.0).round() as u32;
        WindowHostAdmission {
            cpu_pressure_pct: pct(self.cpu_some_avg60),
            memory_pressure_pct: pct(self.memory_some_avg10),
            memory_available_mib: self.memory_available_bytes.unwrap_or(0) / (1024 * 1024),
            interactive_wait: self.busy(Priority::Interactive),
            background_wait: self.busy(Priority::Background),
            max_window_ms,
        }
    }
}

/// Where the gauges live; tests point this at a fixture directory.
/// Unit tests of the window runtime see a calm host unless they opt in.
#[derive(Clone, Debug)]
pub(crate) struct Source {
    proc_root: Option<PathBuf>,
}
impl Default for Source {
    fn default() -> Self {
        Self {
            proc_root: (!cfg!(test)).then(|| PathBuf::from("/proc")),
        }
    }
}
impl Source {
    #[cfg(test)]
    pub(crate) fn at(proc_root: &std::path::Path) -> Self {
        Self {
            proc_root: Some(proc_root.to_path_buf()),
        }
    }

    /// Best effort: anything unreadable reads as no pressure.
    pub(crate) fn read(&self) -> HostPressure {
        let Some(root) = &self.proc_root else {
            return HostPressure::default();
        };
        let file = |name: &str| std::fs::read_to_string(root.join(name)).ok();
        let cpu = file("pressure/cpu");
        let memory = file("pressure/memory");
        HostPressure {
            cpu_some_avg10: cpu.as_deref().and_then(|t| psi(t, "avg10")).unwrap_or(0.0),
            cpu_some_avg60: cpu.as_deref().and_then(|t| psi(t, "avg60")).unwrap_or(0.0),
            memory_some_avg10: memory
                .as_deref()
                .and_then(|t| psi(t, "avg10"))
                .unwrap_or(0.0),
            memory_available_bytes: file("meminfo").as_deref().and_then(available),
        }
    }
}

/// The `some` line's average, e.g. `some avg10=26.97 avg60=23.76 ...`.
fn psi(text: &str, field: &str) -> Option<f64> {
    let line = text.lines().find(|line| line.starts_with("some "))?;
    let prefix = format!("{field}=");
    let value: f64 = line
        .split_whitespace()
        .find_map(|part| part.strip_prefix(prefix.as_str()))?
        .parse()
        .ok()?;
    (value.is_finite() && value >= 0.0).then_some(value)
}

fn available(text: &str) -> Option<u64> {
    let line = text
        .lines()
        .find(|line| line.starts_with("MemAvailable:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    kib.checked_mul(1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(cpu60: f64, mem10: f64, available_gib: u64) -> HostPressure {
        HostPressure {
            cpu_some_avg10: cpu60,
            cpu_some_avg60: cpu60,
            memory_some_avg10: mem10,
            memory_available_bytes: Some(available_gib * GIB),
        }
    }

    #[test]
    fn owner_input_tolerates_more_pressure_than_timers() {
        let calm = host(10.0, 0.0, 38);
        assert_eq!(calm.busy(Priority::Interactive), None);
        assert_eq!(calm.busy(Priority::Background), None);
        let busy_cpu = host(55.0, 0.0, 38);
        assert_eq!(busy_cpu.busy(Priority::Interactive), None);
        assert_eq!(
            busy_cpu.busy(Priority::Background),
            Some(HostBusyReason::CpuPressure)
        );
        let saturated = host(80.0, 0.0, 38);
        assert_eq!(
            saturated.busy(Priority::Interactive),
            Some(HostBusyReason::CpuPressure)
        );
        assert_eq!(
            host(10.0, 0.0, 3).busy(Priority::Background),
            Some(HostBusyReason::MemoryLow)
        );
        assert_eq!(host(10.0, 0.0, 3).busy(Priority::Interactive), None);
        assert_eq!(
            host(10.0, 0.0, 1).busy(Priority::Interactive),
            Some(HostBusyReason::MemoryLow)
        );
        assert_eq!(
            host(10.0, 30.0, 38).busy(Priority::Interactive),
            Some(HostBusyReason::MemoryPressure)
        );
    }

    #[test]
    fn timer_keys_are_background_everything_else_interactive() {
        assert_eq!(
            Priority::of("timer-window:abc", "timer:claim"),
            Priority::Background
        );
        assert_eq!(
            Priority::of("window:x", "timer:claim"),
            Priority::Background
        );
        assert_eq!(Priority::of("window:x", "ui-1"), Priority::Interactive);
        assert_eq!(Priority::of("abc", "wa-1"), Priority::Interactive);
    }

    #[test]
    fn reads_linux_psi_and_meminfo_and_tolerates_missing_files() {
        let root = std::env::temp_dir().join(format!("pressure-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("pressure")).unwrap();
        std::fs::write(
            root.join("pressure/cpu"),
            "some avg10=26.97 avg60=63.76 avg300=19.84 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
        )
        .unwrap();
        std::fs::write(
            root.join("pressure/memory"),
            "some avg10=0.68 avg60=0.45 avg300=0.43 total=1\nfull avg10=0.00 avg60=0.16 avg300=0.20 total=1\n",
        )
        .unwrap();
        std::fs::write(
            root.join("meminfo"),
            "MemTotal:       65000000 kB\nMemAvailable:   41627040 kB\n",
        )
        .unwrap();
        let read = Source::at(&root).read();
        assert_eq!(read.cpu_some_avg60, 63.76);
        assert_eq!(read.memory_some_avg10, 0.68);
        assert_eq!(read.memory_available_bytes, Some(41_627_040 * 1024));
        let view = read.view(14_400_000);
        assert_eq!(view.cpu_pressure_pct, 64);
        assert_eq!(view.memory_available_mib, 40_651);
        assert_eq!(view.background_wait, Some(HostBusyReason::CpuPressure));
        assert_eq!(view.interactive_wait, None);
        assert!(view.is_valid());
        std::fs::remove_dir_all(&root).unwrap();
        let missing = Source::at(&root).read();
        assert_eq!(missing, HostPressure::default());
        assert_eq!(missing.busy(Priority::Background), None);
    }
}
