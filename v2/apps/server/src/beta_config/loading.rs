//! Read-only operator configuration custody. No credential or provider access.
use super::BetaConfig;
use std::path::Path;

#[cfg(target_os = "linux")]
use {
    sha2::{Digest, Sha256},
    std::{
        fs::{self, File, Metadata, OpenOptions},
        io::Read,
        os::unix::{
            ffi::OsStrExt,
            fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
        },
    },
};

const REFUSED: &str = "beta configuration custody refused";

/// `home` is the ordinary Core data home. This does not connect to the manager,
/// bootstrap an owner, read an account, or confer execution authority.
#[cfg(target_os = "linux")]
pub(crate) fn load(path: &Path, home: &Path) -> Result<BetaConfig, &'static str> {
    let (uid, gid) = identity()?;
    let home_info = private_directory(home, uid, gid)?;
    let raw = protected_bytes(path, gid, false, super::MAX_BETA_CONFIG_BYTES)?;
    let config: BetaConfig = serde_json::from_slice(&raw).map_err(|_| REFUSED)?;
    config.validate()?;
    let workspace_info = private_directory(&config.workspace, uid, gid)?;
    if config.workspace.starts_with(home)
        || home.starts_with(&config.workspace)
        || (home_info.dev(), home_info.ino()) == (workspace_info.dev(), workspace_info.ino())
    {
        return Err(REFUSED);
    }
    for workspace in config.conversation_workspaces.values() {
        workspace.custody(home, uid)?;
    }
    let launcher = protected_bytes(&config.launcher, gid, true, 16 * 1024 * 1024)?;
    if format!("{:x}", Sha256::digest(launcher)) != config.launcher_sha256 {
        return Err(REFUSED);
    }
    if let Some(roles) = &config.roles {
        for role in roles.launches() {
            let info = private_directory(&role.workspace, uid, gid)?;
            if role.workspace.starts_with(home)
                || home.starts_with(&role.workspace)
                || (home_info.dev(), home_info.ino()) == (info.dev(), info.ino())
            {
                return Err(REFUSED);
            }
            let bytes = protected_bytes(&role.launcher, gid, true, 16 * 1024 * 1024)?;
            if format!("{:x}", Sha256::digest(bytes)) != role.launcher_sha256 {
                return Err(REFUSED);
            }
        }
    }
    if let Some(claude) = &config.claude {
        let info = private_directory(&claude.workspace, uid, gid)?;
        if claude.workspace.starts_with(home)
            || home.starts_with(&claude.workspace)
            || (home_info.dev(), home_info.ino()) == (info.dev(), info.ino())
        {
            return Err(REFUSED);
        }
        let bytes = protected_bytes(&claude.launcher, gid, true, 16 * 1024 * 1024)?;
        if format!("{:x}", Sha256::digest(bytes)) != claude.launcher_sha256 {
            return Err(REFUSED);
        }
    }
    for profile in config.workspace_profiles() {
        // Readiness only: no Core project registration, command, or cgroup is
        // created by loading the trusted operator profile.
        profile.installation(
            home,
            std::iter::once(config.workspace.clone()).chain(
                config
                    .roles
                    .iter()
                    .flat_map(|roles| roles.launches().map(|r| r.workspace.clone())),
            ),
        )?;
        let trusted = profile.trusted_profile(
            home,
            std::iter::once(config.workspace.clone()).chain(
                config
                    .roles
                    .iter()
                    .flat_map(|roles| roles.launches().map(|r| r.workspace.clone())),
            ),
            config.host_full_access.as_ref(),
        )?;
        match trusted {
            Some(trusted) => {
                orkestr_runtime::workspace_exec::WorkspaceExecSandbox::configured_trusted(
                    &profile.cgroup_root,
                    &profile.toolchain_root,
                    trusted,
                )
            }
            None => orkestr_runtime::workspace_exec::WorkspaceExecSandbox::configured(
                &profile.cgroup_root,
                &profile.toolchain_root,
            ),
        }
        .map_err(|_| "workspace command sandbox unavailable")?;
    }
    control_socket(&config.manager_socket, gid)?;
    // Recheck custody after the bounded reads; no stale pre-read path approval.
    private_directory(home, uid, gid)?;
    private_directory(&config.workspace, uid, gid)?;
    for workspace in config.conversation_workspaces.values() {
        workspace.custody(home, uid)?;
    }
    protected_chain(path, None)?;
    protected_chain(&config.launcher, None)?;
    if let Some(roles) = &config.roles {
        for role in roles.launches() {
            private_directory(&role.workspace, uid, gid)?;
            protected_chain(&role.launcher, None)?;
        }
    }
    if let Some(claude) = &config.claude {
        private_directory(&claude.workspace, uid, gid)?;
        protected_chain(&claude.launcher, None)?;
    }
    Ok(config)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn load(_: &Path, _: &Path) -> Result<BetaConfig, &'static str> {
    Err("beta service configuration requires Linux custody checks")
}

