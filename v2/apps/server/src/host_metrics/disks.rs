//! Local filesystems (like `df -l`) and the largest directories on `/`
//! (like `du -x -d 2`, hourly, idle I/O priority, readable paths only).
use orkestr_v2_contracts::{HostDirectories, HostDirectory, HostMount};
use std::{
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

/// Real, local filesystems; pseudo, network and overlay mounts are skipped.
const LOCAL: [&str; 10] = [
    "ext2", "ext3", "ext4", "xfs", "btrfs", "vfat", "zfs", "f2fs", "exfat", "ntfs3",
];
const MAX_MOUNTS: usize = 16;
pub(crate) const DIRECTORY_EVERY: Duration = Duration::from_secs(3600);
const DIRECTORY_ENTRIES: usize = 15;
/// Bounded: a slow `du` is abandoned well before the next hourly run.
pub(crate) const DU_TIMEOUT: Duration = Duration::from_secs(120);
/// How quickly a running measurement notices cancel (server shutdown).
const DU_POLL: Duration = Duration::from_millis(100);

/// `/proc/self/mounts` octal escapes (`\040` for a space).
fn unescape(field: &str) -> String {
    let mut out = String::new();
    let mut chars = field.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            let code: String = chars.by_ref().take(3).collect();
            match u8::from_str_radix(&code, 8) {
                Ok(byte) => out.push(byte as char),
                Err(_) => out.push_str(&code),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// (mount point, fs type, device) of local filesystems, `/` first, one per device.
pub(crate) fn parse_mounts(text: &str) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let [device, mount, fs, ..] = fields[..] else {
            continue;
        };
        if !LOCAL.contains(&fs) || out.iter().any(|(_, _, d)| d == device) {
            continue;
        }
        out.push((unescape(mount), fs.to_owned(), device.to_owned()));
    }
    out.sort_by_key(|(mount, _, _)| (mount != "/", mount.clone()));
    out.truncate(MAX_MOUNTS);
    out
}

pub(crate) fn read_mounts() -> Vec<HostMount> {
    let Ok(text) = std::fs::read_to_string("/proc/self/mounts") else {
        return Vec::new();
    };
    parse_mounts(&text)
        .into_iter()
        .filter_map(|(mount, fs_type, device)| {
            let stat = rustix::fs::statvfs(mount.as_str()).ok()?;
            let block = stat.f_frsize;
            let total = stat.f_blocks * block;
            Some(HostMount {
                total_bytes: total,
                used_bytes: total.saturating_sub(stat.f_bfree * block),
                free_bytes: stat.f_bavail * block,
                mount,
                fs_type,
                device,
            })
        })
        .filter(|m| m.total_bytes > 0)
        .collect()
}

/// `du -B1` output (`bytes<TAB>path`): the root total and the largest
/// entries below it, deepest-first duplicates kept (a parent and its child
/// may both appear, as `du` reports them).
pub(crate) fn parse_du(text: &str) -> (u64, Vec<HostDirectory>) {
    let mut root = 0;
    let mut entries: Vec<HostDirectory> = text
        .lines()
        .filter_map(|line| {
            let (bytes, path) = line.split_once('\t')?;
            Some(HostDirectory {
                bytes: bytes.trim().parse().ok()?,
                path: path.to_owned(),
            })
        })
        .filter(|e| {
            if e.path == "/" {
                root = e.bytes;
                false
            } else {
                !e.path.chars().any(char::is_control) && e.path.len() <= 512
            }
        })
        .collect();
    entries.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.path.cmp(&b.path)));
    entries.truncate(DIRECTORY_ENTRIES);
    (root, entries)
}

/// `du -x -d 2 -B1 /` at idle I/O and CPU priority.
pub(crate) fn du_command() -> Command {
    let mut command = Command::new("/usr/bin/ionice");
    command.args([
        "-c3",
        "/usr/bin/nice",
        "-n19",
        "/usr/bin/du",
        "-x",
        "-d",
        "2",
        "-B1",
        "/",
    ]);
    command
}

/// Runs `command` (blocking) and returns its stdout once it exits. Returns
/// `None` when it cannot start, exceeds `timeout`, or `cancel` is set; the
/// child is then killed and reaped before returning, within `DU_POLL`.
pub(crate) fn run_bounded(
    mut command: Command,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Option<String> {
    use std::os::unix::process::CommandExt;
    if cancel.load(Ordering::Acquire) {
        return None;
    }
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // SAFETY: between fork and exec the child only issues one raw `prctl`
    // syscall (async-signal-safe, no allocation or locking). The kernel then
    // SIGKILLs the child if the spawning thread (and so the server) dies;
    // that thread stays in the wait loop below for the child's whole life.
    unsafe {
        command.pre_exec(|| {
            rustix::process::set_parent_process_death_signal(Some(rustix::process::Signal::KILL))
                .map_err(std::io::Error::from)
        });
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
        text
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if !cancel.load(Ordering::Acquire) && started.elapsed() < timeout => {
                std::thread::sleep(DU_POLL)
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                // The reader ends on EOF now that the child is gone.
                return None;
            }
        }
    }
    reader.join().ok()
}

/// One measurement; blocking for up to `DU_TIMEOUT`, or until `cancel`.
pub(crate) fn measure_directories(
    command: Command,
    cancel: &AtomicBool,
) -> Option<(u64, Vec<HostDirectory>)> {
    // `du` exits non-zero when some directories are unreadable; its totals are still valid.
    let text = run_bounded(command, cancel, DU_TIMEOUT)?;
    Some(parse_du(&text))
}

pub(crate) fn empty_directories() -> HostDirectories {
    HostDirectories {
        observed_at_ms: None,
        running: false,
        readable_bytes: 0,
        entries: Vec::new(),
    }
}
