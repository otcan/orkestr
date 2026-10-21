use super::*;
use crate::conversation_resources_http::tests::{case, send};

const STAT: &str = "cpu  100 0 100 700 100 0 0 0 0 0
cpu0 50 0 50 350 50 0 0 0 0 0
cpu1 50 0 50 350 50 0 0 0 0 0
intr 1 2 3
";
const MEMINFO: &str = "MemTotal:       65698072 kB
MemFree:          805024 kB
MemAvailable:   42749188 kB
Buffers:          212000 kB
Cached:         41000000 kB
SReclaimable:     550000 kB
SwapTotal:      33520636 kB
SwapFree:        4478748 kB
";

#[test]
fn proc_parsers_match_free_and_top_definitions() {
    let (total, cores) = procfs::parse_stat(STAT).unwrap();
    assert_eq!(total, (200, 1000));
    assert_eq!(cores, vec![(100, 500), (100, 500)]);
    assert_eq!(procfs::busy_percent((200, 1000), (300, 1200)), Some(50.0));
    assert_eq!(procfs::busy_percent((200, 1000), (200, 1000)), None);
    assert_eq!(
        procfs::parse_loadavg("0.52 1.25 2.00 3/1234 5678\n"),
        Some((0.52, 1.25, 2.0))
    );
    let (mem_total, used, cache, swap_total, swap_used) = procfs::parse_meminfo(MEMINFO).unwrap();
    assert_eq!(mem_total, 65_698_072 * 1024);
    // procps-ng 4 `free`: used = total - available; buff/cache = buffers + cached + reclaimable.
    assert_eq!(used, (65_698_072 - 42_749_188) * 1024);
    assert_eq!(cache, (212_000 + 41_000_000 + 550_000) * 1024);
    assert_eq!(
        (swap_total, swap_used),
        (33_520_636 * 1024, (33_520_636 - 4_478_748) * 1024)
    );
    assert_eq!(
        procfs::parse_block_stat("  100 0 2048 0 50 0 4096 0 0 0 0 0 0 0 0 0 0"),
        Some((2048 * 512, 4096 * 512))
    );
    let dev = "Inter-|   Receive |  Transmit
 face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed
    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0
  eno1: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0
veth01: 5000 10 0 0 0 0 0 0 5000 20 0 0 0 0 0 0
";
    assert_eq!(procfs::parse_net_dev(dev, &|n| n == "eno1"), (1000, 2000));
}

#[test]
fn live_proc_values_agree_with_the_host() {
    let Some(reading) = procfs::read() else {
        return;
    };
    let g = &reading.gauges;
    assert!(g.mem_total > 0 && g.mem_used <= g.mem_total);
    assert!(g.disk_total > 0 && g.disk_used <= g.disk_total);
    assert!(!reading.counters.cpu_cores.is_empty());
}

fn reading(cpu: (u64, u64), disk: u64, net: u64) -> procfs::Reading {
    procfs::Reading {
        counters: procfs::Counters {
            cpu_total: cpu,
            cpu_cores: vec![cpu],
            disk_read_bytes: disk,
            disk_write_bytes: disk * 2,
            net_rx_bytes: net,
            net_tx_bytes: net / 2,
        },
        gauges: procfs::Gauges {
            load: (1.0, 2.0, 3.0),
            mem_total: 1000,
            mem_used: 400,
            disk_total: 100,
            disk_used: 30,
            disk_free: 60,
            ..Default::default()
        },
    }
}

