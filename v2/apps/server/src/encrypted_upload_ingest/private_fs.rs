//! Descriptor-relative private state. No symlink ancestors or writable shared
//! directories (except root-owned sticky ancestors such as /tmp in tests).
use rustix::fs::{self, AtFlags, Mode, OFlags};
use std::{
    fs::File,
    path::{Component, Path},
};
pub(super) fn directory(path: &Path, create: bool) -> Result<File, &'static str> {
    if !path.is_absolute() {
        return Err("private state path must be absolute");
    }
    let mut dir = File::open("/").map_err(|_| "private state unavailable")?;
    for part in path.components() {
        let name = match part {
            Component::RootDir => continue,
            Component::Normal(name) => name,
            _ => return Err("private state aliases forbidden"),
        };
        if create {
            match fs::mkdirat(&dir, name, Mode::from_raw_mode(0o700)) {
                Ok(()) => {}
                Err(rustix::io::Errno::EXIST) => {}
                Err(_) => return Err("private directory creation failed"),
            }
        }
        let next: File = fs::openat(
            &dir,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| "private directory unavailable")?
        .into();
        let meta = fs::fstat(&next).map_err(|_| "private directory unavailable")?;
        let sticky_root = meta.st_uid == 0 && meta.st_mode & 0o1000 != 0;
        if ![0, rustix::process::geteuid().as_raw()].contains(&meta.st_uid)
            || (meta.st_mode & 0o022 != 0 && !sticky_root)
        {
            return Err("private directory custody rejected");
        }
        dir = next;
    }
    Ok(dir)
}
pub(super) fn create(dir: &File, name: &str, mode: u32) -> Result<File, &'static str> {
    fs::openat(
        dir,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(mode),
    )
    .map(Into::into)
    .map_err(|_| "private file creation failed")
}
pub(super) struct Temporary {
    pub dir: File,
    pub name: String,
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::unlinkat(&self.dir, &self.name, AtFlags::empty());
    }
}
pub(super) fn same_directory(a: &File, b: &File) -> bool {
    match (fs::fstat(a), fs::fstat(b)) {
        (Ok(a), Ok(b)) => a.st_dev == b.st_dev && a.st_ino == b.st_ino,
        _ => false,
    }
}
