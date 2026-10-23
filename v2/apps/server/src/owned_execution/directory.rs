//! Reuse only the exact private broker scratch directories after trusted retirement.
use std::path::{Path, PathBuf};

pub(super) fn create(home: &Path) -> Result<PathBuf, &'static str> {
    let directory = home.join("owned-execution");
    create_directory(directory)
}

fn create_directory(directory: PathBuf) -> Result<PathBuf, &'static str> {
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
    existing_directory(home, directory)
}

fn existing_directory(home: &Path, directory: PathBuf) -> Result<PathBuf, &'static str> {
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

fn scoped_root(home: &Path) -> Result<PathBuf, &'static str> {
    let root = home.join("owned-executions");
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        match std::fs::DirBuilder::new().mode(0o700).create(&root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("execution scope root unavailable"),
        }
        let info =
            std::fs::symlink_metadata(&root).map_err(|_| "execution scope root unavailable")?;
        let owner = std::fs::metadata(home)
            .map_err(|_| "execution home unavailable")?
            .uid();
        if !info.is_dir()
            || info.uid() != owner
            || info.mode() & 0o777 != 0o700
            || root.canonicalize().ok().as_deref() != Some(root.as_path())
        {
            return Err("execution scope root is not private and canonical");
        }
        Ok(root)
    }
    #[cfg(not(unix))]
    {
        Err("owned execution requires Unix file ownership checks")
    }
}

pub(super) fn create_for(
    home: &Path,
    conversation: &orkestr_v2_contracts::ConversationId,
) -> Result<PathBuf, &'static str> {
    if conversation.0.is_nil() {
        return Err("execution scope requires a conversation");
    }
    create_directory(scoped_root(home)?.join(conversation.to_string()))
}

pub(super) fn existing_for(
    home: &Path,
    conversation: &orkestr_v2_contracts::ConversationId,
) -> Result<PathBuf, &'static str> {
    if conversation.0.is_nil() {
        return Err("execution scope requires a conversation");
    }
    existing_directory(home, scoped_root(home)?.join(conversation.to_string()))
}

/// A window's scratch custody can survive failed setup or an explicit native
/// reset. This validates private directories only; Core still decides whether
/// the metadata grant selects fresh native setup or a specific native resume.
pub(super) fn window_deep(
    home: &Path,
    conversation: &orkestr_v2_contracts::ConversationId,
) -> Result<PathBuf, &'static str> {
    if conversation.0.is_nil() {
        return Err("execution scope requires a conversation");
    }
    let path = scoped_root(home)?.join(conversation.to_string());
    match std::fs::symlink_metadata(&path) {
        Ok(_) => existing_directory(home, path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => create_directory(path),
        Err(_) => Err("Deep scratch custody unavailable"),
    }
}

/// Fast keeps its own writable home and temporary directory, including when
/// the ordinary Deep factory serves the same canonical conversation.
pub(super) fn fast(
    home: &Path,
    conversation: &orkestr_v2_contracts::ConversationId,
    existing: bool,
) -> Result<PathBuf, &'static str> {
    if conversation.0.is_nil() {
        return Err("Fast scope requires a conversation");
    }
    let path = scoped_root(home)?.join(format!("fast-{conversation}"));
    if existing {
        existing_directory(home, path)
    } else {
        create_directory(path)
    }
}

/// Scratch custody is independent of native resume authority. Core must still
/// issue the exact fresh or predecessor metadata grant before any child starts.
pub(super) fn window_fast(
    home: &Path,
    conversation: &orkestr_v2_contracts::ConversationId,
) -> Result<PathBuf, &'static str> {
    if conversation.0.is_nil() {
        return Err("Fast scope requires a conversation");
    }
    let path = scoped_root(home)?.join(format!("fast-{conversation}"));
    match std::fs::symlink_metadata(&path) {
        Ok(_) => existing_directory(home, path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => create_directory(path),
        Err(_) => Err("Fast scratch custody unavailable"),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn fresh_window_authority_can_reuse_only_private_canonical_scratch() {
        let home =
            std::env::temp_dir().join(format!("window-reset-scratch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&home).unwrap();
        let conversation = orkestr_v2_contracts::ConversationId(uuid::Uuid::new_v4());
        let directory = window_deep(&home, &conversation).unwrap();
        std::fs::write(directory.join("home/retained"), b"synthetic scratch").unwrap();
        assert_eq!(window_deep(&home, &conversation).unwrap(), directory);
        assert_eq!(
            std::fs::read(directory.join("home/retained")).unwrap(),
            b"synthetic scratch"
        );
        std::fs::set_permissions(
            directory.join("tmp"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        assert!(window_deep(&home, &conversation).is_err());
        std::fs::remove_dir_all(home).unwrap();
    }

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