#[cfg(target_os = "linux")]
fn identity() -> Result<(u32, u32), &'static str> {
    let mut raw = Vec::new();
    File::open("/proc/self/status")
        .map_err(|_| REFUSED)?
        .take(16_385)
        .read_to_end(&mut raw)
        .map_err(|_| REFUSED)?;
    if raw.len() > 16_384 {
        return Err(REFUSED);
    }
    let text = std::str::from_utf8(&raw).map_err(|_| REFUSED)?;
    let field = |name: &str| -> Result<u32, &'static str> {
        let line = text
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .ok_or(REFUSED)?;
        let values: Vec<u32> = line
            .split_whitespace()
            .map(str::parse)
            .collect::<Result<_, _>>()
            .map_err(|_| REFUSED)?;
        if values.len() != 4 || values[0] == 0 || values.iter().any(|id| *id != values[0]) {
            return Err(REFUSED);
        }
        Ok(values[0])
    };
    Ok((field("Uid:")?, field("Gid:")?))
}

#[cfg(target_os = "linux")]
fn canonical(path: &Path) -> Result<(), &'static str> {
    if !path.is_absolute()
        || path.as_os_str().as_bytes().len() > 4096
        || fs::canonicalize(path).map_err(|_| REFUSED)?.as_os_str() != path.as_os_str()
    {
        return Err(REFUSED);
    }
    Ok(())
}

/// Private writable state may have the selected service owner in its ancestry;
/// executable/configuration/socket custody must remain root-controlled.
#[cfg(target_os = "linux")]
fn protected_chain(path: &Path, service_uid: Option<u32>) -> Result<Metadata, &'static str> {
    canonical(path)?;
    let leaf = fs::symlink_metadata(path).map_err(|_| REFUSED)?;
    for (index, part) in path.ancestors().enumerate() {
        let info = fs::symlink_metadata(part).map_err(|_| REFUSED)?;
        if info.file_type().is_symlink()
            || (index != 0 && !info.is_dir())
            || (info.uid() != 0 && Some(info.uid()) != service_uid)
            || info.mode() & 0o022 != 0
        {
            return Err(REFUSED);
        }
    }
    Ok(leaf)
}

#[cfg(target_os = "linux")]
fn private_directory(path: &Path, uid: u32, gid: u32) -> Result<Metadata, &'static str> {
    let info = protected_chain(path, Some(uid))?;
    if !info.is_dir() || info.uid() != uid || info.gid() != gid || info.mode() & 0o7777 != 0o700 {
        return Err(REFUSED);
    }
    Ok(info)
}

#[cfg(target_os = "linux")]
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.mode() == b.mode()
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}

#[cfg(target_os = "linux")]
fn protected_bytes(
    path: &Path,
    gid: u32,
    executable: bool,
    maximum: u64,
) -> Result<Vec<u8>, &'static str> {
    let before = protected_chain(path, None)?;
    // Check the file kind and executable permissions BEFORE reading any bytes.
    if !before.is_file() || before.nlink() != 1 || before.len() > maximum {
        return Err(REFUSED);
    }
    if executable {
        if before.mode() & 0o7000 != 0
            || !((before.gid() == gid && before.mode() & 0o010 != 0) || before.mode() & 0o001 != 0)
        {
            return Err(REFUSED);
        }
    } else if before.gid() != gid || before.mode() & 0o7777 != 0o640 {
        return Err(REFUSED);
    }
    // Linux O_NOFOLLOW|O_NONBLOCK: an alias or special-file replacement must not
    // follow a different target or block the service loader on open/read.
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(0o400000 | 0o4000)
        .open(path)
        .map_err(|_| REFUSED)?;
    if !same(&before, &file.metadata().map_err(|_| REFUSED)?) {
        return Err(REFUSED);
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| REFUSED)?;
    if bytes.len() as u64 != before.len()
        || !same(&before, &file.metadata().map_err(|_| REFUSED)?)
        || !same(&before, &protected_chain(path, None)?)
    {
        return Err(REFUSED);
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn control_socket(path: &Path, gid: u32) -> Result<(), &'static str> {
    canonical(path)?;
    if path.file_name() != Some(std::ffi::OsStr::new("control.sock"))
        || path.as_os_str().as_bytes().len() >= 100
    {
        return Err(REFUSED);
    }
    protected_chain(path.parent().ok_or(REFUSED)?, None)?;
    let info = fs::symlink_metadata(path).map_err(|_| REFUSED)?;
    if !info.file_type().is_socket()
        || info.nlink() != 1
        || info.uid() != 0
        || info.gid() != gid
        || info.mode() & 0o7777 != 0o660
    {
        return Err(REFUSED);
    }
    // This is only pathname custody. ManagerClient still checks the exact live
    // root parent PID/start and SO_PEERCRED before sending any control bytes.
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
#[path = "loading_tests.rs"]
mod tests;
