use super::{
    WorkerCancellation, WorkerLimits, WorkerOutput, WorkerSandboxError as Error,
    WorkerSandboxResult as Result,
};
use std::os::unix::{
    fs::MetadataExt,
    process::{CommandExt, ExitStatusExt},
};
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
#[path = "linux.rs"]
mod linux;

// Process-wide, including independent trusted configurations. No hidden queue.
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
const MAX_ACTIVE: usize = 4;
const MAX_SOURCE: usize = 64 * 1024;

/// Construct only from trusted server composition, never from request fields.
/// No environment, mounts, network switch, executable override or provider grant.
pub struct WorkerSandbox {
    python: PathBuf,
    library: PathBuf,
}

/// Owned running child. Dropping it terminates and reaps the child; it cannot
/// transfer process ownership or expose a PID to arbitrary callers.
pub struct WorkerProcess {
    owned: Owned,
    stdout: std::process::ChildStdout,
    stderr: std::process::ChildStderr,
    limits: WorkerLimits,
    deadline: Instant,
    _slot: Slot,
}

fn trusted(path: &Path, directory: bool) -> Result<PathBuf> {
    let canonical = path.canonicalize().map_err(|_| Error::InvalidConfig)?;
    for component in canonical.ancestors() {
        let meta = fs::metadata(component).map_err(|_| Error::InvalidConfig)?;
        if meta.uid() != 0 || meta.mode() & 0o022 != 0 {
            return Err(Error::InvalidConfig);
        }
    }
    let meta = fs::metadata(&canonical).map_err(|_| Error::InvalidConfig)?;
    if (directory && !meta.is_dir())
        || (!directory && (!meta.is_file() || meta.mode() & 0o111 == 0))
    {
        return Err(Error::InvalidConfig);
    }
    Ok(canonical)
}

impl WorkerSandbox {
    /// Debian-style Linux x86-64 Python layout only. Missing support fails closed.
    /// This does not activate any server route, provider, or tool dispatcher.
    pub fn opt_in_python_offline() -> Result<Self> {
        if trusted(Path::new("/usr/bin/bwrap"), false)? != Path::new("/usr/bin/bwrap") {
            return Err(Error::InvalidConfig);
        }
        let python = trusted(Path::new("/usr/bin/python3"), false)?;
        let name = python
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or(Error::InvalidConfig)?;
        let minor = name.strip_prefix("python3.").ok_or(Error::InvalidConfig)?;
        if minor.is_empty() || !minor.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Error::InvalidConfig);
        }
        let library = trusted(&PathBuf::from("/usr/lib").join(name), true)?;
        trusted(Path::new("/usr/lib/x86_64-linux-gnu"), true)?;
        trusted(
            Path::new("/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"),
            false,
        )?;
        Ok(Self { python, library })
    }

    fn command(&self, code: &str, limits: WorkerLimits, filter: &std::fs::File) -> Command {
        use std::os::fd::AsRawFd;
        let mut command = Command::new("/usr/bin/bwrap");
        command
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .args([
                "--unshare-user",
                "--unshare-pid",
                "--unshare-net",
                "--unshare-ipc",
                "--unshare-uts",
                "--unshare-cgroup",
                "--disable-userns",
                "--assert-userns-disabled",
                "--die-with-parent",
                "--new-session",
                "--cap-drop",
                "ALL",
                "--clearenv",
                "--ro-bind",
            ])
            .arg(&self.python)
            .arg("/usr/bin/python3")
            .arg("--ro-bind")
            .arg(&self.library)
            .arg(&self.library)
            .args([
                "--ro-bind",
                "/usr/lib/x86_64-linux-gnu",
                "/usr/lib/x86_64-linux-gnu",
                "--symlink",
                "usr/lib",
                "/lib",
                "--ro-bind",
                "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
                "/lib64/ld-linux-x86-64.so.2",
                "--proc",
                "/proc",
                "--remount-ro",
                "/proc",
                "--dev",
                "/dev",
                "--size",
                "16777216",
                "--tmpfs",
                "/dev/shm",
                "--remount-ro",
                "/dev",
                "--size",
                "16777216",
                "--tmpfs",
                "/tmp",
                "--size",
                "8388608",
                "--tmpfs",
                "/home/worker",
                "--size",
                "33554432",
                "--tmpfs",
                "/work",
                "--chdir",
                "/work",
                "--remount-ro",
                "/",
                "--setenv",
                "HOME",
                "/home/worker",
                "--setenv",
                "PATH",
                "/usr/bin",
                "--setenv",
                "PWD",
                "/work",
                "--setenv",
                "TMPDIR",
                "/tmp",
                "--setenv",
                "LANG",
                "C.UTF-8",
                "--seccomp",
            ])
            .arg(filter.as_raw_fd().to_string())
            .args(["--", "/usr/bin/python3", "-I", "-B", "-c", code]);
        command.process_group(0);
        linux::configure(&mut command, filter.as_raw_fd(), limits.timeout);
        command
    }

    /// Blocking, bounded work: dispatch on a dedicated worker, never an async I/O
    /// executor. The caller owns any required Core admission/fence authorization.
    pub fn run_python(
        &self,
        code: &str,
        limits: WorkerLimits,
        cancellation: &WorkerCancellation,
    ) -> Result<WorkerOutput> {
        self.start_python(code, limits, cancellation)?
            .wait(cancellation)
    }

    /// Spawn only: trusted dispatchers place this short action inside their
    /// durable grant fence, then release the transaction before waiting.
    /// This is not an authorization check; raw callers still need a consumed grant.
    pub fn start_python(
        &self,
        code: &str,
        limits: WorkerLimits,
        cancellation: &WorkerCancellation,
    ) -> Result<WorkerProcess> {
        if code.is_empty()
            || code.len() > MAX_SOURCE
            || code.contains('\0')
            || limits.timeout.is_zero()
            || limits.timeout > Duration::from_secs(30)
            || limits.max_output_bytes == 0
            || limits.max_output_bytes > 128 * 1024
        {
            return Err(Error::InvalidInput);
        }
        if cancellation.cancelled() {
            return Err(Error::Cancelled);
        }
        let slot = Slot::acquire()?;
        let filter = linux::filter()?;
        let deadline = Instant::now() + limits.timeout;
        let child = self
            .command(code, limits, &filter)
            .spawn()
            .map_err(|_| Error::Io)?;
        let mut owned = Owned(Some(child));
        drop(filter); // Only the child's sealed policy fd survives until bwrap consumes it.
        let stdout = owned.0.as_mut().unwrap().stdout.take().ok_or(Error::Io)?;
        let stderr = owned.0.as_mut().unwrap().stderr.take().ok_or(Error::Io)?;
        linux::nonblocking(&stdout)?;
        linux::nonblocking(&stderr)?;
        Ok(WorkerProcess {
            owned,
            stdout,
            stderr,
            limits,
            deadline,
            _slot: slot,
        })
    }
}

