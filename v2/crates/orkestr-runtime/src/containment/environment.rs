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
    /// Owner turn preference for a Claude launcher (model, effort); closed
    /// values only, never a path, account or credential.
    claude_launch: Option<(Option<String>, Option<String>)>,
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
            claude_launch: None,
        })
    }

    /// Pass the conversation's Claude model/effort to the trusted launcher.
    pub fn with_claude_launch(
        mut self,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<Self, Error> {
        let model_ok = |m: &str| orkestr_v2_contracts::launch_model_valid(m);
        if model.is_some_and(|m| !model_ok(m))
            || effort.is_some_and(|e| !orkestr_v2_contracts::CLAUDE_EFFORTS.contains(&e))
        {
            return Err(Error::InvalidPath);
        }
        self.claude_launch = Some((model.map(str::to_owned), effort.map(str::to_owned)));
        Ok(self)
    }

    pub(super) fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub(super) fn configure(&self, command: &mut Command) {
        // No parent environment lookup and no generic environment override API.
        command.current_dir(&self.workspace);
        self.configure_without_cwd(command);
    }

    pub(super) fn configure_without_cwd(&self, command: &mut Command) {
        command.env_clear();
        command.env("PATH", "/usr/bin:/bin");
        command.env("LANG", "C.UTF-8");
        command.env("LC_ALL", "C.UTF-8");
        command.env("HOME", &self.home);
        command.env("TMPDIR", &self.temporary);
        if let Some((model, effort)) = &self.claude_launch {
            if let Some(model) = model {
                command.env("ORKESTR_CLAUDE_MODEL", model);
            }
            if let Some(effort) = effort {
                command.env("ORKESTR_CLAUDE_EFFORT", effort);
            }
        }
    }
}
