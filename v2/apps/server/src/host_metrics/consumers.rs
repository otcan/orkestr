//! Who uses the host: every process is attributed to an owner-meaningful
//! group and the groups' CPU, memory and I/O are sampled every 10 s.
//!
//! Attribution, first match wins:
//! 1. a V2 conversation: the process or an ancestor runs with its home in
//!    `…/owned-executions/[role-]<conversation>` (Deep, Fast and Worker
//!    provider sessions, their native app-servers and tool children);
//! 2. a workspace: the working directory is inside a workspace root (V1
//!    thread tools, Worker commands);
//! 3. its systemd unit (service), container or login session (cgroup).
//!
//! Only `/proc/<pid>/stat` is needed for CPU and memory, so every process
//! counts. Per-process I/O is readable for the service user's own processes;
//! other services report I/O from their cgroup's `io.stat`.
use orkestr_v2_contracts::{ConsumerKind, HostConsumer, HOST_METRICS_SPARK_POINTS};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    os::unix::fs::MetadataExt,
    time::{Duration, Instant},
};

pub(crate) const SAMPLE_EVERY: Duration = Duration::from_secs(10);
const FORGET_AFTER: Duration = Duration::from_secs(15 * 60);
const SHOWN_BY_CPU: usize = 20;
const SHOWN_BY_MEMORY: usize = 10;
const WORKSPACE_ROOTS: [&str; 2] = [
    "/opt/orkestr/workspace/",
    "/var/lib/orkestr-workspace-exec/projects/",
];
const OWNED_EXECUTIONS: &str = "/owned-executions/";

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum Group {
    Conversation(String),
    Workspace(String),
    Service(String),
    Container(String),
    Session(String),
    Other(String),
}

impl Group {
    pub fn key(&self) -> String {
        match self {
            Group::Conversation(id) => format!("conversation:{id}"),
            Group::Workspace(dir) => format!("workspace:{dir}"),
            Group::Service(unit) => format!("service:{unit}"),
            Group::Container(id) => format!("container:{id}"),
            Group::Session(user) => format!("session:{user}"),
            Group::Other(name) => format!("other:{name}"),
        }
    }
    fn kind(&self) -> ConsumerKind {
        match self {
            Group::Conversation(_) => ConsumerKind::Conversation,
            Group::Workspace(_) => ConsumerKind::Workspace,
            Group::Service(_) => ConsumerKind::Service,
            Group::Container(_) => ConsumerKind::Container,
            Group::Session(_) => ConsumerKind::Session,
            Group::Other(_) => ConsumerKind::Other,
        }
    }
}

/// `/proc/<pid>/stat` fields after the command name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Stat {
    pub ppid: u32,
    pub ticks: u64,
    pub start: u64,
    pub rss_pages: u64,
}

pub(crate) fn parse_stat(text: &str) -> Option<Stat> {
    let rest = &text[text.rfind(')')? + 1..];
    let f: Vec<&str> = rest.split_whitespace().collect();
    let num = |i: usize| f.get(i)?.parse::<u64>().ok();
    Some(Stat {
        ppid: num(1)? as u32,
        ticks: num(11)? + num(12)?,
        start: num(19)?,
        rss_pages: num(21)?,
    })
}

/// `read_bytes` / `write_bytes` of `/proc/<pid>/io` (storage I/O, not cache).
pub(crate) fn parse_io(text: &str) -> Option<(u64, u64)> {
    let field = |key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(key)?.trim().parse::<u64>().ok())
    };
    Some((field("read_bytes:")?, field("write_bytes:")?))
}

