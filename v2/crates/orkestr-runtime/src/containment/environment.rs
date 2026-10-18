use super::Error;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Explicit caller-owned directories, never inherited provider/login homes.
/// The trusted operator must maintain ownership throughout the child lifetime.
#[derive(Clone)]
pub struct ChildDirectories {
    workspace: PathBuf,
    home: PathBuf,
    temporary: PathBuf,
}

impl ChildDirectories {
    pub fn new(workspace: &Path, home: &Path, temporary: &Path) -> Result<Self, Error> {
        fn canonical(path: &Path) -> Result<PathBuf, Error> {
            if !path.is_absolute() || !path.is_dir() {
                return Err(Error::InvalidPath);
            }
            let actual = path.canonicalize().map_err(|_| Error::InvalidPath)?;
            if actual != path {
                return Err(Error::InvalidPath);
            }
            Ok(actual)
        }
        Ok(Self {
            workspace: canonical(workspace)?,
            home: canonical(home)?,
            temporary: canonical(temporary)?,
        })
    }

    pub(super) fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub(super) fn configure(&self, command: &mut Command) {
        // No parent environment lookup and no generic environment override API.
        command.env_clear().current_dir(&self.workspace);
        command.env("PATH", "/usr/bin:/bin");
        command.env("LANG", "C.UTF-8");
        command.env("LC_ALL", "C.UTF-8");
        command.env("HOME", &self.home);
        command.env("TMPDIR", &self.temporary);
    }
}
