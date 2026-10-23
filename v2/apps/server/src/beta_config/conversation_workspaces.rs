//! Explicit shared workspace opt-in; ordinary paths retain service ownership.
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum ConversationWorkspace {
    Owned(PathBuf),
    Shared(SharedWorkspace),
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SharedWorkspace {
    path: PathBuf,
    shared: bool,
}

impl ConversationWorkspace {
    pub(crate) fn path(&self) -> &Path {
        match self {
            Self::Owned(path) => path,
            Self::Shared(value) => &value.path,
        }
    }

    pub(crate) fn valid(&self) -> bool {
        super::conversation_workspace_path(self.path())
            && !matches!(self, Self::Shared(value) if !value.shared)
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn custody(&self, home: &Path, uid: u32) -> Result<(), &'static str> {
        use std::{fs, os::unix::fs::MetadataExt};
        let refused = "beta conversation workspace custody refused";
        let path = self.path();
        let fd = rustix::fs::open(
            path,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::DIRECTORY
                | rustix::fs::OFlags::NOFOLLOW,
            rustix::fs::Mode::empty(),
        )
        .map_err(|_| refused)?;
        let file = fs::File::from(fd);
        let info = file.metadata().map_err(|_| refused)?;
        let home_info = fs::metadata(home).map_err(|_| refused)?;
        if !info.is_dir()
            || path.canonicalize().ok().as_deref() != Some(path)
            || path.starts_with(home)
            || home.starts_with(path)
            || (home_info.dev(), home_info.ino()) == (info.dev(), info.ino())
        {
            return Err(refused);
        }
        if info.uid() != uid {
            if !matches!(self, Self::Shared(value) if value.shared) || info.mode() & 0o002 != 0 {
                return Err(refused);
            }
            // The kernel ACL is bounded and read through the directory fd.
            // Group membership or world permissions alone never authorize it.
            let mut bytes = vec![0; 65_536];
            let size = rustix::fs::fgetxattr(&file, "system.posix_acl_access", &mut bytes[..])
                .map_err(|_| refused)?;
            if !named_acl_rwx(&bytes[..size], uid) {
                return Err(refused);
            }
        }
        let after = fs::symlink_metadata(path).map_err(|_| refused)?;
        if !after.is_dir()
            || (
                after.dev(),
                after.ino(),
                after.uid(),
                after.mode(),
                after.ctime(),
                after.ctime_nsec(),
            ) != (
                info.dev(),
                info.ino(),
                info.uid(),
                info.mode(),
                info.ctime(),
                info.ctime_nsec(),
            )
        {
            return Err(refused);
        }
        Ok(())
    }
}

/// Linux POSIX ACL xattr: version 2 followed by little-endian 8-byte entries.
/// A named service-UID entry and its mask must both grant all rwx bits.
#[cfg(target_os = "linux")]
fn named_acl_rwx(bytes: &[u8], uid: u32) -> bool {
    if bytes.len() < 4 || bytes[..4] != 2u32.to_le_bytes() {
        return false;
    }
    let (entries, remainder) = bytes[4..].as_chunks::<8>();
    if !remainder.is_empty() {
        return false;
    }
    let (mut named, mut mask) = (None, None);
    for entry in entries {
        let tag = u16::from_le_bytes([entry[0], entry[1]]);
        let permissions = u16::from_le_bytes([entry[2], entry[3]]);
        let id = u32::from_le_bytes([entry[4], entry[5], entry[6], entry[7]]);
        if permissions & !7 != 0 {
            return false;
        }
        let target = match tag {
            2 if id == uid => Some(&mut named),
            16 => Some(&mut mask),
            _ => None,
        };
        if let Some(target) = target {
            if target.replace(permissions).is_some() {
                return false;
            }
        }
    }
    named == Some(7) && mask == Some(7)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    fn acl(user: u32, permissions: u16, mask: u16) -> Vec<u8> {
        let mut bytes = 2u32.to_le_bytes().to_vec();
        for (tag, perm, id) in [(2u16, permissions, user), (16, mask, u32::MAX)] {
            bytes.extend(tag.to_le_bytes());
            bytes.extend(perm.to_le_bytes());
            bytes.extend(id.to_le_bytes());
        }
        bytes
    }
    #[test]
    fn explicit_uid_and_effective_acl_mask_required() {
        assert!(named_acl_rwx(&acl(123, 7, 7), 123));
        assert!(!named_acl_rwx(&acl(124, 7, 7), 123));
        assert!(!named_acl_rwx(&acl(123, 5, 7), 123));
        assert!(!named_acl_rwx(&acl(123, 7, 5), 123));
        assert!(!named_acl_rwx(&acl(123, 15, 7), 123));
        let mut duplicate = acl(123, 7, 7);
        duplicate.extend_from_slice(&acl(123, 7, 7)[4..12]);
        assert!(!named_acl_rwx(&duplicate, 123));
        assert!(!named_acl_rwx(&[2, 0, 0], 123));
        let mut truncated = acl(123, 7, 7);
        truncated.pop();
        assert!(!named_acl_rwx(&truncated, 123));
    }
}
