//! Fresh server-owned scratch directories. This is not an OS sandbox or vault.
use orkestr_runtime::containment::ChildDirectories;
use std::path::{Path, PathBuf};

pub(super) struct Directory {
    path: PathBuf,
    #[cfg(unix)]
    identity: (u64, u64),
}

impl Directory {
    pub(super) fn create(root: &Path) -> Result<Self, &'static str> {
        #[cfg(not(unix))]
        {
            let _ = root;
            Err("owned Worker directories require Unix ownership checks")
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, MetadataExt};
            let metadata =
                std::fs::symlink_metadata(root).map_err(|_| "Worker directory root unavailable")?;
            if !root.is_absolute()
                || root.canonicalize().ok().as_deref() != Some(root)
                || !metadata.is_dir()
                || metadata.mode() & 0o777 != 0o700
            {
                return Err("Worker directory root must be canonical and private");
            }
            let path = root.join(format!("worker-{}", uuid::Uuid::new_v4()));
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&path)
                .map_err(|_| "fresh Worker directory required")?;
            let created = std::fs::symlink_metadata(&path)
                .map_err(|_| "Worker directory identity unavailable")?;
            let result = Self {
                path,
                identity: (created.dev(), created.ino()),
            };
            if created.uid() != metadata.uid() {
                return Err("Worker directory owner mismatch");
            }
            for name in ["home", "tmp"] {
                std::fs::DirBuilder::new()
                    .mode(0o700)
                    .create(result.path.join(name))
                    .map_err(|_| "fresh Worker child directory required")?;
            }
            Ok(result)
        }
    }

    pub(super) fn child(&self, workspace: &Path) -> Result<ChildDirectories, &'static str> {
        ChildDirectories::new(workspace, &self.path.join("home"), &self.path.join("tmp"))
            .map_err(|_| "Worker child directories unavailable")
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if let Ok(current) = std::fs::symlink_metadata(&self.path) {
                // Do not follow a replaced path to delete someone else's state.
                if current.is_dir() && (current.dev(), current.ino()) == self.identity {
                    let _ = std::fs::remove_dir_all(&self.path);
                }
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn fresh_directories_are_distinct_and_cleanup_never_follows_replacement() {
        let fixture = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(format!("worker-directory-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&fixture).unwrap();
        std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o700)).unwrap();
        let first = Directory::create(&fixture).unwrap();
        let second = Directory::create(&fixture).unwrap();
        assert_ne!(first.path, second.path);
        assert!(first.child(&fixture).is_ok());
        let first_path = first.path.clone();
        drop(first);
        assert!(!first_path.exists());
        let preserved = fixture.join("preserved");
        std::fs::rename(&second.path, &preserved).unwrap();
        std::fs::write(preserved.join("sentinel"), "synthetic").unwrap();
        symlink(&preserved, &second.path).unwrap();
        drop(second);
        assert_eq!(
            std::fs::read_to_string(preserved.join("sentinel")).unwrap(),
            "synthetic"
        );
        let alias = fixture.join("alias");
        symlink(&preserved, &alias).unwrap();
        assert!(Directory::create(&alias).is_err());
        std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Directory::create(&fixture).is_err());
        std::fs::remove_dir_all(fixture).unwrap();
    }
}
