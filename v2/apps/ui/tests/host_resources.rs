use orkestr_v2_contracts::{HostResourceHealth, ResourceAvailability};
use orkestr_v2_ui::host_resources::HostResources;
fn sample() -> HostResourceHealth {
    serde_json::from_value(serde_json::json!({
        "schema_version":1,"scope":"host","instance_id":"00000000-0000-4000-8000-000000000001",
        "sample_sequence":1,"observed_at_ms":9000000,"availability":"ready",
        "cpu":{"busy_permille":255,"interval_ms":1000},
        "memory":{"total_bytes":4194304,"available_bytes":1048576,"used_bytes":3145728}
    }))
    .unwrap()
}
#[test]
fn loading_warming_unavailable_and_measured_zero_are_distinct() {
    let mut state = HostResources::default();
    let generation = state.begin_view();
    assert!(state.status(1).contains("Loading"));
    assert_eq!(state.cpu(1), "Unavailable");
    assert_eq!(state.memory(1), "Unavailable");
    let mut warming = sample();
    warming.cpu = None;
    warming.availability = ResourceAvailability::WarmingUp;
    state.apply(generation, 1, warming.clone()).unwrap();
    assert!(state.status(1).contains("warming"));
    assert_eq!(state.cpu(1), "Unavailable");
    assert!(state.memory(1).contains("3 MiB used"));
    warming.sample_sequence += 1;
    warming.memory = None;
    warming.observed_at_ms = None;
    warming.availability = ResourceAvailability::Unavailable;
    state.apply(generation, 2, warming).unwrap();
    assert!(state.status(2).contains("unavailable"));
    assert_eq!(state.memory(2), "Unavailable");
    let mut zero = sample();
    zero.sample_sequence = 3;
    zero.cpu.as_mut().unwrap().busy_permille = 0;
    state.apply(generation, 3, zero).unwrap();
    assert_eq!(state.cpu(3), "0.0% busy"); // actual measurement, never absence
}
#[test]
fn cached_reads_and_component_remount_never_rejuvenate_old_samples() {
    let mut state = HostResources::default();
    let generation = state.begin_view();
    state.apply(generation, 1, sample()).unwrap();
    state.apply(generation, 60001, sample()).unwrap();
    assert!(state.status(60001).contains("stale"));
    assert_eq!(state.cpu(60001), "Unavailable");
    let remounted = state.begin_view();
    assert!(state.apply(generation, 60002, sample()).is_err());
    state.apply(remounted, 60002, sample()).unwrap();
    assert!(!state.fresh(60002));
    let mut next = sample();
    next.sample_sequence = 2;
    next.observed_at_ms = Some(1);
    state.apply(remounted, 60003, next).unwrap(); // wall-clock skew cannot invalidate monotonic freshness
    assert_eq!(state.cpu(60003), "25.5% busy");
    assert!(state.apply(remounted, 60004, sample()).is_err());
}
#[test]
fn server_instance_restart_accepts_sequence_reset_but_rejects_old_instance_replay() {
    let mut state = HostResources::default();
    let generation = state.begin_view();
    let mut first = sample();
    first.sample_sequence = 500;
    state.apply(generation, 1, first.clone()).unwrap();
    let mut restarted = sample();
    restarted.instance_id =
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000002")).unwrap();
    state.apply(generation, 2, restarted.clone()).unwrap();
    assert!(state.apply(generation, 3, first).is_err());
    restarted.cpu.as_mut().unwrap().busy_permille = 999;
    assert!(state.apply(generation, 4, restarted).is_err());
    assert_eq!(state.cpu(4), "25.5% busy");
}
#[test]
fn malformed_samples_fail_closed_and_owner_loss_invalidates_pending_callbacks() {
    let mut state = HostResources::default();
    let generation = state.begin_view();
    for field in 0..5 {
        let mut invalid = sample();
        match field {
            0 => invalid.schema_version = 2,
            1 => invalid.cpu.as_mut().unwrap().busy_permille = 1001,
            2 => invalid.memory.as_mut().unwrap().used_bytes = 0,
            3 => invalid.sample_sequence = 0,
            _ => invalid.observed_at_ms = None,
        }
        assert!(state.apply(generation, 1, invalid).is_err());
    }
    state.disconnected(generation);
    assert!(state.status(1).contains("unavailable"));
    state.apply(generation, 2, sample()).unwrap();
    state.clear_owner();
    assert!(state.apply(generation, 3, sample()).is_err());
    state.disconnected(generation); // old failure cannot change the next owner's loading state
    let next_owner = state.begin_view();
    assert!(state.status(3).contains("Loading"));
    assert_eq!(state.memory(3), "Unavailable");
    state.apply(next_owner, 3, sample()).unwrap();
    assert!(state.fresh(3));
    assert!(state.apply(next_owner, 2, sample()).is_err());
}
