//! Per-command cgroup v2 ownership, independent of process-group/session IDs.
use super::{Error, Result};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
const NOFOLLOW: i32 = 0x20000;

pub(super) struct Root {
    path: PathBuf,
    directory: File,
}
pub(super) struct Job {
    path: PathBuf,
    directory: File,
    pub(super) procs: File,
    kill: File,
    events: File,
}
fn open(path: &Path, write: bool) -> Result<File> {
    OpenOptions::new()
        .read(!write)
        .write(write)
        .custom_flags(NOFOLLOW)
        .open(path)
        .map_err(|_| Error::InvalidConfig)
}
fn bounded(file: &File) -> Result<String> {
    use std::os::unix::fs::FileExt;
    let mut bytes = [0; 4097];
    let n = file.read_at(&mut bytes, 0).map_err(|_| Error::Io)?;
    if n > 4096 {
        return Err(Error::InvalidConfig);
    }
    String::from_utf8(bytes[..n].to_vec()).map_err(|_| Error::InvalidConfig)
}
fn same(file: &File, path: &Path) -> Result<()> {
    let pinned = file.metadata().map_err(|_| Error::Io)?;
    let now = fs::symlink_metadata(path).map_err(|_| Error::InvalidConfig)?;
    if now.is_symlink() || pinned.dev() != now.dev() || pinned.ino() != now.ino() {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}
impl Root {
    /// Jobs of this same server process (e.g. detached jobs surviving a window
    /// restart) are expected. Any other populated job subtree is refused, or
    /// with `reclaim` (host-privileged mode) killed and removed first.
    pub(super) fn configured_with(path: &Path, reclaim: bool) -> Result<Self> {
        let path = super::sandbox::directory(path, false)?;
        let directory = File::open(&path).map_err(|_| Error::InvalidConfig)?;
        super::linux::cgroup2(&directory)?;
        // Trusted provisioning delegates the common ancestor migration right,
        // creates this empty subtree, and enables these controllers beforehand.
        if !bounded(&open(&path.join("cgroup.procs"), false)?)?
            .trim()
            .is_empty()
        {
            return Err(Error::InvalidConfig);
        }
        let root = Self {
            path: path.clone(),
            directory,
        };
        root.foreign_jobs(reclaim)?;
        let controllers = bounded(&open(&path.join("cgroup.subtree_control"), false)?)?;
        if ["cpu", "memory", "pids"]
            .iter()
            .any(|c| !controllers.split_whitespace().any(|v| v == *c))
        {
            return Err(Error::InvalidConfig);
        }
        Ok(root)
    }
    fn foreign_jobs(&self, reclaim: bool) -> Result<()> {
        same(&self.directory, &self.path)?;
        let own = format!("job-{}-", std::process::id());
        let entries = fs::read_dir(&self.path).map_err(|_| Error::InvalidConfig)?;
        for entry in entries.flatten() {
            if !entry
                .file_type()
                .is_ok_and(|t| t.is_dir() && !t.is_symlink())
            {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_str().ok_or(Error::InvalidConfig)?;
            if name.starts_with(&own) {
                continue;
            }
            if !name.starts_with("job-") {
                return Err(Error::InvalidConfig);
            }
            let path = entry.path();
            let mut stale = Job {
                procs: open(&path.join("cgroup.procs"), true)?,
                kill: open(&path.join("cgroup.kill"), true)?,
                events: open(&path.join("cgroup.events"), false)?,
                directory: File::open(&path).map_err(|_| Error::Io)?,
                path,
            };
            if stale.populated()? {
                if !reclaim {
                    return Err(Error::InvalidConfig);
                }
                stale.kill_and_empty(Duration::from_secs(5))?;
            }
            drop(stale); // Drop removes the empty foreign directory.
        }
        Ok(())
    }

    pub(super) fn job(&self, resources: &super::profile::Resources) -> Result<Job> {
        same(&self.directory, &self.path)?;
        let name = format!(
            "job-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let path = self.path.join(name);
        fs::create_dir(&path).map_err(|_| Error::Io)?;
        let result = (|| {
            let directory = File::open(&path).map_err(|_| Error::Io)?;
            super::linux::cgroup2(&directory)?;
            let (memory, pids, cpu) = (
                resources.memory_bytes.to_string(),
                resources.pids.to_string(),
                format!("{} 100000", u64::from(resources.cpus) * 100_000),
            );
            for (name, value) in [
                ("memory.max", memory.as_str()),
                ("memory.swap.max", "0"),
                ("pids.max", pids.as_str()),
                ("cpu.max", cpu.as_str()),
                ("memory.oom.group", "1"),
            ] {
                open(&path.join(name), true)?
                    .write_all(value.as_bytes())
                    .map_err(|_| Error::Io)?;
                if bounded(&open(&path.join(name), false)?)?.trim() != value {
                    return Err(Error::InvalidConfig);
                }
            }
            let job = Job {
                procs: open(&path.join("cgroup.procs"), true)?,
                kill: open(&path.join("cgroup.kill"), true)?,
                events: open(&path.join("cgroup.events"), false)?,
                path: path.clone(),
                directory,
            };
            if job.populated()? {
                return Err(Error::InvalidConfig);
            }
            Ok(job)
        })();
        if result.is_err() {
            let _ = fs::remove_dir(&path);
        }
        result
    }
}
impl Job {
    pub(super) fn populated(&self) -> Result<bool> {
        let text = bounded(&self.events)?;
        match text
            .lines()
            .find_map(|line| line.strip_prefix("populated "))
        {
            Some("0") => Ok(false),
            Some("1") => Ok(true),
            _ => Err(Error::InvalidConfig),
        }
    }
    pub(super) fn kill_and_empty(&mut self, timeout: Duration) -> Result<()> {
        use std::os::unix::fs::FileExt;
        // These descriptors retain the exact original cgroup, even if a
        // delegated path is renamed. Never signal a recycled PID/PGID.
        if self.kill.write_at(b"1", 0).map_err(|_| Error::Io)? != 1 {
            return Err(Error::Io);
        }
        let deadline = Instant::now() + timeout;
        while self.populated()? {
            if Instant::now() >= deadline {
                return Err(Error::Io);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        // Caller keeps Job alive until populated=0 and original Child.wait.
        // A failed spawn has no admitted process and can remove immediately.
        if self.populated() == Ok(false) && same(&self.directory, &self.path).is_ok() {
            let _ = fs::remove_dir(&self.path);
        }
    }
}
