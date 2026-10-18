//! Bounded reads of kernel host aggregates; no process or credential inspection.
//! Definitions: https://docs.kernel.org/filesystems/proc.html
use orkestr_v2_contracts::HostMemoryUsage;
use std::io::Read;

#[derive(Clone, Copy)]
pub(super) struct CpuCounters([u64; 8]);

impl CpuCounters {
    pub fn parse(line: &str) -> Option<Self> {
        let mut values = line.split_ascii_whitespace();
        if values.next()? != "cpu" {
            return None;
        }
        let mut counters = [0; 8];
        for value in &mut counters {
            *value = values.next()?.parse().ok()?;
        }
        // guest/guest_nice already contribute to user/nice; do not add twice.
        Some(Self(counters))
    }

    pub fn busy_since(self, previous: Self) -> Option<u16> {
        let mut total = 0u128;
        let mut idle = 0u128;
        for (index, (current, previous)) in self.0.into_iter().zip(previous.0).enumerate() {
            // iowait can decrease. Treat discontinuity as unknown, never clamp
            // a backwards counter into an apparently valid busy measurement.
            let delta = current.checked_sub(previous)? as u128;
            total += delta;
            if index == 3 || index == 4 {
                idle += delta;
            }
        }
        (total > 0).then(|| (((total - idle) * 1000) / total) as u16)
    }
}

pub(super) fn memory(text: &str) -> Option<HostMemoryUsage> {
    let mut total = None;
    let mut available = None;
    for line in text.lines() {
        let mut fields = line.split_ascii_whitespace();
        let destination = match fields.next() {
            Some("MemTotal:") => &mut total,
            Some("MemAvailable:") => &mut available,
            _ => continue,
        };
        if destination.is_some() {
            return None;
        }
        let bytes = fields.next()?.parse::<u64>().ok()?.checked_mul(1024)?;
        if fields.next() != Some("kB") || fields.next().is_some() {
            return None;
        }
        *destination = Some(bytes);
    }
    let (total_bytes, available_bytes) = (total?, available?);
    if total_bytes == 0 || available_bytes > total_bytes {
        return None;
    }
    Some(HostMemoryUsage {
        total_bytes,
        available_bytes,
        used_bytes: total_bytes - available_bytes,
    })
}

pub(super) struct Reading {
    pub cpu: CpuCounters,
    pub memory: HostMemoryUsage,
}

pub(super) fn read() -> Option<Reading> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let mut cpu = String::new();
    std::fs::File::open("/proc/stat")
        .ok()?
        .take(4096)
        .read_to_string(&mut cpu)
        .ok()?;
    let (line, _) = cpu.split_once('\n')?;
    let cpu = CpuCounters::parse(line)?;
    let mut meminfo = String::new();
    std::fs::File::open("/proc/meminfo")
        .ok()?
        .take(65_537)
        .read_to_string(&mut meminfo)
        .ok()?;
    if meminfo.len() > 65_536 {
        return None;
    }
    Some(Reading {
        cpu,
        memory: memory(&meminfo)?,
    })
}
