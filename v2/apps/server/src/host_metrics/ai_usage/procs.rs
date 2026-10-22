//! Running Claude and Codex programs: each provider process whose parent is
//! not one, with its whole process tree's CPU (over the last pass) and
//! memory. Only `/proc/<pid>/stat`, `comm`, `cmdline` and `cwd` are read;
//! command arguments are matched, never kept.
use super::super::consumers::{parse_stat, Stat};
use orkestr_v2_contracts::AiProvider;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Program {
    pub provider: AiProvider,
    pub label: &'static str,
    pub started_at_ms: Option<i64>,
    pub cpu_percent: f32,
    pub rss_bytes: u64,
    pub processes: u32,
    /// Server-side only: matches a program to its session.
    pub cwd: Option<String>,
}

/// Which provider program `comm` and the first two arguments are, if any.
pub(crate) fn classify(comm: &str, argv: &[&str]) -> Option<(AiProvider, &'static str)> {
    let base = |s: &str| s.rsplit('/').next().unwrap_or("").to_owned();
    let program = argv.first().map(|a| base(a)).unwrap_or_default();
    let script = if program == "node" || comm == "node" {
        argv.get(1).map(|a| base(a)).unwrap_or_default()
    } else {
        program.clone()
    };
    let name = if script.is_empty() { comm.to_owned() } else { script };
    let app_server = argv.iter().take(3).any(|a| *a == "app-server");
    if name.starts_with("claude") || comm.starts_with("claude") {
        Some((AiProvider::Claude, "Claude Code"))
    } else if name == "codex" || name.starts_with("codex-") || comm.starts_with("codex") {
        Some((
            AiProvider::Codex,
            if app_server { "Codex app server" } else { "Codex" },
        ))
    } else {
        None
    }
}

struct Proc {
    stat: Stat,
    provider: Option<(AiProvider, &'static str)>,
}

#[derive(Default)]
pub(crate) struct Sampler {
    previous: HashMap<(u32, u64), u64>,
    previous_at: Option<std::time::Instant>,
}

fn boot_ms() -> Option<i64> {
    let text = std::fs::read_to_string("/proc/stat").ok()?;
    let secs: i64 = text
        .lines()
        .find_map(|l| l.strip_prefix("btime "))?
        .trim()
        .parse()
        .ok()?;
    Some(secs * 1000)
}

impl Sampler {
    pub fn sample(&mut self) -> Vec<Program> {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        let now = std::time::Instant::now();
        let clock = rustix::param::clock_ticks_per_second() as f64;
        let page = rustix::param::page_size() as u64;
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1) as f64;
        let boot = boot_ms();
        let mut procs: HashMap<u32, Proc> = HashMap::new();
        for entry in entries.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else {
                continue;
            };
            let dir = entry.path();
            let Some(stat) = std::fs::read_to_string(dir.join("stat"))
                .ok()
                .as_deref()
                .and_then(parse_stat)
            else {
                continue;
            };
            let comm = std::fs::read_to_string(dir.join("comm")).unwrap_or_default();
            let comm = comm.trim();
            let provider = if comm.starts_with("claude") || comm.starts_with("codex") || comm == "node" {
                let raw = std::fs::read(dir.join("cmdline")).unwrap_or_default();
                let text = String::from_utf8_lossy(&raw);
                let argv: Vec<&str> = text.split('\0').take(3).collect();
                classify(comm, &argv)
            } else {
                None
            };
            procs.insert(pid, Proc { stat, provider });
        }
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, p) in &procs {
            children.entry(p.stat.ppid).or_default().push(*pid);
        }
        let elapsed = self.previous_at.map(|at| now.duration_since(at).as_secs_f64());
        let mut ticks_now = HashMap::new();
        let mut out = Vec::new();
        for (pid, p) in &procs {
            let Some((provider, label)) = p.provider else { continue };
            if procs.get(&p.stat.ppid).is_some_and(|parent| parent.provider.is_some()) {
                continue;
            }
            let (mut delta, mut rss, mut count) = (0u64, 0u64, 0u32);
            let mut stack = vec![*pid];
            while let Some(current) = stack.pop() {
                let Some(c) = procs.get(&current) else { continue };
                count += 1;
                rss += c.stat.rss_pages * page;
                let key = (current, c.stat.start);
                delta += self
                    .previous
                    .get(&key)
                    .map_or(0, |before| c.stat.ticks.saturating_sub(*before));
                ticks_now.insert(key, c.stat.ticks);
                if count < 4096 {
                    stack.extend(children.get(&current).into_iter().flatten().copied());
                }
            }
            let cpu = elapsed
                .filter(|s| *s > 0.0)
                .map_or(0.0, |s| (delta as f64 / clock / s / cores * 100.0) as f32);
            out.push(Program {
                provider,
                label,
                started_at_ms: boot.map(|b| b + (p.stat.start as f64 / clock * 1000.0) as i64),
                cpu_percent: (cpu * 10.0).round() / 10.0,
                rss_bytes: rss,
                processes: count,
                cwd: std::fs::read_link(format!("/proc/{pid}/cwd"))
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned()),
            });
        }
        self.previous = ticks_now;
        self.previous_at = Some(now);
        out.sort_by(|a, b| b.cpu_percent.total_cmp(&a.cpu_percent).then(b.rss_bytes.cmp(&a.rss_bytes)));
        out
    }
}