impl WorkerProcess {
    /// Blocking completion outside the database fence. Drop and every error path
    /// retain cleanup ownership; the concurrency slot is released after the child.
    pub fn wait(mut self, cancellation: &WorkerCancellation) -> Result<WorkerOutput> {
        let mut output = WorkerOutput {
            exit_code: None,
            signal: None,
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        let (mut out_eof, mut err_eof, mut exited) = (false, false, false);
        loop {
            if cancellation.cancelled() {
                return Err(Error::Cancelled);
            }
            if Instant::now() >= self.deadline {
                return Err(Error::Timeout);
            }
            let mut total = output.stdout.len() + output.stderr.len();
            out_eof |= drain(
                &mut self.stdout,
                &mut output.stdout,
                &mut total,
                self.limits.max_output_bytes,
            )?;
            err_eof |= drain(
                &mut self.stderr,
                &mut output.stderr,
                &mut total,
                self.limits.max_output_bytes,
            )?;
            if !exited && linux::exited(self.owned.id())? {
                // WNOWAIT keeps this exact leader PID reserved until cleanup/reap.
                linux::kill_group(self.owned.id());
                exited = true;
            }
            if exited && out_eof && err_eof {
                let status = self.owned.finish()?;
                output.exit_code = status.code();
                output.signal = status.signal();
                return Ok(output);
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

fn drain(
    pipe: &mut impl Read,
    output: &mut Vec<u8>,
    total: &mut usize,
    limit: usize,
) -> Result<bool> {
    let mut buffer = [0; 4096];
    for _ in 0..16 {
        match pipe.read(&mut buffer) {
            Ok(0) => return Ok(true),
            Ok(count) => {
                *total += count;
                if *total > limit {
                    return Err(Error::OutputLimit);
                }
                output.extend_from_slice(&buffer[..count]);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(Error::Io),
        }
    }
    Ok(false)
}

struct Slot;
impl Slot {
    fn acquire() -> Result<Self> {
        ACTIVE
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_ACTIVE).then_some(n + 1)
            })
            .map_err(|_| Error::Busy)?;
        Ok(Self)
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
    }
}
struct Owned(Option<Child>);
impl Owned {
    fn id(&self) -> u32 {
        self.0.as_ref().unwrap().id()
    }
    fn finish(mut self) -> Result<std::process::ExitStatus> {
        let status = self.0.as_mut().unwrap().wait().map_err(|_| Error::Io)?;
        self.0 = None;
        Ok(status)
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            linux::kill_group(child.id());
            let _ = child.kill();
            let _ = child.wait(); // Retain ownership through termination; never process-name cleanup.
        }
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
