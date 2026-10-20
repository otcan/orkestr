//! Trusted owner command profile. Built only from closed operator configuration;
//! no browser, provider or model input can select a field here.
use std::{
    path::{Component, Path, PathBuf},
    time::Duration,
};

/// Hard ceilings, independent of operator configuration.
pub const MAX_SYNC_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_SYNC_OUTPUT: usize = 128 * 1024;
pub const MAX_JOB_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub const MAX_JOB_OUTPUT: usize = 16 * 1024 * 1024;
pub const MAX_JOBS: usize = 4;
const MAX_MOUNTS: usize = 64;
const MAX_ENVIRONMENT: usize = 64;

/// Fixed host `/etc` entries a host-root command may read. Never the whole
/// directory: host service configuration and private keys stay absent.
pub const HOST_ETC: &[&str] = &[
    "alternatives",
    "ca-certificates",
    "ca-certificates.conf",
    "gai.conf",
    "group",
    "host.conf",
    "hosts",
    "ld.so.cache",
    "ld.so.conf",
    "ld.so.conf.d",
    "localtime",
    "mime.types",
    "nsswitch.conf",
    "passwd",
    "protocols",
    "resolv.conf",
    "services",
    "ssl",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MountKind {
    /// Read-only toolchain or SDK directory (rustup, node, gh, ...).
    Toolchain,
    /// Read-write cache directory (cargo registry, npm cache, ...).
    Cache,
    /// Read-only credential file or directory. Empty unless explicitly listed.
    Credential,
    /// Read-only skill directory. Empty unless explicitly listed.
    Skill,
}
impl MountKind {
    pub fn writable(self) -> bool {
        self == Self::Cache
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mount {
    pub kind: MountKind,
    /// Absolute host path, bound at the same path inside the sandbox.
    pub path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resources {
    pub memory_bytes: u64,
    pub pids: u32,
    pub cpus: u32,
    pub tmp_bytes: u64,
    pub home_bytes: u64,
    pub file_bytes: u64,
    pub open_files: u32,
}
impl Resources {
    /// Exactly the restricted beta.3 command limits.
    pub const RESTRICTED: Self = Self {
        memory_bytes: 2 * 1024 * 1024 * 1024,
        pids: 64,
        cpus: 2,
        tmp_bytes: 64 * 1024 * 1024,
        home_bytes: 16 * 1024 * 1024,
        file_bytes: 256 * 1024 * 1024,
        open_files: 256,
    };
    fn valid(&self) -> bool {
        (256 * 1024 * 1024..=64 * 1024 * 1024 * 1024).contains(&self.memory_bytes)
            && (16..=4096).contains(&self.pids)
            && (1..=16).contains(&self.cpus)
            && (1024 * 1024..=16 * 1024 * 1024 * 1024).contains(&self.tmp_bytes)
            && (1024 * 1024..=4 * 1024 * 1024 * 1024).contains(&self.home_bytes)
            && (1024 * 1024..=64 * 1024 * 1024 * 1024).contains(&self.file_bytes)
            && (64..=65536).contains(&self.open_files)
    }
}

/// Validated trusted profile. Credentials and skills default to empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedProfile {
    pub network: bool,
    /// Use the host `/usr` plus fixed `/etc` entries instead of the image root.
    pub host_root: bool,
    pub workspace_target: PathBuf,
    pub home: PathBuf,
    pub path: Vec<PathBuf>,
    pub mounts: Vec<Mount>,
    /// Non-secret operator environment, e.g. `CARGO_HOME`.
    pub environment: Vec<(String, String)>,
    /// Credential `KEY=VALUE` files read at each command start. Default empty.
    pub credential_env_files: Vec<PathBuf>,
    pub resources: Resources,
    pub sync_timeout: Duration,
    pub sync_output: usize,
    pub job_timeout: Duration,
    pub job_output: usize,
    pub max_jobs: usize,
}

pub(crate) fn clean_absolute(path: &Path) -> bool {
    path.is_absolute()
        && path != Path::new("/")
        && path
            .to_str()
            .is_some_and(|text| !text.contains('\0') && text.len() <= 4096 && !text.ends_with('/'))
        && path
            .components()
            .skip(1)
            .all(|part| matches!(part, Component::Normal(_)))
}

/// Names that would change host-side supervisor/bwrap behaviour, or that the
/// fixed layout owns. Operator and credential files cannot override them.
pub fn environment_key_allowed(key: &str) -> bool {
    let mut bytes = key.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_uppercase() || b == b'_')
        && bytes.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        && key.len() <= 128
        && !key.starts_with("LD_")
        && !key.starts_with("PYTHON")
        && !key.starts_with("BWRAP")
        && !matches!(
            key,
            "HOME" | "PATH" | "PWD" | "TMPDIR" | "LANG" | "SHELL" | "BASH_ENV" | "ENV" | "IFS"
        )
}

pub(crate) fn environment_value_allowed(value: &str) -> bool {
    value.len() <= 16384 && !value.contains('\0')
}

/// Host locations that never enter a command: kernel/runtime interfaces,
/// service sockets, and the root of the host itself.
const FORBIDDEN_MOUNTS: &[&str] = &["/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/etc"];

impl TrustedProfile {
    /// `reserved` are host paths no mount may equal, contain or enter: the
    /// Orkestr home, cgroup root, provider workspaces and the project itself.
    pub fn validate(&self, reserved: &[&Path]) -> Result<(), &'static str> {
        let fixed = [self.workspace_target.as_path(), self.home.as_path()];
        if self.sync_timeout.is_zero()
            || self.sync_timeout > MAX_SYNC_TIMEOUT
            || !(1024..=MAX_SYNC_OUTPUT).contains(&self.sync_output)
            || self.job_timeout > MAX_JOB_TIMEOUT
            || self.max_jobs > MAX_JOBS
            || (self.max_jobs > 0
                && (self.job_timeout.is_zero()
                    || !(1024..=MAX_JOB_OUTPUT).contains(&self.job_output)))
            || !self.resources.valid()
            || !fixed.iter().all(|path| clean_absolute(path))
            || self.workspace_target.starts_with(&self.home)
            || self.home.starts_with(&self.workspace_target)
            || self.path.is_empty()
            || self.path.len() > 32
            || !self.path.iter().all(|path| {
                clean_absolute(path) && !path.as_os_str().to_string_lossy().contains(':')
            })
            || self.mounts.len() > MAX_MOUNTS
            || self.environment.len() > MAX_ENVIRONMENT
            || self.credential_env_files.len() > 16
        {
            return Err("invalid trusted workspace command limits");
        }
        if !self.host_root && !self.mounts.is_empty() {
            return Err("trusted mounts require the host toolchain root");
        }
        if !self.host_root
            && (self.workspace_target != Path::new("/workspace")
                || self.home != Path::new("/home/worker"))
        {
            return Err("image root requires its fixed mount targets");
        }
        for target in fixed {
            if [
                "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc", "/dev", "/tmp",
            ]
            .iter()
            .any(|system| target.starts_with(system) || Path::new(system).starts_with(target))
            {
                return Err("trusted mount target overlaps the fixed layout");
            }
        }
        let mut seen = std::collections::BTreeSet::new();
        for (key, value) in &self.environment {
            if !environment_key_allowed(key)
                || !environment_value_allowed(value)
                || !seen.insert(key)
            {
                return Err("invalid trusted command environment");
            }
        }
        for file in &self.credential_env_files {
            if !clean_absolute(file) || reserved.iter().any(|r| overlaps(file, r)) {
                return Err("invalid credential environment file");
            }
        }
        for (index, mount) in self.mounts.iter().enumerate() {
            let path = &mount.path;
            if !clean_absolute(path)
                || FORBIDDEN_MOUNTS
                    .iter()
                    .any(|f| overlaps(path, Path::new(f)))
                || ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/tmp"]
                    .iter()
                    .any(|system| Path::new(system).starts_with(path))
                || reserved.iter().any(|r| overlaps(path, r))
                || fixed.iter().any(|f| f.starts_with(path))
                || path.starts_with(&self.workspace_target)
                || self.mounts[index + 1..]
                    .iter()
                    .any(|other| other.path == *path)
            {
                return Err("trusted mount overlaps a protected location");
            }
        }
        Ok(())
    }

    pub fn credentials_exposed(&self) -> bool {
        !self.credential_env_files.is_empty()
            || self
                .mounts
                .iter()
                .any(|m| matches!(m.kind, MountKind::Credential | MountKind::Skill))
    }
}

/// True when either path equals or contains the other.
pub(crate) fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn profile() -> TrustedProfile {
        TrustedProfile {
            network: true,
            host_root: true,
            workspace_target: "/srv/project".into(),
            home: "/home/worker".into(),
            path: vec!["/opt/toolchain/bin".into(), "/usr/bin".into()],
            mounts: vec![
                Mount {
                    kind: MountKind::Toolchain,
                    path: "/opt/toolchain".into(),
                },
                Mount {
                    kind: MountKind::Cache,
                    path: "/var/cache/example-builds".into(),
                },
            ],
            environment: vec![("CARGO_HOME".into(), "/var/cache/example-builds".into())],
            credential_env_files: vec![],
            resources: Resources::RESTRICTED,
            sync_timeout: Duration::from_secs(30),
            sync_output: 128 * 1024,
            job_timeout: Duration::from_secs(1800),
            job_output: 1024 * 1024,
            max_jobs: 2,
        }
    }

    #[test]
    fn default_trusted_profile_has_no_credentials_and_validates() {
        let valid = profile();
        valid.validate(&[Path::new("/srv/orkestr-home")]).unwrap();
        assert!(!valid.credentials_exposed());
    }

    #[test]
    fn mounts_cannot_reach_protected_or_system_locations() {
        let reserved = [
            Path::new("/srv/orkestr-home"),
            Path::new("/sys/fs/cgroup/x"),
        ];
        for path in [
            "/",
            "/proc",
            "/proc/1",
            "/sys/fs",
            "/dev",
            "/run",
            "/run/user/1/bus",
            "/etc",
            "/etc/shadow",
            "/usr",
            "/srv",
            "/srv/orkestr-home",
            "/srv/orkestr-home/secrets",
            "/srv/project",
            "/srv/project/sub",
            "/home",
            "/relative/../escape",
        ] {
            let mut bad = profile();
            bad.mounts.push(Mount {
                kind: MountKind::Credential,
                path: path.into(),
            });
            assert!(bad.validate(&reserved).is_err(), "{path}");
        }
        let mut duplicate = profile();
        duplicate.mounts.push(duplicate.mounts[0].clone());
        assert!(duplicate.validate(&reserved).is_err());
        let mut image = profile();
        image.host_root = false;
        assert!(
            image.validate(&reserved).is_err(),
            "image root cannot take mounts"
        );
    }

    #[test]
    fn host_side_environment_names_and_limits_are_closed() {
        for key in [
            "LD_PRELOAD",
            "PYTHONPATH",
            "PATH",
            "HOME",
            "lower",
            "1X",
            "BASH_ENV",
            "",
        ] {
            let mut bad = profile();
            bad.environment.push((key.into(), "x".into()));
            assert!(bad.validate(&[]).is_err(), "{key}");
        }
        let mut bad = profile();
        bad.job_timeout = MAX_JOB_TIMEOUT + Duration::from_secs(1);
        assert!(bad.validate(&[]).is_err());
        let mut bad = profile();
        bad.sync_timeout = Duration::from_secs(31);
        assert!(bad.validate(&[]).is_err());
        let mut bad = profile();
        bad.resources.pids = 1_000_000;
        assert!(bad.validate(&[]).is_err());
        let mut bad = profile();
        bad.path.push("/opt/a:/opt/b".into());
        assert!(bad.validate(&[]).is_err());
        let mut bad = profile();
        bad.workspace_target = "/tmp/project".into();
        assert!(bad.validate(&[]).is_err());
    }
}
