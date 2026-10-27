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
    let show = "Type=simple\nResult=success\nNRestarts=2\nId=orkestr-v2-wa-adapter.service\nActiveState=active\nSubState=running\nStateChangeTimestamp=@1792589713\nExecMainStatus=0\nExecMainExitTimestamp=\nTriggeredBy=\n\n\
Type=oneshot\nResult=success\nNRestarts=0\nId=orkestr-wa-group-probe.service\nActiveState=inactive\nSubState=dead\nStateChangeTimestamp=@1792599736\nExecMainStatus=0\nExecMainExitTimestamp=@1792599736\nTriggeredBy=orkestr-wa-group-probe.timer\n\n\
Type=simple\nResult=exit-code\nNRestarts=5\nId=orkestr-wa-worker@sender.service\nActiveState=failed\nSubState=failed\nStateChangeTimestamp=@1792591021\nExecMainStatus=1\nExecMainExitTimestamp=@1792591021\nTriggeredBy=\n";
    let timers = "Id=orkestr-wa-group-probe.timer\nActiveState=active\nSubState=waiting\n";
    let health = services::parse_show(show, timers, &units);
    assert_eq!(health.len(), 4);
    assert!(
        health[0].healthy
            && health[0].restarts == 2
            && health[0].since_ms == Some(1_792_589_713_000)
    );
    assert!(!health[0].oneshot && health[0].last_run_ms.is_none());
    // A timer job idle between successful runs is healthy, with its last run.
    let probe = &health[1];
    assert!(probe.healthy && probe.oneshot, "{probe:?}");
    assert_eq!(
        (
            probe.last_run_ms,
            probe.last_exit_status,
            probe.timer_active
        ),
        (Some(1_792_599_736_000), Some(0), Some(true))
    );
    assert!(!health[2].healthy && health[2].state == orkestr_v2_contracts::ServiceState::Failed);
    // A failed last run, a non-zero exit or a stopped timer is not healthy.
    for (shown, timer) in [
        (
            show.replace("ActiveState=inactive", "ActiveState=failed")
                .replace(
                    "Result=success\nNRestarts=0",
                    "Result=exit-code\nNRestarts=0",
                ),
            timers.to_string(),
        ),
        (
            show.replace(
                "ExecMainStatus=0\nExecMainExitTimestamp=@1792599736",
                "ExecMainStatus=3\nExecMainExitTimestamp=@1792599736",
            ),
            timers.to_string(),
        ),
        (
            show.to_string(),
            timers.replace("ActiveState=active", "ActiveState=inactive"),
        ),
    ] {
        assert!(
            !services::parse_show(&shown, &timer, &units)[1].healthy,
            "{shown}\n{timer}"
        );
    }
    // Running right now is fine.
    let running = show.replace(
        "ActiveState=inactive\nSubState=dead",
        "ActiveState=activating\nSubState=start",
    );
    assert!(services::parse_show(&running, timers, &units)[1].healthy);
    assert_eq!(
        services::trigger("TriggeredBy=a.timer evil;rm.timer"),
        Some("a.timer".into())
    );
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

