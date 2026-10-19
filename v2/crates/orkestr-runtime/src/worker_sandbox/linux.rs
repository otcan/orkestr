//! Linux x86-64 primitives. Each unsafe call has a fixed, owned descriptor/PID.
use super::{Error, Result};
use std::{
    fs::File,
    io::{Seek, SeekFrom, Write},
    os::fd::{AsRawFd, FromRawFd},
    time::Duration,
};

#[repr(C)]
struct Rlimit {
    current: u64,
    maximum: u64,
}
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
    fn fcntl(fd: i32, command: i32, ...) -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
    fn waitid(kind: u32, id: u32, info: *mut ChildInfo, options: i32) -> i32;
    fn prctl(option: i32, ...) -> i32;
    fn setrlimit(resource: i32, limit: *const Rlimit) -> i32;
    fn memfd_create(name: *const std::ffi::c_char, flags: u32) -> i32;
}

pub(super) fn configure(command: &mut std::process::Command, policy_fd: i32, timeout: Duration) {
    use std::os::unix::process::CommandExt;
    let cpu = timeout.as_secs() + 2;
    // SAFETY: after fork, only fixed syscalls/errno access; no allocation or locks.
    // Mark all inherited descriptors CLOEXEC, except our sealed seccomp policy.
    // The standard Command exec-error channel remains usable until exec succeeds.
    unsafe {
        command.pre_exec(move || {
            if close_range(3, u32::MAX, 4) != 0
                || fcntl(policy_fd, 2, 0) != 0
                || prctl(38, 1_u64, 0_u64, 0_u64, 0_u64) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            // CPU seconds, file bytes, core bytes, fd count, virtual address bytes.
            // No RLIMIT_NPROC: its same-UID accounting could affect unrelated work;
            // process/thread creation is instead denied by the child's seccomp policy.
            for (resource, value) in [
                (0, cpu),
                (1, 8 * 1024 * 1024),
                (4, 0),
                (7, 128),
                (9, 256 * 1024 * 1024),
            ] {
                let limit = Rlimit {
                    current: value,
                    maximum: value,
                };
                if setrlimit(resource, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
}

pub(super) fn filter() -> Result<File> {
    // Classic BPF sock_filter fields: code, jt, jf, k. Kill wrong ABI/x32.
    let mut instructions: Vec<(u16, u8, u8, u32)> = vec![
        (0x20, 0, 0, 4),
        (0x15, 1, 0, 0xc000003e),
        (0x06, 0, 0, 0x80000000),
        (0x20, 0, 0, 0),
        (0x35, 0, 1, 0x40000000),
        (0x06, 0, 0, 0x80000000),
    ];
    // clone/fork/vfork/clone3; sockets; namespace/mount; ptrace/process-memory;
    // io_uring (can bypass syscall-specific restrictions), keyring/kernel APIs.
    // Anonymous shared-memory files/SysV IPC cannot bypass our bounded tmpfs.
    for syscall in [
        56, 57, 58, 435, 41, 53, 272, 308, 165, 166, 155, 161, 101, 310, 311, 438, 425, 426, 427,
        248, 249, 250, 298, 321, 323, 169, 175, 176, 246, 313, 320, 303, 304, 319, 29, 30, 31, 64,
        65, 66, 67, 68, 69, 70, 71, 220, 428, 429, 430, 431, 432, 433, 442,
    ] {
        instructions.push((0x15, 0, 1, syscall));
        instructions.push((0x06, 0, 0, 0x00050001)); // SECCOMP_RET_ERRNO | EPERM
    }
    // ALLOW remaining syscalls.
    instructions.push((0x06, 0, 0, 0x7fff0000));
    // SAFETY: static nul-terminated name; successful fd becomes uniquely owned.
    let fd = unsafe { memfd_create(c"orkestr-worker-policy".as_ptr(), 3) };
    if fd < 0 {
        return Err(Error::Io);
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    for (code, jt, jf, k) in instructions {
        file.write_all(&code.to_le_bytes()).map_err(|_| Error::Io)?;
        file.write_all(&[jt, jf]).map_err(|_| Error::Io)?;
        file.write_all(&k.to_le_bytes()).map_err(|_| Error::Io)?;
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| Error::Io)?;
    // SAFETY: owned memfd; seal against write/grow/shrink and further seal changes.
    if unsafe { fcntl(file.as_raw_fd(), 1033, 15) } < 0 {
        return Err(Error::Io);
    }
    Ok(file)
}

pub(super) fn nonblocking(pipe: &impl AsRawFd) -> Result<()> {
    // SAFETY: borrowed owned pipe; F_GETFL/F_SETFL only change descriptor flags.
    let flags = unsafe { fcntl(pipe.as_raw_fd(), 3) };
    if flags < 0 || unsafe { fcntl(pipe.as_raw_fd(), 4, flags | 0x800) } < 0 {
        return Err(Error::Io);
    }
    Ok(())
}
pub(super) fn kill_group(id: u32) {
    if let Ok(id) = i32::try_from(id) {
        if id > 1 {
            // SAFETY: only an owned, unreaped leader whose PGID was set at spawn.
            unsafe {
                kill(-id, 9);
            }
        }
    }
}
pub(super) fn exited(id: u32) -> Result<bool> {
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
    // SAFETY: Linux 128-byte aligned siginfo_t and owned child PID; WNOWAIT
    // preserves PID identity until Owned::finish/drop has performed group cleanup.
    if unsafe { waitid(1, id, &mut info, 4 | 1 | 0x01000000) } != 0 {
        return Err(Error::Io);
    }
    Ok(info.pid != 0)
}

#[cfg(test)]
pub(super) fn policy_is_sealed(file: &mut File) -> bool {
    use std::io::Read;
    let mut byte = [0];
    file.read_exact(&mut byte).unwrap();
    file.write_all(&[0]).is_err()
}
