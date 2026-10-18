use super::*;
use linux::{memory, CpuCounters};

fn reading(cpu: &str) -> Reading {
    Reading {
        cpu: CpuCounters::parse(cpu).unwrap(),
        memory: memory("MemTotal: 1000 kB\nMemAvailable: 400 kB\n").unwrap(),
    }
}

#[test]
fn cpu_uses_deltas_without_double_counting_guest_time() {
    let before = CpuCounters::parse("cpu 10 0 0 20 0 0 0 0 10 0").unwrap();
    let after = CpuCounters::parse("cpu 20 0 0 30 0 0 0 0 20 0").unwrap();
    assert_eq!(after.busy_since(before), Some(500));
    assert_eq!(before.busy_since(before), None);
    assert_eq!(before.busy_since(after), None);
    let idle = CpuCounters::parse("cpu 10 0 0 30 0 0 0 0").unwrap();
    assert_eq!(idle.busy_since(before), Some(0));
}

#[test]
fn malformed_or_decreasing_counters_are_unknown_not_zero() {
    for line in ["cpu0 1 2 3 4 5 6 7 8", "cpu 1 2", "cpu 1 2 3 -4 5 6 7 8"] {
        assert!(CpuCounters::parse(line).is_none());
    }
    let before = CpuCounters::parse("cpu 10 0 0 20 10 0 0 0").unwrap();
    let after = CpuCounters::parse("cpu 20 0 0 30 9 0 0 0").unwrap();
    assert_eq!(after.busy_since(before), None);
}

#[test]
fn memory_uses_available_estimate_and_rejects_ambiguous_measurements() {
    let sample = memory("MemTotal: 1000 kB\nMemFree: 20 kB\nMemAvailable: 400 kB\n").unwrap();
    assert_eq!(sample.available_bytes, 409_600);
    assert_eq!(sample.used_bytes, 614_400);
    for text in [
        "MemTotal: 1000 kB\nMemFree: 400 kB\n",
        "MemTotal: 1 kB\nMemAvailable: 2 kB\n",
        "MemTotal: 0 kB\nMemAvailable: 0 kB\n",
        "MemTotal: 1 MB\nMemAvailable: 0 kB\n",
        "MemTotal: 1 kB\nMemTotal: 1 kB\nMemAvailable: 0 kB\n",
        "MemTotal: 18446744073709551615 kB\nMemAvailable: 0 kB\n",
    ] {
        assert!(memory(text).is_none());
    }
}

#[test]
fn failure_and_long_idle_gap_clear_old_cpu_and_require_new_baseline() {
    let sampler = ResourceSampler::new();
    let mut state = sampler.0.lock().unwrap();
    let start = Instant::now();
    state
        .update(start, Some(1000), Some(reading("cpu 10 0 0 10 0 0 0 0")))
        .unwrap();
    assert_eq!(state.snapshot.availability, ResourceAvailability::WarmingUp);
    state
        .update(
            start + MIN_INTERVAL,
            Some(2000),
            Some(reading("cpu 20 0 0 20 0 0 0 0")),
        )
        .unwrap();
    assert_eq!(state.snapshot.cpu.as_ref().unwrap().busy_permille, 500);
    assert!(state.snapshot.is_valid());
    state
        .update(start + Duration::from_secs(2), Some(3000), None)
        .unwrap();
    assert_eq!(
        state.snapshot.availability,
        ResourceAvailability::Unavailable
    );
    assert!(state.snapshot.cpu.is_none() && state.snapshot.memory.is_none());
    state
        .update(
            start + Duration::from_secs(3),
            Some(4000),
            Some(reading("cpu 30 0 0 30 0 0 0 0")),
        )
        .unwrap();
    assert_eq!(state.snapshot.availability, ResourceAvailability::WarmingUp);
    state
        .update(
            start + Duration::from_secs(20),
            Some(21_000),
            Some(reading("cpu 40 0 0 40 0 0 0 0")),
        )
        .unwrap();
    assert_eq!(state.snapshot.availability, ResourceAvailability::WarmingUp);
    assert_eq!(state.snapshot.sample_sequence, 5);
    assert!(state.snapshot.is_valid());
}

#[test]
fn invalid_wall_clock_does_not_publish_a_fresh_measurement() {
    let sampler = ResourceSampler::new();
    let mut state = sampler.0.lock().unwrap();
    state
        .update(Instant::now(), None, Some(reading("cpu 10 0 0 10 0 0 0 0")))
        .unwrap();
    assert_eq!(
        state.snapshot.availability,
        ResourceAvailability::Unavailable
    );
    assert!(state.snapshot.is_valid());
    assert!(state.previous.is_none());
}

#[test]
fn cached_reads_preserve_observation_identity_and_time() {
    let sampler = ResourceSampler::new();
    let mut state = sampler.0.lock().unwrap();
    let now = Instant::now();
    assert!(state.cached(now).is_none());
    state
        .update(now, Some(1000), Some(reading("cpu 10 0 0 10 0 0 0 0")))
        .unwrap();
    let first = state.cached(now).unwrap();
    let second = state.cached(now + Duration::from_millis(999)).unwrap();
    assert_eq!(first, second);
    assert!(first.is_valid());
    assert!(state.cached(now + MIN_INTERVAL).is_none());
    assert_ne!(
        state.snapshot.instance_id,
        ResourceSampler::new()
            .0
            .lock()
            .unwrap()
            .snapshot
            .instance_id
    );
}

#[test]
fn invalid_contract_combinations_cannot_be_presented_as_healthy() {
    let sampler = ResourceSampler::new();
    let mut state = sampler.0.lock().unwrap();
    state
        .update(
            Instant::now(),
            Some(1000),
            Some(reading("cpu 1 0 0 1 0 0 0 0")),
        )
        .unwrap();
    assert!(state.snapshot.is_valid());
    state.snapshot.availability = ResourceAvailability::Ready;
    assert!(!state.snapshot.is_valid());
    state.snapshot.cpu = Some(HostCpuUsage {
        busy_permille: 1001,
        interval_ms: 1000,
    });
    assert!(!state.snapshot.is_valid());
    state.snapshot.cpu.as_mut().unwrap().busy_permille = 1000;
    assert!(state.snapshot.is_valid());
    state.snapshot.memory.as_mut().unwrap().used_bytes += 1;
    assert!(!state.snapshot.is_valid());
}
