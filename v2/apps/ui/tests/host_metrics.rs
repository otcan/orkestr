use orkestr_v2_contracts::{HostMetricsHistory, HostMetricsRange, HostMetricsSummary};
use orkestr_v2_ui::host_metrics::*;

fn summary(collecting: bool, observed: Option<i64>) -> HostMetricsSummary {
    HostMetricsSummary {
        schema_version: 1,
        collecting,
        observed_at_ms: observed,
        interval_ms: 5000,
        cores: 12,
        cpu_percent: observed.map(|_| 12.5),
        memory_used_bytes: Some(23_499_460_608),
        memory_total_bytes: Some(67_274_629_120),
        disk_used_bytes: None,
        disk_free_bytes: None,
        disk_total_bytes: None,
        spark_cpu: vec![],
        spark_memory: vec![],
        spark_disk: vec![],
        ..Default::default()
    }
}

#[test]
fn units_read_like_free_and_df() {
    // `free -h` on the host: 62Gi total, 21Gi used.
    assert_eq!(bytes(67_274_629_120.0), "62.7 GiB");
    assert_eq!(bytes(23_499_460_608.0), "21.9 GiB");
    assert_eq!(bytes(512.0), "512 B");
    assert_eq!(bytes(847.0 * 1024f64.powi(3)), "847 GiB");
    assert_eq!(rate(1_260_000.0), "1.3 MB/s");
    assert_eq!(rate(999.0), "999 B/s");
    assert_eq!(
        (percent(3.04), percent(42.4)),
        ("3.0%".into(), "42%".into())
    );
    assert_eq!(
        (millis(4.2), millis(612.0), millis(1500.0)),
        ("4.2 ms".into(), "612 ms".into(), "1.50 s".into())
    );
    assert_eq!(share(Some(25), Some(100)), Some(25.0));
    assert_eq!(share(Some(25), Some(0)), None);
    assert_eq!(ago(100_000, 88_000), "12s ago");
    assert_eq!(ago(10_000_000, 0), "2h ago");
}

#[test]
fn clock_is_local_time_with_dates_for_long_ranges() {
    // 2026-10-21T12:53:51Z in CEST (UTC+2; Date offset -120).
    let t = 1_792_587_231_000;
    assert_eq!(clock(t, -120, false), "14:53");
    assert_eq!(clock(t, -120, true), "21/10 14:53");
    assert_eq!(clock(t, 0, true), "21/10 12:53");
}

#[test]
fn freshness_says_collecting_live_or_stale() {
    assert_eq!(freshness(None, 0, None), Freshness::Collecting);
    assert_eq!(
        freshness(Some(&summary(true, None)), 50_000, Some(50_000)),
        Freshness::Collecting
    );
    assert_eq!(
        freshness(Some(&summary(false, Some(45_000))), 50_000, Some(50_000)),
        Freshness::Live
    );
    // The browser kept polling but the server sample is old: stale.
    assert_eq!(
        freshness(Some(&summary(false, Some(0))), 50_000, Some(50_000)),
        Freshness::Stale
    );
    // The server answered long ago (offline): stale.
    assert_eq!(
        freshness(Some(&summary(false, Some(45_000))), 90_000, Some(50_000)),
        Freshness::Stale
    );
}

#[test]
fn chart_geometry_follows_time_and_breaks_at_gaps() {
    assert_eq!(
        (
            nice_max(0.0),
            nice_max(7.3),
            nice_max(230.0),
            nice_max(1000.0)
        ),
        (1.0, 10.0, 250.0, 1000.0)
    );
    let frame = Frame {
        from_ms: 0,
        span_ms: 100_000,
        step_ms: 5_000,
        width: 600.0,
        height: 100.0,
        max: 100.0,
    };
    assert_eq!(
        (frame.x(50_000), frame.y(25.0), frame.t(300.0)),
        (300.0, 75.0, 50_000)
    );
    let points = [
        (50_000, Some(0.0)),
        (55_000, Some(100.0)),
        (60_000, None),
        (65_000, Some(50.0)),
        (95_000, Some(50.0)),
    ];
    let lines = polylines(&points, &frame);
    assert_eq!(
        lines,
        vec![
            "300.0,100.0 330.0,0.0".to_string(),
            "390.0,50.0".to_string(),
            "570.0,50.0".to_string()
        ]
    );
    assert_eq!(nearest(&[0, 10, 20], 14), Some(1));
    let history: HostMetricsHistory = serde_json::from_value(serde_json::json!({
        "schema_version": 1, "range": "1h", "step_ms": 10000, "collecting": false, "observed_at_ms": 3600000,
        "history_from_ms": 1800000, "cores": 12, "memory_total_bytes": 1, "swap_total_bytes": 0, "disk_total_bytes": 1,
        "points": [], "services": [], "services_observed_at_ms": null})).unwrap();
    assert_eq!(history.range, HostMetricsRange::Hour1);
    assert_eq!(coverage(&history, 3_600_000), 0.5);
    assert_eq!(history_refresh_ms(HostMetricsRange::Days7), 60_000);
}

#[test]
fn timer_jobs_read_by_their_last_run() {
    let probe: orkestr_v2_contracts::ServiceHealth = serde_json::from_value(serde_json::json!({
        "label": "Group probe", "unit": "orkestr-wa-group-probe.service", "state": "inactive", "sub_state": "dead",
        "result": "success", "since_ms": 1_792_599_736_000_i64, "restarts": 0, "healthy": true, "oneshot": true,
        "last_run_ms": 1_792_599_736_000_i64, "last_exit_status": 0, "timer_active": true})).unwrap();
    assert_eq!(service_label(&probe, -120), "idle – last run OK at 18:22");
    let mut failed = probe.clone();
    failed.state = orkestr_v2_contracts::ServiceState::Failed;
    failed.healthy = false;
    failed.result = "exit-code".into();
    failed.last_exit_status = Some(2);
    assert_eq!(
        service_label(&failed, -120),
        "last run failed (exit 2) at 18:22"
    );
    let mut stopped = probe.clone();
    stopped.timer_active = Some(false);
    assert_eq!(
        service_label(&stopped, 0),
        "timer stopped – job will not run"
    );
    // Older servers without the one-shot fields still parse.
    let old: orkestr_v2_contracts::ServiceHealth = serde_json::from_value(serde_json::json!({
        "label": "Adapter", "unit": "a.service", "state": "active", "sub_state": "running",
        "result": "success", "since_ms": null, "restarts": 0, "healthy": true}))
    .unwrap();
    assert_eq!(service_label(&old, 0), "running");
}
