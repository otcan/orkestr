//! Refuse database/sidecar aliases before SQLite can create, recover or migrate files.
//! The canonical parent must remain owned by the caller; this is not a filesystem sandbox.
use orkestr_v2_application::{Result, StoreError};
use std::{fs, io::ErrorKind, path::Path};

pub(super) fn validate(path: &Path) -> Result<()> {
    let parent = path.parent().ok_or(StoreError::Invalid)?;
    if !path.is_absolute()
        || path.file_name().is_none()
        || parent.canonicalize().map_err(|_| StoreError::Unavailable)? != parent
    {
        return Err(StoreError::Invalid);
    }
    // Check ALL entries before opening any of them. SQLite can touch sidecars on
    // connection open, even if subsequent migration/schema validation fails.
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        let metadata = match fs::symlink_metadata(Path::new(&name)) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(_) => return Err(StoreError::Unavailable),
        };
        // symlink_metadata does not follow even a dangling symlink.
        if !metadata.file_type().is_file() {
            return Err(StoreError::Invalid);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // Reject every multiply-linked file; no scan of unrelated homes is needed.
            if metadata.nlink() != 1 {
                return Err(StoreError::Invalid);
            }
        }
        // Fail closed until an equivalent hardlink check is implemented off Unix.
        #[cfg(not(unix))]
        return Err(StoreError::Unavailable);
    }
    Ok(())
}