#[test]
fn processes_are_attributed_to_conversations_workspaces_and_units() {
    let stat = "4242 (codex app (x)) S 77 4242 4242 0 -1 4194560 1 0 0 0 150 50 0 0 20 0 11 0 98765 1 300 18446744073709551615";
    assert_eq!(
        consumers::parse_stat(stat),
        Some(consumers::Stat {
            ppid: 77,
            ticks: 200,
            start: 98765,
            rss_pages: 300
        })
    );
    assert_eq!(
        consumers::parse_io("rchar: 9\nread_bytes: 4096\nwrite_bytes: 8192\n"),
        Some((4096, 8192))
    );
    let id = "a73a655e-8e02-4748-a903-d9183d819ea4";
    let env = |home: &str| format!("PATH=/usr/bin\0HOME={home}\0LANG=C\0").into_bytes();
    assert_eq!(
        consumers::owned_execution(&env(&format!("/var/lib/x/owned-executions/fast-{id}/home"))),
        Some((id.into(), "fast".into()))
    );
    assert_eq!(
        consumers::owned_execution(&env(&format!("/var/lib/x/owned-executions/{id}/home"))),
        Some((id.into(), "deep".into()))
    );
    assert_eq!(consumers::owned_execution(&env("/home/orkestr")), None);
    assert_eq!(
        consumers::owned_execution(&env("/x/owned-executions/not-a-uuid/home")),
        None
    );
    assert_eq!(
        consumers::workspace("/opt/orkestr/workspace/otcanclaw-pa-1234/src"),
        Some("otcanclaw-pa-1234".into())
    );
    assert_eq!(consumers::workspace("/home/orkestr"), None);
    let users = |uid: u32| {
        if uid == 995 {
            "orkestr".to_string()
        } else {
            uid.to_string()
        }
    };
    use consumers::Group;
    let unit = |c: &str| consumers::cgroup_group(c, &users);
    assert_eq!(
        unit("0::/system.slice/caddy.service"),
        (
            Group::Service("caddy.service".into()),
            Some("/system.slice/caddy.service".into())
        )
    );
    assert_eq!(
        unit("0::/system.slice/orkestr-v2-pilot.service/manager").0,
        Group::Service("orkestr-v2-pilot.service".into())
    );
    assert_eq!(
        unit("0::/system.slice/system-orkestr\\x2dwa.slice/orkestr-wa-worker@sender.service").0,
        Group::Service("orkestr-wa-worker@sender.service".into())
    );
    assert_eq!(
        unit("0::/system.slice/docker-0123456789abcdef0123.scope").0,
        Group::Container("0123456789ab".into())
    );
    assert_eq!(
        unit("0::/user.slice/user-995.slice/session-4.scope").0,
        Group::Session("orkestr".into())
    );
    assert_eq!(unit("0::/").0, Group::Other("kernel".into()));
    let devices: std::collections::HashSet<String> = ["259:0".to_string()].into();
    assert_eq!(
        consumers::parse_io_stat(
            "9:0 rbytes=5 wbytes=6\n259:0 rbytes=100 wbytes=200 rios=1\n",
            &devices
        ),
        (100, 200)
    );
}

#[test]
fn live_scan_attributes_this_test_process() {
    let mut scanner = consumers::Scanner::new();
    let labels = std::collections::HashMap::new();
    assert!(scanner.sample(&labels));
    assert!(scanner.sample(&labels));
    let top = scanner.top();
    assert!(!top.is_empty());
    assert!(top
        .iter()
        .all(|c| c.cpu_percent >= 0.0 && c.spark_cpu.len() == 1));
}

#[test]
fn mounts_and_du_output_parse_like_df_and_du() {
    let mounts = "proc /proc proc rw 0 0\n/dev/md1 /boot ext3 rw 0 0\n/dev/md2 / ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/md2 /var/lib/docker/x ext4 rw 0 0\n/dev/sdb1 /mnt/my\\040disk xfs rw 0 0\n";
    let parsed = disks::parse_mounts(mounts);
    assert_eq!(
        parsed
            .iter()
            .map(|(m, _, _)| m.as_str())
            .collect::<Vec<_>>(),
        vec!["/", "/boot", "/mnt/my disk"]
    );
    let (root, entries) = disks::parse_du("1000\t/home\n5000\t/opt\n8000\t/\n200\t/opt/x\n");
    assert_eq!(root, 8000);
    assert_eq!(entries[0].path, "/opt");
    assert_eq!(entries.len(), 3);
    let live = disks::read_mounts();
    assert!(live
        .iter()
        .any(|m| m.mount == "/" && m.used_bytes <= m.total_bytes));
}

