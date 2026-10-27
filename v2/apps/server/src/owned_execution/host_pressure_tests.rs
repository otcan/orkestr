use super::*;

struct Root(PathBuf);

/// One governor state file; defaults are the live host of 2026-10-27:
/// 62.7 GiB RAM, 42.6 GiB available, PSI memory 0, ~28 of 34.3 GB swap used
/// (cold), ~45 KB/s swap-in.
#[derive(Clone, Copy)]
struct Governor {
    open: bool,
    cpu_some_avg60: f64,
    memory_some_avg10: f64,
    memory_some_avg60: f64,
    memory_full_avg10: f64,
    total: u64,
    available: u64,
    swap_total: u64,
    swap_used: u64,
    swap_in_bps: u64,
}
const LIVE_HOST: Governor = Governor {
    open: false,
    cpu_some_avg60: 22.98,
    memory_some_avg10: 0.0,
    memory_some_avg60: 0.08,
    memory_full_avg10: 0.0,
    total: 67_274_629_120,
    available: 45_741_903_872,
    swap_total: 34_325_131_264,
    swap_used: 28_269_580_288,
    swap_in_bps: 44_253,
};

impl Root {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("fast-pressure-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("proc/pressure")).unwrap();
        Self(root)
    }
    fn kernel(&self, cpu: f64, memory: f64, available_kib: u64, swap_free_kib: u64, pswpin: u64) {
        self.kernel_stall(cpu, memory, 0.0, 0.0, available_kib, swap_free_kib, pswpin)
    }
    #[allow(clippy::too_many_arguments)]
    fn kernel_stall(
        &self,
        cpu: f64,
        memory: f64,
        memory_avg60: f64,
        memory_full: f64,
        available_kib: u64,
        swap_free_kib: u64,
        pswpin: u64,
    ) {
        let proc = self.0.join("proc");
        std::fs::write(
            proc.join("pressure/cpu"),
            format!("some avg10=0.00 avg60={cpu:.2} avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"),
        )
        .unwrap();
        std::fs::write(
            proc.join("pressure/memory"),
            format!("some avg10={memory:.2} avg60={memory_avg60:.2} avg300=0.00 total=1\nfull avg10={memory_full:.2} avg60=0.00 avg300=0.00 total=1\n"),
        )
        .unwrap();
        std::fs::write(
            proc.join("meminfo"),
            format!("MemTotal: 67108864 kB\nMemAvailable: {available_kib} kB\nSwapTotal: 33554432 kB\nSwapFree: {swap_free_kib} kB\n"),
        )
        .unwrap();
        std::fs::write(proc.join("vmstat"), format!("pswpin {pswpin}\npswpout 0\n")).unwrap();
    }
    fn governor(&self, g: Governor) {
        // A distinct modification time per write, so each is a new reading.
        std::thread::sleep(Duration::from_millis(15));
        std::fs::write(
            self.0.join("state.json"),
            format!(
                r#"{{"version":1,"gate":{{"open":{},"reasons":[]}},"pressure":{{"cpu":{{"some":{{"avg10":0.0,"avg60":{},"avg300":0.0}}}},"memory":{{"some":{{"avg10":{},"avg60":{},"avg300":0.0}},"full":{{"avg10":{},"avg60":0.0,"avg300":0.0}}}}}},"memory":{{"total":{},"available":{},"swap_total":{},"swap_used":{},"swap_in_bps":{}}}}}"#,
                g.open,
                g.cpu_some_avg60,
                g.memory_some_avg10,
                g.memory_some_avg60,
                g.memory_full_avg10,
                g.total,
                g.available,
                g.swap_total,
                g.swap_used,
                g.swap_in_bps
            ),
        )
        .unwrap();
    }
    fn state(&self) -> PathBuf {
        self.0.join("state.json")
    }
    fn pressure(&self) -> HostPressure {
        HostPressure::at(&self.state(), &self.0.join("proc"))
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const GIB: u64 = 1 << 30;
const MIB: u64 = 1 << 20;

/// Headroom for one more slot (with `active` live) after two readings of `g`.
fn admits(g: Governor, active: usize, cost: u64) -> bool {
    let root = Root::new();
    let mut pressure = root.pressure();
    root.governor(g);
    pressure.observe();
    root.governor(g);
    pressure.admit_with(active, cost, || true)
}

#[test]
fn live_host_with_cold_swap_has_headroom() {
    // 26 GiB of cold swap used and 5.8 GiB free swap, but 42.6 GiB available,
    // PSI 0 and ~45 KB/s swap-in: not pressure. Swap used is history.
    assert!(admits(LIVE_HOST, 0, DEFAULT_SLOT_COST));
    assert!(admits(LIVE_HOST, 7, DEFAULT_SLOT_COST));
    let root = Root::new();
    root.governor(LIVE_HOST);
    let sample = governor_sample(&root.state()).unwrap();
    assert!(!sample.gate_open);
    assert_eq!(sample.swap_free, 34_325_131_264 - 28_269_580_288);
}

#[test]
fn swap_in_above_one_mib_per_second_is_pressure() {
    let thrashing = Governor {
        swap_in_bps: 3 * MIB,
        ..LIVE_HOST
    };
    assert!(!admits(thrashing, 0, DEFAULT_SLOT_COST));
    // Averaged over two readings: one 1.5 MiB/s reading after a quiet one
    // stays under the limit, two above it do not.
    let root = Root::new();
    let mut pressure = root.pressure();
    root.governor(LIVE_HOST);
    pressure.observe();
    root.governor(Governor {
        swap_in_bps: 3 * MIB / 2,
        ..LIVE_HOST
    });
    assert!(pressure.admit_with(0, DEFAULT_SLOT_COST, || true));
    root.governor(Governor {
        swap_in_bps: 3 * MIB / 2,
        ..LIVE_HOST
    });
    assert!(!pressure.admit_with(0, DEFAULT_SLOT_COST, || true));
}

#[test]
fn governor_gate_and_sustained_stall_decide() {
    for pressured in [
        Governor {
            open: true,
            ..LIVE_HOST
        },
        Governor {
            cpu_some_avg60: 41.0,
            ..LIVE_HOST
        },
        Governor {
            memory_some_avg10: 11.0,
            ..LIVE_HOST
        },
        Governor {
            memory_some_avg60: 2.5,
            ..LIVE_HOST
        },
        Governor {
            memory_full_avg10: 1.5,
            ..LIVE_HOST
        },
        Governor {
            available: 3 * GIB,
            ..LIVE_HOST
        },
    ] {
        assert!(!admits(pressured, 0, DEFAULT_SLOT_COST));
    }
    // No swap at all is not swap pressure.
    assert!(admits(
        Governor {
            swap_total: 0,
            swap_used: 0,
            ..LIVE_HOST
        },
        0,
        DEFAULT_SLOT_COST
    ));
}

#[test]
fn projected_headroom_scales_with_live_slots_and_slot_cost() {
    // 64 GiB RAM: reserve is 10 % (6.4 GiB), above the 4 GiB floor.
    let g = Governor {
        total: 64 * GIB,
        available: 10 * GIB,
        ..LIVE_HOST
    };
    // 10 GiB - 7 x 512 MiB = 6.5 GiB >= 6.4 GiB; an eighth would not fit.
    assert!(admits(g, 6, DEFAULT_SLOT_COST));
    assert!(!admits(g, 7, DEFAULT_SLOT_COST));
    // Heavier measured natives admit fewer.
    assert!(admits(g, 1, GIB));
    assert!(!admits(g, 3, GIB));
    // A small host keeps the 4 GiB floor.
    let small = Governor {
        total: 16 * GIB,
        available: 5 * GIB,
        ..LIVE_HOST
    };
    assert!(admits(small, 1, DEFAULT_SLOT_COST));
    assert!(!admits(small, 2, DEFAULT_SLOT_COST));
}

#[test]
fn swap_is_only_an_oom_backstop() {
    // Projected use fits in RAM above the reserve: even with no free swap,
    // MemAvailable + SwapFree covers reserve + projected.
    let g = Governor {
        swap_used: LIVE_HOST.swap_total,
        ..LIVE_HOST
    };
    assert!(admits(g, 0, DEFAULT_SLOT_COST));
    let sample = Sample {
        gate_open: false,
        cpu_some_avg60: 0.0,
        memory_some_avg10: 0.0,
        memory_some_avg60: 0.0,
        memory_full_avg10: 0.0,
        mem_total: 16 * GIB,
        mem_available: 5 * GIB,
        swap_free: 0,
        swap_in_bps: Some(0.0),
    };
    assert!(headroom(&sample, 0.0, 1, DEFAULT_SLOT_COST));
    assert!(!headroom(&sample, 0.0, 2, DEFAULT_SLOT_COST));
    assert!(!headroom(&sample, 2.0 * MIB as f64, 0, DEFAULT_SLOT_COST));
}

#[test]
fn slot_cost_is_the_recent_measured_peak() {
    let cost = SlotCost::new();
    assert_eq!(cost.current(), DEFAULT_SLOT_COST);
    cost.record(0);
    assert_eq!(cost.current(), DEFAULT_SLOT_COST);
    cost.record(300 * MIB);
    assert_eq!(cost.current(), 300 * MIB);
    cost.record(700 * MIB);
    for _ in 0..SLOT_COST_SAMPLES - 1 {
        cost.record(200 * MIB);
    }
    assert_eq!(cost.current(), 700 * MIB);
    cost.record(200 * MIB);
    assert_eq!(cost.current(), 200 * MIB);
}

#[test]
fn stale_or_unknown_governor_is_no_reading() {
    let root = Root::new();
    root.governor(LIVE_HOST);
    assert!(governor_fresh(&root.state(), SystemTime::now()).is_some());
    let later = SystemTime::now() + GOVERNOR_FRESH + Duration::from_secs(1);
    assert_eq!(governor_fresh(&root.state(), later), None);
    std::fs::write(root.state(), b"{\"version\":2,\"gate\":{\"open\":false}}").unwrap();
    assert_eq!(governor_sample(&root.state()), None);
    // The old gate-only shape lacks the stall and memory signals.
    std::fs::write(
        root.state(),
        br#"{"version":1,"gate":{"open":false},"memory":{"swap_total":0,"swap_used":0,"swap_in_bps":0}}"#,
    )
    .unwrap();
    assert_eq!(governor_sample(&root.state()), None);
}

#[test]
fn one_slot_per_governor_reading_and_per_host_interval() {
    let root = Root::new();
    let mut pressure = root.pressure();
    root.governor(LIVE_HOST);
    // A single reading has no two-reading swap-in average yet.
    assert!(!pressure.admit_with(0, DEFAULT_SLOT_COST, || true));
    root.governor(LIVE_HOST);
    assert!(pressure.admit_with(0, DEFAULT_SLOT_COST, || true));
    // Same reading: no second start until the governor writes a new one.
    assert!(!pressure.admit_with(1, DEFAULT_SLOT_COST, || true));
    root.governor(LIVE_HOST);
    // The host-wide pacing can still refuse; the reading stays unused then.
    assert!(!pressure.admit_with(1, DEFAULT_SLOT_COST, || false));
    assert!(pressure.admit_with(1, DEFAULT_SLOT_COST, || true));
    let open = Governor {
        open: true,
        ..LIVE_HOST
    };
    root.governor(open);
    root.governor(open);
    assert!(!pressure.admit_with(2, DEFAULT_SLOT_COST, || true));
}

#[test]
fn host_wide_starts_are_paced() {
    // Only this test touches the process-wide pacer.
    assert!(host_start());
    assert!(!host_start());
}

#[test]
fn kernel_fallback_uses_the_same_rule_and_fails_closed() {
    let root = Root::new();
    // 64 GiB RAM, 40 GiB available, 4 GiB free swap (cold swap used).
    let healthy = |r: &Root, pages| r.kernel(10.0, 1.0, 40 << 20, 4 << 20, pages);
    healthy(&root, 100);
    let mut pressure = root.pressure();
    let t0 = Instant::now();
    // The first counter sample has no swap-in rate yet: never headroom.
    let first = pressure.kernel_sample(t0).unwrap();
    assert_eq!(first.swap_in_bps, None);
    healthy(&root, 100);
    let second = pressure
        .kernel_sample(t0 + Duration::from_secs(15))
        .unwrap();
    assert_eq!(second.swap_in_bps, Some(0.0));
    assert_eq!(second.mem_total, 64 * GIB);
    assert!(headroom(&second, 0.0, 0, DEFAULT_SLOT_COST));
    // Swapping in ~4 MiB/s.
    healthy(&root, 100 + 15 * 1024);
    let thrashing = pressure
        .kernel_sample(t0 + Duration::from_secs(30))
        .unwrap();
    assert!(thrashing.swap_in_bps.unwrap() > SWAP_IN_BYTES_PER_SEC);
    for (cpu, memory, avg60, full, available) in [
        (41.0, 1.0, 0.0, 0.0, 40 << 20),
        (10.0, 11.0, 0.0, 0.0, 40 << 20),
        (10.0, 1.0, 2.5, 0.0, 40 << 20),
        (10.0, 1.0, 0.0, 1.5, 40 << 20),
        (10.0, 1.0, 0.0, 0.0, 3 << 20),
    ] {
        root.kernel_stall(cpu, memory, avg60, full, available, 4 << 20, 100);
        let sample = root.pressure().kernel_sample(t0).unwrap();
        assert!(!headroom(&sample, 0.0, 0, DEFAULT_SLOT_COST));
    }
    std::fs::remove_file(root.0.join("proc/pressure/memory")).unwrap();
    assert_eq!(root.pressure().kernel_sample(t0), None);
    // No governor and no readable kernel state: no extra slot.
    assert!(!root.pressure().admit_with(0, DEFAULT_SLOT_COST, || true));
}
