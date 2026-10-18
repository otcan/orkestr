//! Small Linux/64-bit syscall boundary. Unsupported hosts fail closed.
use super::{Error, Exit, Signal};

#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
mod linux {
    use super::*;
    use std::os::fd::AsRawFd;

    // Linux siginfo_t SIGCHLD layout: header, alignment, pid/uid/status union.
    #[repr(C, align(8))]
    struct ChildInfo {
        signo: i32,
        errno: i32,
        code: i32,
        align: i32,
        pid: i32,
        uid: u32,
        status: i32,
        rest: [u8; 100],
    }

    unsafe extern "C" {
        fn close_range(first: u32, last: u32, flags: i32) -> i32;
        fn dup2(old: i32, new: i32) -> i32;
        fn fcntl(fd: i32, command: i32, ...) -> i32;
        fn kill(pid: i32, signal: i32) -> i32;
        fn waitid(kind: u32, id: u32, info: *mut ChildInfo, options: i32) -> i32;
    }

    pub fn configure_command(command: &mut std::process::Command) {
        use std::os::unix::process::CommandExt;
        // SAFETY: after fork this hook only invokes close_range and errno access;
        // no allocation/locking. CLOEXEC preserves Command's exec-error channel
        // until exec, while closing all inherited non-stdio descriptors on exec.
        unsafe {
            command.pre_exec(|| {
                if close_range(3, u32::MAX, 4) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    pub fn inherit_handoff(command: &mut std::process::Command, fd: i32) {
        use std::os::unix::process::CommandExt;
        // Registered after configure_command: only this owned socket survives exec.
        unsafe {
            command.pre_exec(move || {
                if dup2(fd, 3) < 0 || fcntl(3, 2, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    pub fn nonblocking(pipe: &impl AsRawFd) -> Result<(), Error> {
        // SAFETY: a borrowed live pipe fd; F_GETFL/F_SETFL use integer flags.
        let flags = unsafe { fcntl(pipe.as_raw_fd(), 3) };
        if flags < 0 || unsafe { fcntl(pipe.as_raw_fd(), 4, flags | 0x800) } < 0 {
            return Err(Error::Io);
        }
        Ok(())
    }

    pub fn signal_group(id: u32, signal: Signal) -> Result<(), Error> {
        let id = i32::try_from(id).map_err(|_| Error::Io)?;
        if id <= 1 {
            return Err(Error::Io);
        }
        let signal = match signal {
            Signal::Terminate => 15,
            Signal::Kill => 9,
        };
        // SAFETY: id comes only from our unreaped Child, whose process group was
        // created at spawn. Never called after transferring Child to the reaper.
        if unsafe { kill(-id, signal) } == 0 {
            return Ok(());
        }
        if std::io::Error::last_os_error().raw_os_error() == Some(3) {
            return Ok(()); // Group already empty, leader still owned/unreaped.
        }
        Err(Error::Io)
    }

    pub fn observe_exit(id: u32) -> Result<Option<Exit>, Error> {
        let mut info = ChildInfo {
            signo: 0,
            errno: 0,
            code: 0,
            align: 0,
            pid: 0,
            uid: 0,
            status: 0,
            rest: [0; 100],
        };
        // SAFETY: initialized 128-byte aligned Linux siginfo_t, owned child PID.
        // P_PID=1, WEXITED=4, WNOHANG=1, WNOWAIT=0x01000000. WNOWAIT keeps
        // the leader PID reserved for later group signaling, including on EOF.
        if unsafe { waitid(1, id, &mut info, 4 | 1 | 0x01000000) } != 0 {
            return Err(Error::Io);
        }
        if info.pid == 0 {
            return Ok(None);
        }
        Ok(Some(Exit {
            code: if info.code == 1 {
                Some(info.status)
            } else {
                None
            },
            signal: if info.code == 2 || info.code == 3 {
                Some(info.status)
            } else {
                None
            },
        }))
    }
}

#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
pub(super) use linux::{
    configure_command, inherit_handoff, nonblocking, observe_exit, signal_group,
};

pub(super) fn supported() -> Result<(), Error> {
    if cfg!(all(target_os = "linux", target_pointer_width = "64")) {
        Ok(())
    } else {
        Err(Error::Unsupported)
    }
}

#[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
pub(super) fn nonblocking<T>(_: &T) -> Result<(), Error> {
    Err(Error::Unsupported)
}
#[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
pub(super) fn observe_exit(_: u32) -> Result<Option<Exit>, Error> {
    Err(Error::Unsupported)
}
#[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
pub(super) fn signal_group(_: u32, _: Signal) -> Result<(), Error> {
    Err(Error::Unsupported)
}

#[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
pub(super) fn configure_command(_: &mut std::process::Command) {}
