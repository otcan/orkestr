//! Trusted image and exact Core descriptor composition. No model-selected paths.
use super::*;
use std::{
    fs::{self, File},
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

static ACTIVE: AtomicUsize = AtomicUsize::new(0);
pub(super) struct Slot;
impl Slot {
    fn acquire() -> Result<Self> {
        ACTIVE
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 4).then_some(n + 1)
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

pub struct WorkspaceExecSandbox {
    image_path: PathBuf,
    image: Arc<File>,
    supervisor: PathBuf,
    cgroups: cgroup::Root,
}

pub(super) fn directory(path: &Path, root_only: bool) -> Result<PathBuf> {
    if !path.is_absolute() || path.canonicalize().ok().as_deref() != Some(path) {
        return Err(Error::InvalidConfig);
    }
    for part in path.ancestors() {
        let meta = fs::symlink_metadata(part).map_err(|_| Error::InvalidConfig)?;
        if !meta.is_dir()
            || meta.mode() & 0o022 != 0
            || (meta.uid() != 0 && (root_only || meta.uid() != linux::euid()))
        {
            return Err(Error::InvalidConfig);
        }
    }
    Ok(path.into())
}
impl WorkspaceExecSandbox {
    /// Only bounded metadata/FD checks. Provisioning owns the immutable image,
    /// controller delegation and writable common-ancestor migration permission.
    pub fn configured(cgroup_root: &Path, toolchain_root: &Path) -> Result<Self> {
        let image_path = directory(toolchain_root, true)?;
        let image = File::open(&image_path).map_err(|_| Error::InvalidConfig)?;
        let bwrap = Path::new("/usr/bin/bwrap");
        directory(bwrap.parent().ok_or(Error::InvalidConfig)?, true)?;
        let binary = fs::symlink_metadata(bwrap).map_err(|_| Error::InvalidConfig)?;
        if !binary.is_file()
            || binary.uid() != 0
            || binary.mode() & 0o022 != 0
            || binary.mode() & 0o111 == 0
        {
            return Err(Error::InvalidConfig);
        }
        // Fixed mount targets must be directories inside the image, never
        // aliases that could redirect a bind to another destination.
        for name in ["workspace", "tmp", "home", "home/worker", "proc", "dev"] {
            directory(&image_path.join(name), true)?;
        }
        // Shell is resolved inside the image, not against host /bin symlinks.
        validate_shell(&image_path)?;
        let supervisor = image_path.join("usr/lib/orkestr/workspace_exec_supervisor.py");
        directory(supervisor.parent().ok_or(Error::InvalidConfig)?, true)?;
        let helper = fs::symlink_metadata(&supervisor).map_err(|_| Error::InvalidConfig)?;
        if !helper.is_file() || helper.uid() != 0 || helper.mode() & 0o022 != 0 {
            return Err(Error::InvalidConfig);
        }
        Ok(Self {
            image_path,
            supervisor,
            image: Arc::new(image),
            cgroups: cgroup::Root::configured(cgroup_root)?,
        })
    }

    /// Spawn is called only inside Core's consumed WorkspaceExec fence. The
    /// borrowed descriptor is duplicated here and never replaced by a pathname.
    pub fn start(
        &self,
        command: &str,
        workspace: WorkspaceDescriptors<'_>,
        limits: WorkerLimits,
        cancellation: &WorkerCancellation,
        retained: Box<dyn Send>,
    ) -> Result<WorkspaceExecProcess> {
        let directory = File::from(
            workspace
                .workspace()
                .try_clone_to_owned()
                .map_err(|_| Error::Io)?,
        );
        self.start_directory(command, directory, limits, cancellation, retained)
    }
    fn start_directory(
        &self,
        command: &str,
        directory: File,
        limits: WorkerLimits,
        cancellation: &WorkerCancellation,
        retained: Box<dyn Send>,
    ) -> Result<WorkspaceExecProcess> {
        if command.is_empty()
            || command.len() > 32768
            || command.contains('\0')
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
        let meta = fs::symlink_metadata(&self.image_path).map_err(|_| Error::InvalidConfig)?;
        let pinned = self.image.metadata().map_err(|_| Error::Io)?;
        if meta.dev() != pinned.dev()
            || meta.ino() != pinned.ino()
            || meta.mode() & 0o022 != 0
            || meta.uid() != 0
            || !meta.is_dir()
        {
            return Err(Error::InvalidConfig);
        }
        if !directory.metadata().map_err(|_| Error::Io)?.is_dir() {
            return Err(Error::InvalidConfig);
        }
        let slot = Slot::acquire()?;
        let job = self.cgroups.job()?;
        let policy = linux::filter()?;
        let deadline = Instant::now() + limits.timeout;
        let (readiness, notify) = std::os::unix::net::UnixStream::pair().map_err(|_| Error::Io)?;
        let mut child = Command::new("/usr/bin/python3");
        child
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .args(["-I", "-S", "-B"])
            .arg(&self.supervisor)
            .arg(policy.as_raw_fd().to_string())
            .arg(self.image.as_raw_fd().to_string())
            .arg(directory.as_raw_fd().to_string())
            .arg(job.procs.as_raw_fd().to_string())
            .arg(notify.as_raw_fd().to_string())
            .args(["--", command]);
        linux::configure(
            &mut child,
            [
                policy.as_raw_fd(),
                self.image.as_raw_fd(),
                directory.as_raw_fd(),
                job.procs.as_raw_fd(),
                notify.as_raw_fd(),
            ],
            limits.timeout,
        );
        process::start(
            child,
            job,
            (self.image.clone(), directory, policy, notify),
            readiness,
            limits,
            deadline,
            slot,
            retained,
        )
    }
}

fn validate_shell(image: &Path) -> Result<()> {
    use std::collections::VecDeque;
    use std::path::Component;
    let mut pending: VecDeque<_> = ["bin", "sh"]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect();
    let mut path = image.to_path_buf();
    let mut links = 0;
    while let Some(part) = pending.pop_front() {
        path.push(part);
        let meta = fs::symlink_metadata(&path).map_err(|_| Error::InvalidConfig)?;
        if meta.uid() != 0 || (!meta.is_symlink() && meta.mode() & 0o022 != 0) {
            return Err(Error::InvalidConfig);
        }
        if meta.is_symlink() {
            links += 1;
            if links > 16 {
                return Err(Error::InvalidConfig);
            }
            let target = fs::read_link(&path).map_err(|_| Error::InvalidConfig)?;
            path.pop();
            if target.is_absolute() {
                path = image.into();
            }
            let mut pieces = VecDeque::new();
            for component in target.components() {
                match component {
                    Component::Normal(part) => pieces.push_back(part.to_os_string()),
                    Component::RootDir | Component::CurDir => (),
                    // Reject complex aliases; the image builder can normalize.
                    _ => return Err(Error::InvalidConfig),
                }
            }
            pieces.append(&mut pending);
            pending = pieces;
        } else if pending.is_empty() {
            if !meta.is_file() || meta.mode() & 0o111 == 0 {
                return Err(Error::InvalidConfig);
            }
        } else if !meta.is_dir() {
            return Err(Error::InvalidConfig);
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
