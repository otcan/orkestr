//! Read-only, Root-controlled maintenance custody outside the Core home.
//! Missing markers admit work only while the pinned protected directory remains
//! unchanged. Any ambiguous custody holds admission; Core never removes files.
use std::path::{Path, PathBuf};

const REFUSED: &str = "deploy maintenance custody refused";

#[cfg(target_os = "linux")]
pub(crate) struct Marker {
    parent: PathBuf,
    directory: std::fs::File,
    name: std::ffi::OsString,
}

#[cfg(target_os = "linux")]
impl Marker {
    pub(crate) fn bind(path: &Path, home: &Path) -> Result<Self, &'static str> {
        use std::os::unix::fs::OpenOptionsExt;
        if !crate::beta_config::conversation_workspace_path(path) || path.starts_with(home) {
            return Err(REFUSED);
        }
        let parent = path.parent().ok_or(REFUSED)?.to_owned();
        let name = path.file_name().ok_or(REFUSED)?.to_owned();
        protected_directory(&parent)?;
        let directory = std::fs::OpenOptions::new()
            .read(true)
            // O_DIRECTORY | O_NOFOLLOW; this module is Linux-only.
            .custom_flags(0x10000 | 0x20000)
            .open(&parent)
            .map_err(|_| REFUSED)?;
        let marker = Self {
            parent,
            directory,
            name,
        };
        marker.directory_unchanged()?;
        Ok(marker)
    }

    fn directory_unchanged(&self) -> Result<(), &'static str> {
        use std::os::unix::fs::MetadataExt;
        let path = protected_directory(&self.parent)?;
        let pinned = self.directory.metadata().map_err(|_| REFUSED)?;
        if (path.dev(), path.ino()) != (pinned.dev(), pinned.ino()) {
            return Err(REFUSED);
        }
        Ok(())
    }

    pub(crate) fn held(&self) -> bool {
        use std::os::fd::AsRawFd;
        // Resolve only the final entry against our retained directory identity.
        // A renamed/replaced ancestor or directory never converts a hold into
        // an absent marker. Do not follow the marker itself, or read contents.
        let path =
            PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd())).join(&self.name);
        if self.directory_unchanged().is_err() {
            return true;
        }
        let held = match std::fs::symlink_metadata(path) {
            Ok(_) => true,
            Err(error) => error.kind() != std::io::ErrorKind::NotFound,
        };
        held || self.directory_unchanged().is_err()
    }
}

#[cfg(target_os = "linux")]
fn protected_directory(path: &Path) -> Result<std::fs::Metadata, &'static str> {
    use std::os::unix::fs::MetadataExt;
    if std::fs::canonicalize(path).map_err(|_| REFUSED)? != path {
        return Err(REFUSED);
    }
    for component in path.ancestors() {
        let info = std::fs::symlink_metadata(component).map_err(|_| REFUSED)?;
        if !info.is_dir()
            || info.file_type().is_symlink()
            || info.uid() != 0
            || info.mode() & 0o022 != 0
        {
            return Err(REFUSED);
        }
    }
    std::fs::symlink_metadata(path).map_err(|_| REFUSED)
}

#[cfg(not(target_os = "linux"))]
pub(crate) struct Marker;
#[cfg(not(target_os = "linux"))]
impl Marker {
    pub(crate) fn bind(_: &Path, _: &Path) -> Result<Self, &'static str> {
        Err(REFUSED)
    }
    pub(crate) fn held(&self) -> bool {
        true
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "deploy_maintenance_tests.rs"]
mod tests;
