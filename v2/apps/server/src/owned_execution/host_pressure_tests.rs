use super::*;

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("fast-pressure-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("proc/pressure")).unwrap();
        Self(root)
    }
    fn kernel(&self, cpu: f64, memory: f64, available_kib: u64, swap_free_kib: u64, pswpin: u64) {
        let proc = self.0.join("proc");
        std::fs::write(
            proc.join("pressure/cpu"),
            format!("some avg10=0.00 avg60={cpu:.2} avg300=0.00 total=1\n"),
        )
        .unwrap();
        std::fs::write(
            proc.join("pressure/memory"),
            format!("some avg10={memory:.2} avg60=0.00 avg300=0.00 total=1\n"),
        )
        .unwrap();
        std::fs::write(
            proc.join("meminfo"),
            format!("MemTotal: 67108864 kB\nMemAvailable: {available_kib} kB\nSwapTotal: 33554432 kB\nSwapFree: {swap_free_kib} kB\n"),
        )
        .unwrap();
        std::fs::write(proc.join("vmstat"), format!("pswpin {pswpin}\npswpout 0\n")).unwrap();
    }
    fn governor(&self, open: bool, swap_total: u64, swap_used: u64, swap_in_bps: u64) {
        std::fs::write(
            self.0.join("state.json"),
            format!(
                r#"{{"version":1,"gate":{{"open":{open},"reasons":[]}},"memory":{{"swap_total":{swap_total},"swap_used":{swap_used},"swap_in_bps":{swap_in_bps}}}}}"#
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

#[test]
fn governor_gate_and_swap_floor_decide_while_fresh() {
    let root = Root::new();
    root.governor(true, 32 * GIB, 0, 0);
    assert!(
        governor_pressure(&root.state(), SystemTime::now())
            .unwrap()
            .1
    );
    root.governor(false, 32 * GIB, 0, 0);
    assert!(
        !governor_pressure(&root.state(), SystemTime::now())
            .unwrap()
            .1
    );
    // The live host shape: ~28 of 33.5 GB swap used is under the floor.
    root.governor(false, 33_500_000_000, 28_000_000_000, 0);
    assert!(
        governor_pressure(&root.state(), SystemTime::now())
            .unwrap()
            .1
    );
    root.governor(false, 32 * GIB, 0, 4 << 20);
    assert!(
        governor_pressure(&root.state(), SystemTime::now())
            .unwrap()
            .1
    );
    // No swap at all is not swap pressure.
    root.governor(false, 0, 0, 0);
    assert!(
        !governor_pressure(&root.state(), SystemTime::now())
            .unwrap()
            .1
    );
    let later = SystemTime::now() + GOVERNOR_FRESH + Duration::from_secs(1);
    assert_eq!(governor_pressure(&root.state(), later), None);
    std::fs::write(root.state(), b"{\"version\":2,\"gate\":{\"open\":false}}").unwrap();
    assert_eq!(governor_pressure(&root.state(), SystemTime::now()), None);
}

#[test]
fn one_slot_per_governor_reading_and_per_host_interval() {
    let root = Root::new();
    root.governor(false, 32 * GIB, 0, 0);
    let mut pressure = root.pressure();
    assert!(pressure.admit_with(|| true));
    // Same reading: no second start until the governor writes a new one.
    assert!(!pressure.admit_with(|| true));
    std::thread::sleep(Duration::from_millis(20));
    root.governor(false, 32 * GIB, 0, 0);
    // The host-wide pacing can still refuse; the reading stays unused then.
    assert!(!pressure.admit_with(|| false));
    assert!(pressure.admit_with(|| true));
    root.governor(true, 32 * GIB, 0, 0);
    std::thread::sleep(Duration::from_millis(20));
    root.governor(true, 32 * GIB, 0, 0);
    assert!(!pressure.admit_with(|| true));
}

#[test]
fn host_wide_starts_are_paced() {
    // Only this test touches the process-wide pacer.
    assert!(host_start());
    assert!(!host_start());
}

#[test]
fn kernel_fallback_uses_governor_thresholds_swap_floor_and_fails_closed() {
    let root = Root::new();
    let healthy = |r: &Root, pages| r.kernel(10.0, 1.0, 8 << 20, 16 << 20, pages);
    healthy(&root, 100);
    let mut pressure = root.pressure();
    let t0 = Instant::now();
    // The first sample has no swap-in rate yet: never headroom.
    assert_eq!(pressure.kernel_headroom(t0), None);
    healthy(&root, 100);
    assert_eq!(
        pressure.kernel_headroom(t0 + Duration::from_secs(15)),
        Some(true)
    );
    // Swapping in ~4 MiB/s.
    healthy(&root, 100 + 15 * 1024);
    assert_eq!(
        pressure.kernel_headroom(t0 + Duration::from_secs(30)),
        Some(false)
    );
    for (cpu, memory, available, swap_free) in [
        (41.0, 1.0, 8 << 20, 16 << 20),
        (10.0, 11.0, 8 << 20, 16 << 20),
        (10.0, 1.0, 3 << 20, 16 << 20),
        (10.0, 1.0, 8 << 20, 7 << 20),
    ] {
        root.kernel(cpu, memory, available, swap_free, 100 + 15 * 1024);
        let at = t0 + Duration::from_secs(45);
        let mut pressure = root.pressure();
        pressure.swap_in = Some((at - Duration::from_secs(15), 100 + 15 * 1024));
        assert_eq!(pressure.kernel_headroom(at), Some(false));
    }
    std::fs::remove_file(root.0.join("proc/pressure/memory")).unwrap();
    assert_eq!(root.pressure().kernel_headroom(t0), None);
    // No governor and no readable kernel state: no extra slot.
    assert!(!root.pressure().admit_with(|| true));
}
