//! Local filesystems (like `df -l`) and the largest directories on `/`
//! (like `du -x -d 2`, hourly, idle I/O priority, readable paths only).
use orkestr_v2_contracts::{HostDirectories, HostDirectory, HostMount};
use std::time::Duration;

/// Real, local filesystems; pseudo, network and overlay mounts are skipped.
const LOCAL: [&str; 10] = [
    "ext2", "ext3", "ext4", "xfs", "btrfs", "vfat", "zfs", "f2fs", "exfat", "ntfs3",
];
const MAX_MOUNTS: usize = 16;
pub(crate) const DIRECTORY_EVERY: Duration = Duration::from_secs(3600);
const DIRECTORY_ENTRIES: usize = 15;
const DU_TIMEOUT: Duration = Duration::from_secs(900);

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

/// One measurement; blocking for up to `DU_TIMEOUT`.
pub(crate) fn measure_directories() -> Option<(u64, Vec<HostDirectory>)> {
    let mut child = std::process::Command::new("/usr/bin/ionice")
        .args([
            "-c3",
            "/usr/bin/nice",
            "-n19",
            "/usr/bin/du",
            "-x",
            "-d",
            "2",
            "-B1",
            "/",
        ])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
        text
    });
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < DU_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(500))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    // `du` exits non-zero when some directories are unreadable; its totals are still valid.
    let text = reader.join().ok()?;
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
