//! Read-only descriptor traversal beneath one selected profile. Never follow a
//! symlink or read a renamed/hardlinked credential file under a mailbox name.
use std::fs::File;
use std::io;
use std::path::Path;

#[derive(Debug)]
struct UnsafePath;
impl std::fmt::Display for UnsafePath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("unsafe mail source path")
    }
}
impl std::error::Error for UnsafePath {}
fn refused() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, UnsafePath)
}
pub(crate) fn is_refused(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|e| e.is::<UnsafePath>())
}

#[cfg(unix)]
mod platform {
    use super::*;
    use rustix::fs::{fstat, openat, statat, AtFlags, Dir, FileType, Mode, OFlags};
    use std::ffi::OsString;
    use std::os::unix::{ffi::OsStringExt, fs::MetadataExt};
    use std::path::{Component, PathBuf};

    pub(crate) struct Scope {
        path: PathBuf,
        directory: File,
    }
    pub(crate) struct Entries(Dir);
    impl Iterator for Entries {
        type Item = io::Result<OsString>;
        fn next(&mut self) -> Option<Self::Item> {
            loop {
                let entry = match self.0.read()? {
                    Ok(e) => e,
                    Err(e) => return Some(Err(e.into())),
                };
                let bytes = entry.file_name().to_bytes();
                if ![b".".as_slice(), b"..".as_slice()].contains(&bytes) {
                    return Some(Ok(OsString::from_vec(bytes.to_vec())));
                }
            }
        }
    }

    fn child(parent: &File, name: &std::ffi::OsStr, directory: bool) -> io::Result<File> {
        let base = name.to_string_lossy();
        if crate::profile::is_secret_file(base.split([':', '!']).next().unwrap_or(&base)) {
            return Err(refused());
        }
        let before = statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)?;
        let kind = FileType::from_raw_mode(before.st_mode);
        if !matches!(
            (directory, kind),
            (true, FileType::Directory) | (false, FileType::RegularFile)
        ) || (!directory && before.st_nlink != 1)
        {
            return Err(refused());
        }
        let mut flags = OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK;
        if directory {
            flags |= OFlags::DIRECTORY;
        }
        let file = File::from(openat(parent, name, flags, Mode::empty()).map_err(|error| {
            if error == rustix::io::Errno::LOOP {
                refused()
            } else {
                io::Error::from(error)
            }
        })?);
        let after = file.metadata()?;
        let identity = fstat(&file)?;
        if identity.st_dev != before.st_dev
            || identity.st_ino != before.st_ino
            || (directory && !after.is_dir())
            || (!directory && (!after.is_file() || after.nlink() != 1))
        {
            return Err(refused());
        }
        Ok(file)
    }

    impl Scope {
        pub(crate) fn identity(&self) -> io::Result<(u64, u64)> {
            let meta = self.directory.metadata()?;
            Ok((meta.dev(), meta.ino()))
        }
        pub(crate) fn new(path: &Path) -> io::Result<Self> {
            if !path.is_absolute() {
                return Err(refused());
            }
            let mut directory = File::open("/")?;
            let mut normalized = PathBuf::from("/");
            for part in path.components() {
                match part {
                    Component::RootDir => {}
                    Component::Normal(name) => {
                        directory = child(&directory, name, true)?;
                        normalized.push(name);
                    }
                    _ => return Err(refused()),
                }
            }
            Ok(Self {
                path: normalized,
                directory,
            })
        }
        fn open(&self, path: &Path, directory: bool) -> io::Result<File> {
            let relative = path.strip_prefix(&self.path).map_err(|_| refused())?;
            let mut parts = relative.components().peekable();
            let mut file = self.directory.try_clone()?;
            while let Some(part) = parts.next() {
                let Component::Normal(name) = part else {
                    return Err(refused());
                };
                file = child(&file, name, parts.peek().is_some() || directory)?;
            }
            if !directory && file.metadata()?.is_dir() {
                return Err(refused());
            }
            Ok(file)
        }
        pub(crate) fn file(&self, path: &Path) -> io::Result<File> {
            self.open(path, false)
        }
        pub(crate) fn directory(&self, path: &Path) -> io::Result<File> {
            self.open(path, true)
        }
        pub(crate) fn entries(&self, path: &Path) -> io::Result<Entries> {
            Ok(Entries(Dir::read_from(self.directory(path)?)?))
        }
    }
}
#[cfg(unix)]
pub(crate) use platform::Scope;

// A path-only fallback would reintroduce a reparse-point race. Discovery of OS
// roots is portable; actual reads require a qualified descriptor implementation.
#[cfg(not(unix))]
pub(crate) struct Scope;
#[cfg(not(unix))]
impl Scope {
    pub(crate) fn identity(&self) -> io::Result<(u64, u64)> {
        Err(refused())
    }
    pub(crate) fn new(_: &Path) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "scoped mailbox reads are not available on this platform",
        ))
    }
    pub(crate) fn file(&self, _: &Path) -> io::Result<File> {
        Err(refused())
    }
    pub(crate) fn directory(&self, _: &Path) -> io::Result<File> {
        Err(refused())
    }
    pub(crate) fn entries(
        &self,
        _: &Path,
    ) -> io::Result<std::vec::IntoIter<io::Result<std::ffi::OsString>>> {
        Err(refused())
    }
}