/// The conversation and role of an owned execution home, e.g.
/// `…/owned-executions/fast-<uuid>/home` → (`<uuid>`, `fast`).
pub(crate) fn owned_execution(environ: &[u8]) -> Option<(String, String)> {
    let text = String::from_utf8_lossy(environ);
    text.split('\0')
        .filter_map(|v| {
            v.strip_prefix("HOME=")
                .or_else(|| v.strip_prefix("TMPDIR="))
        })
        .find_map(|path| {
            let segment = path.split(OWNED_EXECUTIONS).nth(1)?.split('/').next()?;
            let split = segment.len().checked_sub(36)?;
            let (prefix, id) = segment.split_at(split);
            uuid::Uuid::parse_str(id).ok()?;
            let role = prefix.trim_end_matches('-');
            let role = if role.is_empty() { "deep" } else { role };
            (role.len() <= 16 && role.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
                .then(|| (id.to_owned(), role.to_owned()))
        })
}

pub(crate) fn workspace(cwd: &str) -> Option<String> {
    WORKSPACE_ROOTS.iter().find_map(|root| {
        let dir = cwd.strip_prefix(root)?.split('/').next()?;
        (!dir.is_empty() && dir.len() <= 120 && !dir.chars().any(char::is_control))
            .then(|| dir.to_owned())
    })
}

/// Group of a process from its cgroup v2 path (`0::/system.slice/x.service/…`).
pub(crate) fn cgroup_group(cgroup: &str, users: &dyn Fn(u32) -> String) -> (Group, Option<String>) {
    let path = cgroup
        .lines()
        .find_map(|l| l.strip_prefix("0::"))
        .unwrap_or("/");
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    for (index, part) in parts.iter().enumerate() {
        let unit_path = || format!("/{}", parts[..=index].join("/"));
        if let Some(id) = part
            .strip_prefix("docker-")
            .and_then(|p| p.strip_suffix(".scope"))
        {
            return (
                Group::Container(id.chars().take(12).collect()),
                Some(unit_path()),
            );
        }
        if let Some(uid) = part
            .strip_prefix("user-")
            .and_then(|p| p.strip_suffix(".slice"))
            .and_then(|p| p.parse::<u32>().ok())
        {
            return (Group::Session(users(uid)), Some(unit_path()));
        }
        if part.ends_with(".service") && !part.starts_with("user@") {
            return (Group::Service(part.to_string()), Some(unit_path()));
        }
    }
    match parts.last() {
        None => (Group::Other("kernel".into()), None),
        Some(last) => (
            Group::Other(last.trim_end_matches(".scope").to_string()),
            Some(format!("/{}", parts.join("/"))),
        ),
    }
}

fn user_names() -> HashMap<u32, String> {
    std::fs::read_to_string("/etc/passwd")
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(':').collect();
            Some((f.get(2)?.parse().ok()?, f.first()?.to_string()))
        })
        .collect()
}

/// `maj:min` of whole physical disks (no partitions, RAID or loop devices).
fn physical_devices() -> HashSet<String> {
    let mut out = HashSet::new();
    if let Ok(entries) = std::fs::read_dir("/sys/block") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if ["loop", "ram", "zram", "dm-", "md", "sr", "nbd"]
                .iter()
                .any(|p| name.starts_with(p))
            {
                continue;
            }
            if let Ok(dev) = std::fs::read_to_string(entry.path().join("dev")) {
                out.insert(dev.trim().to_owned());
            }
        }
    }
    out
}

/// Bytes read and written on physical disks by a cgroup (hierarchical).
pub(crate) fn parse_io_stat(text: &str, devices: &HashSet<String>) -> (u64, u64) {
    let mut totals = (0, 0);
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        if !fields.next().is_some_and(|dev| devices.contains(dev)) {
            continue;
        }
        for field in fields {
            if let Some(v) = field
                .strip_prefix("rbytes=")
                .and_then(|v| v.parse::<u64>().ok())
            {
                totals.0 += v;
            } else if let Some(v) = field
                .strip_prefix("wbytes=")
                .and_then(|v| v.parse::<u64>().ok())
            {
                totals.1 += v;
            }
        }
    }
    totals
}

#[derive(Clone)]
struct Process {
    stat: Stat,
    command: String,
    uid: u32,
    io: Option<(u64, u64)>,
}

#[derive(Clone, Debug)]
struct Identity {
    group: Group,
    role: Option<String>,
    cgroup_unit: Option<String>,
}

struct Tracked {
    roles: Vec<String>,
    spark: VecDeque<f32>,
    seen: Instant,
    latest: Option<HostConsumer>,
}

/// The last scan: when, every process, and cgroup I/O counters by unit path.
type Previous = (
    Instant,
    HashMap<(u32, u64), Process>,
    HashMap<String, (u64, u64)>,
);

