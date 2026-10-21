//! Whole-host counters from `/proc`, `/sys` and `statvfs("/")`. Parsers are
//! pure so tests feed them fixed text; `read()` does the file reads.
use std::{collections::BTreeMap, path::Path};

/// Cumulative jiffies of one CPU line: (busy, total).
pub(crate) type CpuTimes = (u64, u64);

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Counters {
    pub cpu_total: CpuTimes,
    pub cpu_cores: Vec<CpuTimes>,
    pub disk_read_bytes: u64,
    pub disk_write_bytes: u64,
    pub net_rx_bytes: u64,
    pub net_tx_bytes: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Gauges {
    pub load: (f32, f32, f32),
    pub mem_total: u64,
    pub mem_used: u64,
    pub mem_cache: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub disk_total: u64,
    pub disk_used: u64,
    pub disk_free: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Reading {
    pub counters: Counters,
    pub gauges: Gauges,
}

/// `cpu`/`cpuN` lines of `/proc/stat`. Busy excludes idle and iowait;
/// guest time is already part of user time.
pub(crate) fn parse_stat(text: &str) -> Option<(CpuTimes, Vec<CpuTimes>)> {
    let mut total = None;
    let mut cores = Vec::new();
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let Some(name) = fields.next().filter(|n| n.starts_with("cpu")) else {
            continue;
        };
        let values: Vec<u64> = fields.take(8).filter_map(|v| v.parse().ok()).collect();
        if values.len() < 5 {
            return None;
        }
        let all: u64 = values.iter().sum();
        let idle = values[3] + values[4];
        let times = (all.saturating_sub(idle), all);
        if name == "cpu" {
            total = Some(times);
        } else {
            cores.push(times);
        }
    }
    Some((total?, cores))
}

pub(crate) fn parse_loadavg(text: &str) -> Option<(f32, f32, f32)> {
    let mut fields = text.split_whitespace().map(|v| v.parse::<f32>().ok());
    Some((fields.next()??, fields.next()??, fields.next()??))
}

/// `/proc/meminfo` in bytes: (total, used, buff/cache, swap total, swap used),
/// with the same definitions as `free` (procps-ng 4): used = total − available.
pub(crate) fn parse_meminfo(text: &str) -> Option<(u64, u64, u64, u64, u64)> {
    let values: BTreeMap<&str, u64> = text
        .lines()
        .filter_map(|line| {
            let (key, rest) = line.split_once(':')?;
            let kib: u64 = rest.split_whitespace().next()?.parse().ok()?;
            Some((key, kib * 1024))
        })
        .collect();
    let total = *values.get("MemTotal")?;
    let available = *values.get("MemAvailable")?;
    let cache = values.get("Buffers").unwrap_or(&0)
        + values.get("Cached").unwrap_or(&0)
        + values.get("SReclaimable").unwrap_or(&0);
    let swap_total = *values.get("SwapTotal").unwrap_or(&0);
    let swap_free = *values.get("SwapFree").unwrap_or(&0);
    Some((
        total,
        total.saturating_sub(available),
        cache,
        swap_total,
        swap_total.saturating_sub(swap_free),
    ))
}

/// `/sys/block/<dev>/stat`: sectors read (field 3) and written (field 7), in bytes.
pub(crate) fn parse_block_stat(text: &str) -> Option<(u64, u64)> {
    let fields: Vec<u64> = text
        .split_whitespace()
        .map(|v| v.parse().ok())
        .collect::<Option<_>>()?;
    Some((*fields.get(2)? * 512, *fields.get(6)? * 512))
}

/// `/proc/net/dev` byte counters of the named interfaces: (rx, tx).
pub(crate) fn parse_net_dev(text: &str, include: &dyn Fn(&str) -> bool) -> (u64, u64) {
    let mut totals = (0, 0);
    for line in text.lines().skip(2) {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        if !include(name.trim()) {
            continue;
        }
        let fields: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        if fields.len() >= 9 {
            totals.0 += fields[0];
            totals.1 += fields[8];
        }
    }
    totals
}

/// Physical disks only: partitions, RAID/device-mapper volumes on top of
/// them, loop and RAM devices would count the same bytes twice or not at all.
fn physical_disk(name: &str) -> bool {
    !["loop", "ram", "zram", "dm-", "md", "sr", "nbd"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

fn read_disks(root: &Path) -> (u64, u64) {
    let mut totals = (0, 0);
    let Ok(entries) = std::fs::read_dir(root.join("sys/block")) else {
        return totals;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|n| physical_disk(n)) else {
            continue;
        };
        if let Some((read, write)) = std::fs::read_to_string(entry.path().join("stat"))
            .ok()
            .as_deref()
            .and_then(parse_block_stat)
        {
            let _ = name;
            totals.0 += read;
            totals.1 += write;
        }
    }
    totals
}

/// Interfaces backed by a device (NICs), not loopback, bridges or veths.
fn physical_nic(root: &Path, name: &str) -> bool {
    name != "lo"
        && root
            .join("sys/class/net")
            .join(name)
            .join("device")
            .exists()
}

/// `statvfs("/")` like `df`: (size, used, available to unprivileged users).
fn read_root_fs() -> Option<(u64, u64, u64)> {
    let stat = rustix::fs::statvfs("/").ok()?;
    let block = stat.f_frsize;
    let total = stat.f_blocks * block;
    let free = stat.f_bfree * block;
    Some((total, total.saturating_sub(free), stat.f_bavail * block))
}

/// One reading of everything; `None` when `/proc` is unreadable.
pub(crate) fn read() -> Option<Reading> {
    let root = Path::new("/");
    let (cpu_total, cpu_cores) = parse_stat(&std::fs::read_to_string("/proc/stat").ok()?)?;
    let load = parse_loadavg(&std::fs::read_to_string("/proc/loadavg").ok()?)?;
    let (mem_total, mem_used, mem_cache, swap_total, swap_used) =
        parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)?;
    let (disk_read_bytes, disk_write_bytes) = read_disks(root);
    let (net_rx_bytes, net_tx_bytes) = std::fs::read_to_string("/proc/net/dev")
        .map(|text| parse_net_dev(&text, &|name| physical_nic(root, name)))
        .unwrap_or_default();
    let (disk_total, disk_used, disk_free) = read_root_fs().unwrap_or_default();
    Some(Reading {
        counters: Counters {
            cpu_total,
            cpu_cores,
            disk_read_bytes,
            disk_write_bytes,
            net_rx_bytes,
            net_tx_bytes,
        },
        gauges: Gauges {
            load,
            mem_total,
            mem_used,
            mem_cache,
            swap_total,
            swap_used,
            disk_total,
            disk_used,
            disk_free,
        },
    })
}

/// Busy percent between two cumulative CPU readings.
pub(crate) fn busy_percent(before: CpuTimes, after: CpuTimes) -> Option<f32> {
    let total = after.1.checked_sub(before.1).filter(|t| *t > 0)?;
    let busy = after.0.checked_sub(before.0)?.min(total);
    Some((busy as f64 * 100.0 / total as f64) as f32)
}