#[test]
fn samples_are_rates_and_tiers_stay_bounded() {
    let before = reading((0, 0), 0, 0);
    let after = reading((25, 100), 5_000, 10_000);
    let s = sample(
        &before,
        &after,
        Duration::from_secs(5),
        1_000,
        None,
        Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!((s.cpu, s.cores.clone()), (25.0, vec![25.0]));
    assert_eq!((s.disk_read_bps, s.disk_write_bps), (1000.0, 2000.0));
    assert_eq!((s.net_rx_bps, s.net_tx_bps), (2000.0, 1000.0));
    assert_eq!((s.req_p95, s.req_rate), (None, 0.0));

    let mut history = History::default();
    let start = 1_700_000_000_000 - 1_700_000_000_000 % 600_000;
    // Eight days of 5 s samples would be 138 240 points; tiers keep ~3 200.
    let step = 5_000;
    for i in 0..(8 * 24 * 720) {
        let mut point = s.clone();
        point.t_ms = start + i * step;
        point.cpu = (i % 100) as f32;
        point.req_p95 = Some(if i % 1000 == 0 { 900.0 } else { 10.0 });
        history.push(point);
    }
    assert!(history.raw.len() <= 721);
    assert!(history.minutes.len() <= 1441);
    assert!(history.ten_minutes.len() <= 1009);
    let now = start + (8 * 24 * 720 - 1) * step;
    for range in HostMetricsRange::ALL {
        let (points, from) = history.range(range, now);
        assert!(
            !points.is_empty() && points.len() <= orkestr_v2_contracts::HOST_METRICS_MAX_POINTS,
            "{range:?}"
        );
        assert!(points
            .windows(2)
            .all(|w| w[1].t_ms - w[0].t_ms >= range.step_ms()));
        assert!(from.unwrap() > now - range.span_ms());
    }
    // A downsampled latency spike stays visible in the week view.
    let (week, _) = history.range(HostMetricsRange::Days7, now);
    assert!(week.iter().any(|p| p.req_p95_ms == Some(900.0)));
    // Persisted tiers round-trip and drop future points.
    let raw = serde_json::to_vec(&history).unwrap();
    let restored = serde_json::from_slice::<History>(&raw)
        .unwrap()
        .restored(now);
    assert_eq!(restored.minutes, history.minutes);
    assert!(restored.raw.is_empty());
    let early = serde_json::from_slice::<History>(&raw)
        .unwrap()
        .restored(start + 3_600_000);
    assert!(early.minutes.iter().all(|s| s.t_ms <= start + 3_600_000));
}

#[test]
fn units_file_is_bounded_and_systemctl_blocks_map_to_health() {
    let units = services::parse(
        br#"[{"label":"Adapter","unit":"orkestr-v2-wa-adapter.service"},
            {"label":"Probe","unit":"orkestr-wa-group-probe.service"},
            {"label":"Worker","unit":"orkestr-wa-worker@sender.service"},
            {"label":"Gone","unit":"missing.service"}]"#,
    )
    .unwrap();
    for bad in [
        &br#"[{"label":"x","unit":"--now.service"}]"#[..],
        br#"[{"label":"x","unit":"a b.service"}]"#,
        br#"[{"label":"","unit":"a.service"}]"#,
        br#"[{"label":"x","unit":"a.socket"}]"#,
        br#"{"label":"x"}"#,
    ] {
        assert!(services::parse(bad).is_none());
    }
    let show = "Type=simple\nResult=success\nNRestarts=2\nId=orkestr-v2-wa-adapter.service\nActiveState=active\nSubState=running\nStateChangeTimestamp=@1792589713\n\n\
Type=oneshot\nResult=success\nNRestarts=0\nId=orkestr-wa-group-probe.service\nActiveState=inactive\nSubState=dead\nStateChangeTimestamp=@1792591020\n\n\
Type=simple\nResult=exit-code\nNRestarts=5\nId=orkestr-wa-worker@sender.service\nActiveState=failed\nSubState=failed\nStateChangeTimestamp=@1792591021\n";
    let health = services::parse_show(show, &units);
    assert_eq!(health.len(), 4);
    assert!(
        health[0].healthy
            && health[0].restarts == 2
            && health[0].since_ms == Some(1_792_589_713_000)
    );
    assert!(
        health[1].healthy,
        "a probe between successful runs is healthy"
    );
    assert!(!health[2].healthy && health[2].state == orkestr_v2_contracts::ServiceState::Failed);
    assert_eq!(health[3].state, orkestr_v2_contracts::ServiceState::Unknown);
}

#[tokio::test]
async fn endpoints_are_owner_only_and_say_collecting_without_history() {
    let case = case().await;
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    for path in [
        "/api/v2/host-metrics",
        "/api/v2/host-metrics/history?range=1h",
    ] {
        assert_eq!(send(&case.state, "GET", path, &[], "").await.0, 401);
    }
    let (status, summary) = send(&case.state, "GET", "/api/v2/host-metrics", &[&cookie], "").await;
    assert_eq!(status, 200, "{summary}");
    let summary: HostMetricsSummary = serde_json::from_value(summary).unwrap();
    assert!(summary.is_valid());
    let (status, history) = send(
        &case.state,
        "GET",
        "/api/v2/host-metrics/history?range=7d",
        &[&cookie],
        "",
    )
    .await;
    assert_eq!(status, 200, "{history}");
    let history: HostMetricsHistory = serde_json::from_value(history).unwrap();
    assert!(history.is_valid());
    assert_eq!(history.range, HostMetricsRange::Days7);
    for bad in ["?range=2h", "?range=", "", "?range=1h&x=1"] {
        let path = format!("/api/v2/host-metrics/history{bad}");
        assert_eq!(
            send(&case.state, "GET", &path, &[&cookie], "").await.0,
            400,
            "{bad}"
        );
    }
    // Without samples the summary reports collecting, never zeros as data.
    let empty = summary_of(&Shared::default());
    assert!(empty.collecting && empty.cpu_percent.is_none() && empty.spark_cpu.is_empty());
    assert!(history_of(&Shared::default(), HostMetricsRange::Hour1, 0).collecting);
    case.finish().await;
}