pub(crate) struct Scanner {
    own_uid: u32,
    page: u64,
    clock: f64,
    cores: u32,
    users: HashMap<u32, String>,
    devices: HashSet<String>,
    identities: HashMap<(u32, u64), Identity>,
    previous: Option<Previous>,
    tracked: BTreeMap<Group, Tracked>,
}

impl Scanner {
    pub fn new() -> Self {
        Self {
            own_uid: rustix::process::geteuid().as_raw(),
            page: rustix::param::page_size() as u64,
            clock: rustix::param::clock_ticks_per_second() as f64,
            cores: 0,
            users: user_names(),
            devices: physical_devices(),
            identities: HashMap::new(),
            previous: None,
            tracked: BTreeMap::new(),
        }
    }

    fn identity(
        &mut self,
        key: (u32, u64),
        processes: &HashMap<(u32, u64), Process>,
        by_pid: &HashMap<u32, (u32, u64)>,
        depth: usize,
    ) -> Identity {
        if let Some(found) = self.identities.get(&key) {
            return found.clone();
        }
        let (pid, _) = key;
        let process = &processes[&key];
        let dir = format!("/proc/{pid}");
        let own = process.uid == self.own_uid;
        let users = &self.users;
        let (cgroup_group, cgroup_unit) = cgroup_group(
            &std::fs::read_to_string(format!("{dir}/cgroup")).unwrap_or_default(),
            &|uid| users.get(&uid).cloned().unwrap_or_else(|| uid.to_string()),
        );
        let mut identity = None;
        if own {
            if let Some((id, role)) = std::fs::read(format!("{dir}/environ"))
                .ok()
                .as_deref()
                .and_then(owned_execution)
            {
                identity = Some(Identity {
                    group: Group::Conversation(id),
                    role: Some(role),
                    cgroup_unit: cgroup_unit.clone(),
                });
            }
        }
        if identity.is_none() && depth < 32 {
            if let Some(parent) = by_pid.get(&process.stat.ppid).copied() {
                let inherited = self.identity(parent, processes, by_pid, depth + 1);
                if matches!(
                    inherited.group,
                    Group::Conversation(_) | Group::Workspace(_)
                ) {
                    identity = Some(Identity {
                        cgroup_unit: cgroup_unit.clone(),
                        ..inherited
                    });
                }
            }
        }
        if identity.is_none() && own {
            if let Some(dir) = std::fs::read_link(format!("{dir}/cwd"))
                .ok()
                .and_then(|p| workspace(&p.to_string_lossy()))
            {
                identity = Some(Identity {
                    group: Group::Workspace(dir),
                    role: None,
                    cgroup_unit: cgroup_unit.clone(),
                });
            }
        }
        let identity = identity.unwrap_or(Identity {
            group: cgroup_group,
            role: None,
            cgroup_unit,
        });
        self.identities.insert(key, identity.clone());
        identity
    }

