//! Linux descriptor identity. Trusted operator input only; no HTTP path issuer.
use super::*;
use std::{
    ffi::CString,
    fs::File,
    io::Read,
    os::{
        fd::{AsFd, AsRawFd, FromRawFd, OwnedFd},
        unix::fs::MetadataExt,
    },
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceDirectoryIdentity {
    device: u64,
    inode: u64,
    uid: u32,
}
impl WorkspaceDirectoryIdentity {
    pub fn device(&self) -> u64 {
        self.device
    }
    pub fn inode(&self) -> u64 {
        self.inode
    }
    pub fn uid(&self) -> u32 {
        self.uid
    }
}
pub(super) struct Directory {
    pub(super) file: File,
    path: PathBuf,
    identity: WorkspaceDirectoryIdentity,
}
impl Directory {
    fn open(path: PathBuf, uid: u32) -> Result<Self> {
        let file = open(&path, true)?;
        let meta = file.metadata().map_err(db)?;
        if meta.uid() != uid || meta.mode() & 0o002 != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(Self {
            file,
            path,
            identity: WorkspaceDirectoryIdentity {
                device: meta.dev(),
                inode: meta.ino(),
                uid: meta.uid(),
            },
        })
    }
    fn check(&self) -> Result<()> {
        let current = Self::open(self.path.clone(), self.identity.uid)?;
        let meta = self.file.metadata().map_err(db)?;
        if current.identity != self.identity
            || meta.dev() != self.identity.device
            || meta.ino() != self.identity.inode
            || meta.uid() != self.identity.uid
            || meta.mode() & 0o002 != 0
        {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
}
/// Closed operator allowlist. Construction is trusted local bootstrap, never a
/// browser request or imported inventory. No inference or filesystem containment.
pub struct WorkspaceOperatorAllowlist {
    roots: Vec<PathBuf>,
    protected: Vec<PathBuf>,
    uid: u32,
}
pub struct WorkspaceInstallation {
    pub(super) inner: Arc<Installation>,
}
pub(super) struct Installation {
    pub(super) workspace: Directory,
    pub(super) git: Directory,
    pub(super) common: Directory,
}
impl WorkspaceOperatorAllowlist {
    pub fn new(roots: Vec<PathBuf>, protected: Vec<PathBuf>, operator_uid: u32) -> Result<Self> {
        if roots.is_empty() || roots.len() > 32 || protected.is_empty() || protected.len() > 64 {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let roots = roots
            .into_iter()
            .map(|p| normal(&p))
            .collect::<Result<Vec<_>>>()?;
        for (i, root) in roots.iter().enumerate() {
            if root == Path::new("/")
                || roots.iter().enumerate().any(|(j, other)| {
                    i != j && (root.starts_with(other) || other.starts_with(root))
                })
            {
                return Err(RuntimeStoreError::InvalidInput);
            }
        }
        let protected = protected
            .into_iter()
            .map(|p| normal(&p))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            roots,
            protected,
            uid: operator_uid,
        })
    }
    pub fn installation(&self, selected: &Path) -> Result<WorkspaceInstallation> {
        let selected = normal(selected)?;
        if !self.roots.contains(&selected) {
            return Err(RuntimeStoreError::Fenced);
        }
        let (git, common) = association(&selected)?;
        let installation = Installation {
            workspace: Directory::open(selected, self.uid)?,
            git: Directory::open(git, self.uid)?,
            common: Directory::open(common, self.uid)?,
        };
        for protected in &self.protected {
            installation.reject_overlap(protected)?;
        }
        installation.check()?;
        Ok(WorkspaceInstallation {
            inner: Arc::new(installation),
        })
    }
}
impl Installation {
    pub(super) fn reject_overlap(&self, protected: &Path) -> Result<()> {
        for dir in [&self.workspace, &self.git, &self.common] {
            if dir.path.starts_with(protected) || protected.starts_with(&dir.path) {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        Ok(())
    }
    pub(super) fn check(&self) -> Result<()> {
        for dir in [&self.workspace, &self.git, &self.common] {
            dir.check()?;
        }
        let (git, common) = association(&self.workspace.path)?;
        if git != self.git.path || common != self.common.path {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
    pub(super) fn fingerprint(&self) -> String {
        let dirs = [&self.workspace, &self.git, &self.common];
        let value: Vec<_> = dirs
            .iter()
            .map(|d| {
                serde_json::json!([
                    d.path.to_string_lossy(),
                    d.identity.device,
                    d.identity.inode,
                    d.identity.uid
                ])
            })
            .collect();
        serde_json::to_string(&value).expect("fixed JSON values")
    }
    pub(super) fn descriptors(&self) -> WorkspaceDescriptors<'_> {
        WorkspaceDescriptors { inner: self }
    }
}
pub struct WorkspaceDescriptors<'a> {
    inner: &'a Installation,
}
impl<'a> WorkspaceDescriptors<'a> {
    pub fn workspace(&self) -> std::os::fd::BorrowedFd<'a> {
        self.inner.workspace.file.as_fd()
    }
    pub fn git_directory(&self) -> std::os::fd::BorrowedFd<'a> {
        self.inner.git.file.as_fd()
    }
    pub fn git_common_directory(&self) -> std::os::fd::BorrowedFd<'a> {
        self.inner.common.file.as_fd()
    }
    pub fn workspace_identity(&self) -> WorkspaceDirectoryIdentity {
        self.inner.workspace.identity
    }
    pub fn git_directory_identity(&self) -> WorkspaceDirectoryIdentity {
        self.inner.git.identity
    }
    pub fn git_common_directory_identity(&self) -> WorkspaceDirectoryIdentity {
        self.inner.common.identity
    }
}
fn normal(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute()
        || path.as_os_str().as_encoded_bytes().len() > 4096
        || path.to_str().is_none()
    {
        return Err(RuntimeStoreError::InvalidInput);
    }
    let mut result = PathBuf::from("/");
    for c in path.components() {
        match c {
            Component::RootDir | Component::CurDir => (),
            Component::Normal(p) => result.push(p),
            Component::ParentDir => {
                if !result.pop() {
                    return Err(RuntimeStoreError::InvalidInput);
                }
            }
            _ => return Err(RuntimeStoreError::InvalidInput),
        }
    }
    Ok(result)
}
// openat(O_NOFOLLOW) on EVERY component: no intermediate symlink traversal.
// Linux64 only. No process-global chdir and no path reopen by consumers.
fn open(path: &Path, directory: bool) -> Result<File> {
    unsafe extern "C" {
        fn openat(dirfd: i32, path: *const std::ffi::c_char, flags: i32, ...) -> i32;
    }
    let path = normal(path)?;
    let mut parent = File::open("/").map_err(db)?;
    let parts: Vec<_> = path
        .components()
        .filter_map(|c| {
            if let Component::Normal(v) = c {
                Some(v)
            } else {
                None
            }
        })
        .collect();
    for (i, part) in parts.iter().enumerate() {
        let name = CString::new(part.as_encoded_bytes()).map_err(db)?;
        let flags = 0o2000000
            | 0o400000
            | 0o4000
            | if i + 1 < parts.len() || directory {
                0o200000
            } else {
                0
            };
        // SAFETY: valid borrowed directory FD and nul-terminated name; O_CREAT
        // is absent. A successful fresh descriptor is immediately owned once.
        let fd = unsafe { openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        // SAFETY: openat returned a fresh owned descriptor, not aliased ownership.
        let owned = unsafe { OwnedFd::from_raw_fd(fd) };
        parent = File::from(owned);
    }
    Ok(parent)
}
fn small(path: &Path) -> Result<String> {
    let mut value = String::new();
    let file = open(path, false)?;
    if !file.metadata().map_err(db)?.is_file() {
        return Err(RuntimeStoreError::Fenced);
    }
    file.take(8193).read_to_string(&mut value).map_err(db)?;
    if value.len() > 8192 {
        return Err(RuntimeStoreError::InvalidInput);
    }
    Ok(value)
}
fn association(workspace: &Path) -> Result<(PathBuf, PathBuf)> {
    let dot = workspace.join(".git");
    let meta = std::fs::symlink_metadata(&dot).map_err(db)?;
    if meta.file_type().is_symlink() {
        return Err(RuntimeStoreError::Fenced);
    }
    let git = if meta.is_dir() {
        dot
    } else {
        let text = small(&dot)?;
        let target = text
            .trim_end_matches(['\r', '\n'])
            .strip_prefix("gitdir: ")
            .ok_or(RuntimeStoreError::Fenced)?;
        normal(&workspace.join(target))?
    };
    let common_file = git.join("commondir");
    let common = match std::fs::symlink_metadata(&common_file) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(RuntimeStoreError::Fenced);
            }
            normal(&git.join(small(&common_file)?.trim_end_matches(['\r', '\n'])))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => git.clone(),
        Err(_) => return Err(RuntimeStoreError::Unavailable),
    };
    Ok((normal(&git)?, common))
}
