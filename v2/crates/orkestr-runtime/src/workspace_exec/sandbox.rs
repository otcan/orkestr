//! Trusted image and exact Core descriptor composition. No model-selected paths.
use super::layout;
use super::profile::{Resources, TrustedProfile};
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
/// Background jobs never consume the short-command slots.
static JOBS: AtomicUsize = AtomicUsize::new(0);
pub(super) struct Slot(&'static AtomicUsize);
impl Slot {
    fn acquire(counter: &'static AtomicUsize, maximum: usize) -> Result<Self> {
        counter
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < maximum).then_some(n + 1)
            })
            .map_err(|_| Error::Busy)?;
        Ok(Self(counter))
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Short tool-call command or detached background job.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    Command,
    Job,
}

pub struct WorkspaceExecSandbox {
    image_path: PathBuf,
    image: Arc<File>,
    supervisor: PathBuf,
    cgroups: cgroup::Root,
    trusted: Option<Arc<TrustedProfile>>,
}

const LAYOUT_MARKER: &[u8] = b"ORKESTR_SUPERVISOR_LAYOUT_V1";
const HOST_MARKER: &[u8] = b"ORKESTR_SUPERVISOR_HOST_V1";

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
        Self::configured_with(cgroup_root, toolchain_root, false)
    }

    fn configured_with(cgroup_root: &Path, toolchain_root: &Path, reclaim: bool) -> Result<Self> {
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
            cgroups: cgroup::Root::configured_with(cgroup_root, reclaim)?,
            trusted: None,
        })
    }

    /// Operator-configured trusted profile. Requires the layout-capable
    /// supervisor; the restricted image supervisor is never reinterpreted.
    pub fn configured_trusted(
        cgroup_root: &Path,
        toolchain_root: &Path,
        profile: TrustedProfile,
    ) -> Result<Self> {
        // Host mode has no PID namespace: commands of a crashed previous server
        // can outlive it in their job cgroups and are killed here before reuse.
        let mut sandbox =
            Self::configured_with(cgroup_root, toolchain_root, profile.host.is_some())?;
        profile
            .validate(&[cgroup_root, toolchain_root])
            .map_err(|_| Error::InvalidConfig)?;
        let mut text = Vec::new();
        use std::io::Read;
        File::open(&sandbox.supervisor)
            .and_then(|file| file.take(256 * 1024).read_to_end(&mut text))
            .map_err(|_| Error::InvalidConfig)?;
        let marker = if profile.host.is_some() {
            HOST_MARKER
        } else {
            LAYOUT_MARKER
        };
        if !text.windows(marker.len()).any(|window| window == marker) {
            return Err(Error::InvalidConfig);
        }

        sandbox.trusted = Some(Arc::new(profile));
        Ok(sandbox)
    }

    pub fn trusted(&self) -> Option<&TrustedProfile> {
        self.trusted.as_deref()
    }

    /// Upper bounds a caller may request for one kind of command.
    pub fn limits(&self, kind: CommandKind) -> Option<WorkerLimits> {
        match (&self.trusted, kind) {
            (None, CommandKind::Command) => Some(WorkerLimits {
                timeout: Duration::from_secs(30),
                max_output_bytes: 128 * 1024,
            }),
            (None, CommandKind::Job) => None,
            (Some(profile), CommandKind::Command) => Some(WorkerLimits {
                timeout: profile.sync_timeout,
                max_output_bytes: profile.sync_output,
            }),
            (Some(profile), CommandKind::Job) => (profile.max_jobs > 0).then_some(WorkerLimits {
                timeout: profile.job_timeout,
                max_output_bytes: profile.job_output,
            }),
        }
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
        self.start_directory(
            command,
            directory,
            limits,
            cancellation,
            retained,
            CommandKind::Command,
        )
    }

    /// Detached background job: separate slot pool and the profile's longer
    /// bounds. Containment, cgroup kill and reap witness are identical.
    pub fn start_job(
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
        self.start_directory(
            command,
            directory,
            limits,
            cancellation,
            retained,
            CommandKind::Job,
        )
    }

    pub(super) fn start_directory(
        &self,
        command: &str,
        directory: File,
        limits: WorkerLimits,
        cancellation: &WorkerCancellation,
        retained: Box<dyn Send>,
        kind: CommandKind,
    ) -> Result<WorkspaceExecProcess> {
        let maximum = self.limits(kind).ok_or(Error::InvalidInput)?;
        if command.is_empty()
            || command.len() > 32768
            || command.contains('\0')
            || limits.timeout.is_zero()
            || limits.timeout > maximum.timeout
            || limits.max_output_bytes == 0
            || limits.max_output_bytes > maximum.max_output_bytes
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
        let slot = match (kind, &self.trusted) {
            (CommandKind::Job, Some(profile)) => Slot::acquire(&JOBS, profile.max_jobs)?,
            _ => Slot::acquire(&ACTIVE, 4)?,
        };
        let resources = self
            .trusted
            .as_ref()
            .map_or(Resources::RESTRICTED, |p| p.resources);
        let policy = linux::filter(self.trusted.as_ref().is_some_and(|p| p.network))?;
        // Built (and credential files read) before any cgroup or process exists.
        let host = self.trusted.as_ref().and_then(|p| p.host.as_ref());
        let layout = match (&self.trusted, host) {
            (Some(profile), Some(access)) => Some(layout::host(
                profile,
                access,
                directory.as_raw_fd(),
                layout::credentials(profile)?,
            )?),
            (Some(profile), None) => Some(layout::trusted(
                profile,
                layout::Descriptors {
                    policy: policy.as_raw_fd(),
                    image: self.image.as_raw_fd(),
                    workspace: directory.as_raw_fd(),
                },
                layout::credentials(profile)?,
            )?),
            (None, _) => None,
        };
        let layout = layout
            .map(|layout| linux::sealed(c"orkestr-workspace-layout", &layout::encode(&layout)))
            .transpose()?;
        let job = self.cgroups.job(&resources)?;
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
            .arg(notify.as_raw_fd().to_string());
        if let Some(layout) = &layout {
            child.arg(layout.as_raw_fd().to_string());
        }
        child.args(["--", command]);
        linux::configure(
            &mut child,
            [
                policy.as_raw_fd(),
                self.image.as_raw_fd(),
                directory.as_raw_fd(),
                job.procs.as_raw_fd(),
                notify.as_raw_fd(),
                layout.as_ref().map_or(-1, |l| l.as_raw_fd()),
            ],
            match &self.trusted {
                Some(profile) => linux::Rlimits::trusted(limits.timeout, &profile.resources),
                None => linux::Rlimits::restricted(limits.timeout),
            },
            host.is_none(),
        );
        process::start(
            child,
            job,
            Box::new((self.image.clone(), directory, policy, notify, layout)),
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
#[cfg(test)]
#[path = "tests_trusted.rs"]
mod tests_trusted;