    /// One scan; returns `false` when `/proc` is unreadable.
    pub fn sample(&mut self, labels: &HashMap<String, String>) -> bool {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return false;
        };
        let now = Instant::now();
        self.cores = std::fs::read_to_string("/proc/stat")
            .map(|t| {
                t.lines()
                    .filter(|l| l.starts_with("cpu") && !l.starts_with("cpu "))
                    .count() as u32
            })
            .unwrap_or(1)
            .max(1);
        let mut processes: HashMap<(u32, u64), Process> = HashMap::new();
        for entry in entries.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            let path = entry.path();
            let Some(stat) = std::fs::read_to_string(path.join("stat"))
                .ok()
                .as_deref()
                .and_then(parse_stat)
            else {
                continue;
            };
            // Kernel threads (children of kthreadd) have no memory and no owner.
            if stat.ppid == 2 || pid == 2 {
                continue;
            }
            let uid = std::fs::metadata(&path)
                .map(|m| m.uid())
                .unwrap_or(u32::MAX);
            let io = (uid == self.own_uid)
                .then(|| std::fs::read_to_string(path.join("io")).ok())
                .flatten()
                .as_deref()
                .and_then(parse_io);
            let command = std::fs::read_to_string(path.join("comm"))
                .map(|c| {
                    c.trim()
                        .chars()
                        .filter(|c| !c.is_control())
                        .take(16)
                        .collect()
                })
                .unwrap_or_default();
            processes.insert(
                (pid, stat.start),
                Process {
                    stat,
                    command,
                    uid,
                    io,
                },
            );
        }
        let by_pid: HashMap<u32, (u32, u64)> = processes.keys().map(|k| (k.0, *k)).collect();
        self.identities.retain(|key, _| processes.contains_key(key));
        let keys: Vec<(u32, u64)> = processes.keys().copied().collect();
        for key in &keys {
            self.identity(*key, &processes, &by_pid, 0);
        }
        // Per-group totals for this scan.
        #[derive(Default)]
        struct Totals {
            ticks: u64,
            rss: u64,
            io: (u64, u64),
            io_complete: bool,
            processes: u32,
            roles: HashSet<String>,
            units: HashSet<String>,
            busiest: Option<(u64, u64, String)>,
        }
        let mut totals: BTreeMap<Group, Totals> = BTreeMap::new();
        let previous = self.previous.take();
        for (key, process) in &processes {
            let identity = &self.identities[key];
            let t = totals
                .entry(identity.group.clone())
                .or_insert_with(|| Totals {
                    io_complete: true,
                    ..Default::default()
                });
            t.processes += 1;
            t.rss += process.stat.rss_pages * self.page;
            if let Some(role) = &identity.role {
                t.roles.insert(role.clone());
            }
            if let Some(unit) = &identity.cgroup_unit {
                t.units.insert(unit.clone());
            }
            let before = previous.as_ref().and_then(|(_, p, _)| p.get(key));
            let delta = before.map_or(0, |b| process.stat.ticks.saturating_sub(b.stat.ticks));
            t.ticks += delta;
            let rank = (delta, process.stat.rss_pages);
            if t.busiest.as_ref().is_none_or(|(d, r, _)| rank > (*d, *r)) {
                t.busiest = Some((delta, process.stat.rss_pages, process.command.clone()));
            }
            match (process.io, before.and_then(|b| b.io)) {
                (Some(now_io), Some(then_io)) => {
                    t.io.0 += now_io.0.saturating_sub(then_io.0);
                    t.io.1 += now_io.1.saturating_sub(then_io.1);
                }
                (Some(_), None) => {}
                (None, _) => t.io_complete = false,
            }
        }
        // Service and container I/O from their cgroup when per-process I/O is closed.
        let mut cgroup_io: HashMap<String, (u64, u64)> = HashMap::new();
        for (group, t) in &totals {
            if t.io_complete || !matches!(group, Group::Service(_) | Group::Container(_)) {
                continue;
            }
            for unit in &t.units {
                if let Ok(text) = std::fs::read_to_string(format!("/sys/fs/cgroup{unit}/io.stat")) {
                    cgroup_io.insert(unit.clone(), parse_io_stat(&text, &self.devices));
                }
            }
        }
        let elapsed = previous
            .as_ref()
            .map(|(at, _, _)| now.duration_since(*at).as_secs_f64());
        for (group, t) in totals {
            let tracked = self
                .tracked
                .entry(group.clone())
                .or_insert_with(|| Tracked {
                    roles: Vec::new(),
                    spark: VecDeque::new(),
                    seen: now,
                    latest: None,
                });
            tracked.seen = now;
            let mut roles: Vec<String> = t.roles.into_iter().collect();
            roles.sort();
            tracked.roles = roles.clone();
            let Some(seconds) = elapsed.filter(|s| *s > 0.0) else {
                continue;
            };
            let cores_used = t.ticks as f64 / self.clock / seconds;
            let cpu_percent = (cores_used / self.cores as f64 * 100.0) as f32;
            let (io_read, io_write) = if t.io_complete {
                (
                    Some((t.io.0 as f64 / seconds) as f32),
                    Some((t.io.1 as f64 / seconds) as f32),
                )
            } else if matches!(group, Group::Service(_) | Group::Container(_))
                && !t.units.is_empty()
            {
                let mut sum: Option<(f64, f64)> = Some((0.0, 0.0));
                for unit in &t.units {
                    match (
                        cgroup_io.get(unit),
                        previous.as_ref().and_then(|(_, _, io)| io.get(unit)),
                    ) {
                        (Some(now_io), Some(then_io)) => {
                            if let Some(s) = sum.as_mut() {
                                s.0 += now_io.0.saturating_sub(then_io.0) as f64;
                                s.1 += now_io.1.saturating_sub(then_io.1) as f64;
                            }
                        }
                        _ => sum = None,
                    }
                }
                match sum {
                    Some((r, w)) => (Some((r / seconds) as f32), Some((w / seconds) as f32)),
                    None => (None, None),
                }
            } else {
                (None, None)
            };
            if tracked.spark.len() >= HOST_METRICS_SPARK_POINTS {
                tracked.spark.pop_front();
            }
            tracked.spark.push_back((cpu_percent * 10.0).round() / 10.0);
            tracked.latest = Some(HostConsumer {
                key: group.key(),
                kind: group.kind(),
                label: label(&group, labels),
                conversation_id: match &group {
                    Group::Conversation(id) => Some(id.clone()),
                    _ => None,
                },
                roles,
                cpu_percent: (cpu_percent * 10.0).round() / 10.0,
                cores: ((cores_used * 100.0).round() / 100.0) as f32,
                rss_bytes: t.rss,
                io_read_bps: io_read.map(f32::round),
                io_write_bps: io_write.map(f32::round),
                processes: t.processes,
                top_command: t.busiest.map(|(_, _, c)| c).filter(|c| !c.is_empty()),
                spark_cpu: Vec::new(),
            });
        }
        // Groups that ended: a zero point, then forgotten after a while.
        for tracked in self.tracked.values_mut() {
            if tracked.seen != now {
                if let Some(latest) = tracked.latest.as_mut() {
                    latest.cpu_percent = 0.0;
                    latest.cores = 0.0;
                    latest.rss_bytes = 0;
                    latest.processes = 0;
                    latest.io_read_bps = latest.io_read_bps.map(|_| 0.0);
                    latest.io_write_bps = latest.io_write_bps.map(|_| 0.0);
                }
            }
        }
        self.tracked
            .retain(|_, t| now.duration_since(t.seen) < FORGET_AFTER);
        let mut merged_io = previous.map(|(_, _, io)| io).unwrap_or_default();
        merged_io.extend(cgroup_io);
        self.previous = Some((now, processes, merged_io));
        true
    }

    /// The busiest groups by CPU plus the largest by memory, CPU order.
    pub fn top(&self) -> Vec<HostConsumer> {
        let mut all: Vec<HostConsumer> = self
            .tracked
            .values()
            .filter_map(|t| {
                let mut c = t.latest.clone()?;
                c.spark_cpu = t.spark.iter().copied().collect();
                c.roles = t.roles.clone();
                Some(c)
            })
            .collect();
        all.sort_by(|a, b| {
            b.cpu_percent
                .total_cmp(&a.cpu_percent)
                .then_with(|| b.rss_bytes.cmp(&a.rss_bytes))
        });
        let mut shown: Vec<HostConsumer> = all.iter().take(SHOWN_BY_CPU).cloned().collect();
        let mut by_memory = all.clone();
        by_memory.sort_by_key(|c| std::cmp::Reverse(c.rss_bytes));
        for c in by_memory.into_iter().take(SHOWN_BY_MEMORY) {
            if !shown.iter().any(|s| s.key == c.key) {
                shown.push(c);
            }
        }
        shown.sort_by(|a, b| {
            b.cpu_percent
                .total_cmp(&a.cpu_percent)
                .then_with(|| b.rss_bytes.cmp(&a.rss_bytes))
        });
        shown
    }
}

fn label(group: &Group, labels: &HashMap<String, String>) -> String {
    match group {
        Group::Conversation(id) => format!("Conversation {}", &id[..8.min(id.len())]),
        Group::Workspace(dir) => format!("Workspace {dir}"),
        Group::Service(unit) => labels
            .get(unit)
            .cloned()
            .unwrap_or_else(|| unit.trim_end_matches(".service").to_owned()),
        Group::Container(id) => format!("Docker container {id}"),
        Group::Session(user) => format!("Session of {user}"),
        Group::Other(name) if name == "kernel" => "Kernel and other".into(),
        Group::Other(name) => name.clone(),
    }
}

/// Unit file names of the listed health units → their labels.
pub(crate) fn unit_labels(units: &[super::services::Unit]) -> HashMap<String, String> {
    units
        .iter()
        .map(|u| (u.unit.clone(), u.label.clone()))
        .collect()
}
