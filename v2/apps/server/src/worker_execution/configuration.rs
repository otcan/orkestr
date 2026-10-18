use super::WorkerPolicy;
use sha2::{Digest, Sha256};
use std::{io::Read, path::PathBuf};

/// Trusted bootstrap composition only, not Deserialize or an HTTP request type.
/// Paths and digest come from the already reviewed private server configuration.
#[derive(Clone)]
pub struct WorkerConfiguration {
    pub policy: WorkerPolicy,
    pub launcher: PathBuf,
    pub launcher_sha256: String,
    pub workspace: PathBuf,
    pub directory: PathBuf,
    pub controls: crate::control_registry::ControlRegistry,
    pub children: crate::owned_children::ChildSet,
    pub tasks: crate::worker_tasks::WorkerTaskAccess,
}

impl WorkerConfiguration {
    pub(super) fn validate(&self) -> Result<(), &'static str> {
        self.policy.validate()?;
        for directory in [&self.workspace, &self.directory] {
            if !directory.is_absolute()
                || !directory.is_dir()
                || directory.canonicalize().ok().as_ref() != Some(directory)
            {
                return Err("Worker configuration requires canonical directories");
            }
        }
        if self.workspace.starts_with(&self.directory)
            || self.directory.starts_with(&self.workspace)
        {
            return Err("Worker scratch and provider workspace must be separate");
        }
        self.verify_launcher()
    }

    pub(super) fn verify_launcher(&self) -> Result<(), &'static str> {
        let path = &self.launcher;
        if !path.is_absolute() || path.canonicalize().ok().as_ref() != Some(path) {
            return Err("Worker launcher must be canonical");
        }
        let mut file = std::fs::File::open(path).map_err(|_| "Worker launcher unavailable")?;
        let metadata = file.metadata().map_err(|_| "Worker launcher unavailable")?;
        if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
            return Err("Worker launcher exceeds bounds");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() != 1 || metadata.mode() & 0o022 != 0 || metadata.mode() & 0o111 == 0
            {
                return Err("Worker launcher must be private executable code");
            }
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Worker launcher unavailable")?;
        if bytes.len() > 16 * 1024 * 1024
            || self.launcher_sha256.len() != 64
            || format!("{:x}", Sha256::digest(bytes)) != self.launcher_sha256
        {
            return Err("Worker launcher checksum mismatch");
        }
        Ok(())
    }
}
