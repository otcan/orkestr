//! Recover only private, abandoned upload temporaries in the configured export
//! namespace. Never reads bytes, follows aliases, or waits for a live writer.
use super::{private_fs, ExportDir};
use rustix::fs::{self, AtFlags, FlockOperation, Mode, OFlags};
use std::fs::File;
use uuid::Uuid;

#[derive(Default, Debug)]
pub struct Recovery {
    pub removed: u64,
    pub busy: u64,
    pub skipped: u64,
}
fn uuid(name: &str) -> bool {
    Uuid::parse_str(name).is_ok_and(|v| !v.is_nil() && v.to_string() == name)
}
fn temporary(name: &str) -> bool {
    let Some(body) = name.strip_prefix('.').and_then(|v| v.strip_suffix(".tmp")) else {
        return false;
    };
    body.split_once('.')
        .is_some_and(|(upload, nonce)| uuid(upload) && uuid(nonce))
}
fn private(meta: &fs::Stat) -> bool {
    fs::FileType::from_raw_mode(meta.st_mode) == fs::FileType::RegularFile
        && meta.st_uid == rustix::process::geteuid().as_raw()
        && meta.st_nlink == 1
        && meta.st_mode & 0o777 == 0o600
}
fn same(a: &fs::Stat, b: &fs::Stat) -> bool {
    a.st_dev == b.st_dev && a.st_ino == b.st_ino
}

pub fn recover(export: &ExportDir) -> Result<Recovery, &'static str> {
    match std::fs::symlink_metadata(&export.dir) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Recovery::default()),
        Err(_) => return Err("export recovery metadata unavailable"),
    }
    let root = private_fs::directory(&export.dir, false)?;
    let mut directories =
        fs::Dir::read_from(&root).map_err(|_| "export recovery directory unavailable")?;
    let mut result = Recovery::default();
    for entry in &mut directories {
        let entry = entry.map_err(|_| "export recovery entry unavailable")?;
        let Some(name) = entry.file_name().to_str().ok().filter(|v| uuid(v)) else {
            continue;
        };
        let folder: File = match fs::openat(
            &root,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => fd.into(),
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        let meta = fs::fstat(&folder).map_err(|_| "export recovery scope unavailable")?;
        if meta.st_uid != rustix::process::geteuid().as_raw() || meta.st_mode & 0o022 != 0 {
            result.skipped += 1;
            continue;
        }
        let mut files =
            fs::Dir::read_from(&folder).map_err(|_| "export recovery files unavailable")?;
        for item in &mut files {
            let item = item.map_err(|_| "export recovery entry unavailable")?;
            let Some(file_name) = item.file_name().to_str().ok().filter(|v| temporary(v)) else {
                continue;
            };
            let named_before = match fs::statat(&folder, file_name, AtFlags::SYMLINK_NOFOLLOW) {
                Ok(m) if private(&m) => m,
                _ => {
                    result.skipped += 1;
                    continue;
                }
            };
            let file: File = match fs::openat(
                &folder,
                file_name,
                OFlags::RDWR | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            ) {
                Ok(fd) => fd.into(),
                Err(_) => {
                    result.skipped += 1;
                    continue;
                }
            };
            let before = fs::fstat(&file).map_err(|_| "export recovery file unavailable")?;
            if !private(&before) || !same(&before, &named_before) {
                result.skipped += 1;
                continue;
            }
            if fs::flock(&file, FlockOperation::NonBlockingLockExclusive).is_err() {
                result.busy += 1;
                continue;
            }
            let current = fs::fstat(&file).map_err(|_| "export recovery file changed")?;
            let named = fs::statat(&folder, file_name, AtFlags::SYMLINK_NOFOLLOW);
            let parent = fs::statat(&root, name, AtFlags::SYMLINK_NOFOLLOW);
            if !private(&current)
                || !same(&before, &current)
                || !named.is_ok_and(|n| private(&n) && same(&n, &current))
                || !parent.is_ok_and(|p| same(&p, &meta))
            {
                result.skipped += 1;
                continue;
            }
            fs::unlinkat(&folder, file_name, AtFlags::empty())
                .map_err(|_| "export recovery removal failed")?;
            result.removed += 1;
        }
        folder
            .sync_all()
            .map_err(|_| "export recovery sync failed")?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