/// `sh` writes its pid to `pidfile`, then becomes `sleep 60` (same pid).
fn long_child(pidfile: &Path) -> std::process::Command {
    let mut command = std::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("echo $$ > \"$0\"; exec sleep 60")
        .arg(pidfile);
    command
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "orkestr-host-metrics-{name}-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Waits up to 5 s for the child's pid.
fn child_pid(pidfile: &Path) -> u32 {
    let started = Instant::now();
    loop {
        if let Some(pid) = std::fs::read_to_string(pidfile)
            .ok()
            .and_then(|text| text.trim().parse().ok())
        {
            return pid;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "child never started"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Killed and reaped: no `/proc` entry (not even a zombie) remains.
fn gone(pid: u32) -> bool {
    !Path::new(&format!("/proc/{pid}")).exists()
}

#[test]
fn a_running_measurement_is_killed_and_reaped_on_cancel() {
    let dir = scratch("cancel");
    let pidfile = dir.join("pid");
    let cancel = Arc::new(AtomicBool::new(false));
    let runner = {
        let (cancel, command) = (cancel.clone(), long_child(&pidfile));
        std::thread::spawn(move || disks::run_bounded(command, &cancel, Duration::from_secs(60)))
    };
    let pid = child_pid(&pidfile);
    assert!(!gone(pid));
    let cancelled = Instant::now();
    cancel.store(true, Ordering::Release);
    assert_eq!(runner.join().unwrap(), None);
    assert!(cancelled.elapsed() < Duration::from_secs(1));
    assert!(gone(pid), "child {pid} survived cancel");
    // A cancelled sampler starts no new child, and a timeout also kills.
    assert_eq!(
        disks::run_bounded(
            long_child(&dir.join("never")),
            &cancel,
            Duration::from_secs(60)
        ),
        None
    );
    assert!(!dir.join("never").exists());
    let timed_out = dir.join("timeout");
    let quiet = AtomicBool::new(false);
    let started = Instant::now();
    assert_eq!(
        disks::run_bounded(long_child(&timed_out), &quiet, Duration::from_millis(300)),
        None
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(gone(child_pid(&timed_out)));
    assert_eq!(
        disks::run_bounded(
            {
                let mut c = std::process::Command::new("/bin/echo");
                c.arg("ok");
                c
            },
            &quiet,
            Duration::from_secs(5)
        )
        .as_deref(),
        Some("ok\n")
    );
    let _ = std::fs::remove_dir_all(dir);
}

static SAMPLER_PIDFILE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
fn sampler_child() -> std::process::Command {
    long_child(SAMPLER_PIDFILE.get().unwrap())
}

static DRAINING_PIDFILE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
fn draining_child() -> std::process::Command {
    long_child(DRAINING_PIDFILE.get().unwrap())
}

fn fast(directories_command: fn() -> std::process::Command) -> Options {
    Options {
        tick: Duration::from_millis(20),
        first_directories_tick: 0,
        directories_command,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_is_prompt_while_a_directory_measurement_runs() {
    let dir = scratch("shutdown");
    let pidfile = SAMPLER_PIDFILE.get_or_init(|| dir.join("pid")).clone();
    let drain = Arc::new(crate::deploy_drain::DeployDrain::default());
    let sampler = start_with(&dir, drain, fast(sampler_child));
    let pid = {
        let pidfile = pidfile.clone();
        tokio::task::spawn_blocking(move || child_pid(&pidfile))
            .await
            .unwrap()
    };
    assert!(!gone(pid));
    let started = Instant::now();
    sampler.shutdown().await;
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "shutdown took {:?}",
        started.elapsed()
    );
    assert!(gone(pid), "measurement {pid} survived shutdown");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_directory_measurement_starts_during_a_deploy_drain() {
    let dir = scratch("drain");
    let pidfile = DRAINING_PIDFILE.get_or_init(|| dir.join("pid")).clone();
    let drain = Arc::new(crate::deploy_drain::DeployDrain::default());
    drain.set(true);
    let sampler = start_with(&dir, drain, fast(draining_child));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!pidfile.exists(), "du started while draining");
    sampler.shutdown().await;
    let _ = std::fs::remove_dir_all(dir);
}
