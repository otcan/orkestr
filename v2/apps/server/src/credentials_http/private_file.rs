//! Reading an operator-provided file with its custody checked first: a
//! regular file (no symlink), one link, owned by root or this process's user,
//! bounded in size. `secret` files must also be closed to group and others;
//! other files only closed to writes by them.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Refused {
    Unreadable,
    Custody,
    TooLarge,
}

#[cfg(unix)]
pub(crate) fn read(
    path: &std::path::Path,
    max: usize,
    secret: bool,
) -> Result<Option<String>, Refused> {
    use rustix::fs::{fstat, open, FileType, Mode, OFlags};
    use std::io::Read;
    let file = match open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => std::fs::File::from(fd),
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(_) => return Err(Refused::Unreadable),
    };
    let meta = fstat(&file).map_err(|_| Refused::Unreadable)?;
    let closed = if secret { 0o077 } else { 0o022 };
    if FileType::from_raw_mode(meta.st_mode) != FileType::RegularFile
        || meta.st_mode & closed != 0
        || meta.st_nlink != 1
        || ![0, rustix::process::geteuid().as_raw()].contains(&meta.st_uid)
    {
        return Err(Refused::Custody);
    }
    if meta.st_size < 0 || meta.st_size as u64 > max as u64 {
        return Err(Refused::TooLarge);
    }
    let mut text = String::new();
    file.take(max as u64 + 1)
        .read_to_string(&mut text)
        .map_err(|_| Refused::Unreadable)?;
    if text.len() > max {
        return Err(Refused::TooLarge);
    }
    Ok(Some(text))
}

#[cfg(not(unix))]
pub(crate) fn read(_: &std::path::Path, _: usize, _: bool) -> Result<Option<String>, Refused> {
    Ok(None)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn custody_is_checked_before_reading() {
        let dir = std::env::temp_dir().join(format!("private-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("config.json");
        assert_eq!(read(&file, 100, true), Ok(None));
        std::fs::write(&file, "{}").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read(&file, 100, true), Err(Refused::Custody));
        assert_eq!(read(&file, 100, false), Ok(Some("{}".into())));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read(&file, 100, true), Ok(Some("{}".into())));
        assert_eq!(read(&file, 1, true), Err(Refused::TooLarge));
        let link = dir.join("link.json");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert_eq!(read(&link, 100, true), Err(Refused::Unreadable));
        let hard = dir.join("hard.json");
        std::fs::hard_link(&file, &hard).unwrap();
        assert_eq!(read(&file, 100, true), Err(Refused::Custody));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
