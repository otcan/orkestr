//! Reuse only the exact private broker scratch directories after trusted retirement.
use std::path::{Path, PathBuf};

pub(super) fn create(home: &Path) -> Result<PathBuf, &'static str> {
    let directory = home.join("owned-execution");
    for path in [&directory, &directory.join("home"), &directory.join("tmp")] {
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(path)
            .map_err(|_| "fresh private execution directory required")?;
    }
    Ok(directory)
}

pub(super) fn existing(home: &Path) -> Result<PathBuf, &'static str> {
    let directory = home.join("owned-execution");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let owner = std::fs::metadata(home)
            .map_err(|_| "execution home unavailable")?
            .uid();
        for path in [&directory, &directory.join("home"), &directory.join("tmp")] {
            let info =
                std::fs::symlink_metadata(path).map_err(|_| "execution directory unavailable")?;
            if !info.is_dir()
                || info.uid() != owner
                || info.mode() & 0o777 != 0o700
                || path.canonicalize().ok().as_deref() != Some(path.as_path())
            {
                return Err("execution directory is not private and canonical");
            }
        }
        Ok(directory)
    }
    #[cfg(not(unix))]
    {
        Err("owned execution requires Unix file ownership checks")
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn recovery_preserves_private_scratch_and_refuses_aliases_or_shared_modes() {
        let home =
            std::env::temp_dir().join(format!("owned-recovery-dir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&home).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let directory = create(&home).unwrap();
        std::fs::write(directory.join("home/kept"), b"synthetic retained bytes").unwrap();
        assert_eq!(existing(&home).unwrap(), directory);
        assert!(create(&home).is_err());
        assert_eq!(
            std::fs::read(directory.join("home/kept")).unwrap(),
            b"synthetic retained bytes"
        );
        let tmp = directory.join("tmp");
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(existing(&home).is_err());
        std::fs::remove_dir(&tmp).unwrap();
        symlink(directory.join("home"), &tmp).unwrap();
        assert!(existing(&home).is_err());
        std::fs::remove_dir_all(home).unwrap();
    }
}
