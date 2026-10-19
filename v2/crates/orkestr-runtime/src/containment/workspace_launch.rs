//! Private Linux descriptor consumer. Core issuance and profile forwarding are
//! separate prerequisites; this primitive alone grants no workspace authority.
use std::io;
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::process::Command;

/// Values must come from Core's current transaction-local descriptor validator.
#[derive(Clone, Copy)]
pub(crate) struct Identity {
    pub device: u64,
    pub inode: u64,
    pub owner: u32,
}

pub(crate) struct WorkspaceDescriptor(OwnedFd);

impl WorkspaceDescriptor {
    /// Duplicate during the sealed synchronous callback, never from a path or a
    /// serialized descriptor number. Destination slots 3/4/5 remain untouched.
    pub(crate) fn capture(source: BorrowedFd<'_>, expected: Identity) -> io::Result<Self> {
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        {
            unsafe extern "C" {
                fn fcntl(fd: i32, command: i32, ...) -> i32;
            }
            // SAFETY: source is borrowed live; F_DUPFD_CLOEXEC returns a new owner.
            let copied = unsafe { fcntl(source.as_raw_fd(), 1030, 6) };
            if copied < 0 {
                return Err(io::Error::last_os_error());
            }
            let owned = unsafe { OwnedFd::from_raw_fd(copied) };
            let file = std::fs::File::from(owned);
            let metadata = file.metadata()?;
            if !metadata.is_dir()
                || metadata.dev() != expected.device
                || metadata.ino() != expected.inode
                || metadata.uid() != expected.owner
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "workspace identity",
                ));
            }
            Ok(Self(file.into()))
        }
        #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
        {
            let _ = (source, expected);
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "workspace descriptor host",
            ))
        }
    }

    /// Consumes the duplicate into Command. Caller must not configure string cwd.
    /// Register after the existing close_range(CLOEXEC) hook. FD5 survives only to
    /// the closed broker/profile, which must mount from it and close before native.
    pub(crate) fn configure(self, command: &mut Command) -> io::Result<()> {
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        {
            use std::os::unix::process::CommandExt;
            unsafe extern "C" {
                fn dup2(old: i32, new: i32) -> i32;
                fn fcntl(fd: i32, command: i32, ...) -> i32;
                fn fchdir(fd: i32) -> i32;
            }
            // SAFETY: only async-signal-safe syscalls and errno access after fork.
            // Owned source remains CLOEXEC and is retained by Command until drop.
            unsafe {
                command.pre_exec(move || {
                    let source = self.0.as_raw_fd();
                    if fchdir(source) != 0 || dup2(source, 5) < 0 || fcntl(5, 2, 0) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            Ok(())
        }
        #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
        {
            let _ = (self, command);
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "workspace descriptor host",
            ))
        }
    }
}
