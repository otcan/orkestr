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
#[repr(C)]
struct FsInfo {
    kind: i64,
    block: i64,
    blocks: u64,
    free: u64,
    available: u64,
    files: u64,
    free_files: u64,
    fsid: [i32; 2],
    names: i64,
    fragment: i64,
    flags: i64,
    spare: [i64; 4],
}
pub(super) fn euid() -> u32 {
    unsafe { geteuid() }
}
pub(super) fn cgroup2(file: &File) -> Result<()> {
    let mut info = FsInfo {
        kind: 0,
        block: 0,
        blocks: 0,
        free: 0,
        available: 0,
        files: 0,
        free_files: 0,
        fsid: [0; 2],
        names: 0,
        fragment: 0,
        flags: 0,
        spare: [0; 4],
    };
    // SAFETY: exact Linux x86-64 statfs layout, borrowed owned descriptor.
    if unsafe { fstatfs(file.as_raw_fd(), &mut info) } != 0 || info.kind != 0x63677270 {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}
unsafe extern "C" {
    fn close_range(first: u32, last: u32, flags: i32) -> i32;
    fn fcntl(fd: i32, command: i32, ...) -> i32;
    fn waitid(kind: u32, id: u32, info: *mut ChildInfo, options: i32) -> i32;
    fn prctl(option: i32, ...) -> i32;
    fn setrlimit(resource: i32, limit: *const Rlimit) -> i32;
    fn fstatfs(fd: i32, buf: *mut FsInfo) -> i32;
    fn geteuid() -> u32;
    fn memfd_create(name: *const std::ffi::c_char, flags: u32) -> i32;
}

/// Per-process rlimits for the supervisor and everything it starts.
#[derive(Clone, Copy)]
pub(super) struct Rlimits {
    pub cpu_seconds: u64,
    pub file_bytes: u64,
    pub open_files: u64,
}
impl Rlimits {
    pub(super) fn restricted(timeout: Duration) -> Self {
        Self {
            cpu_seconds: timeout.as_secs() + 2,
            file_bytes: 256 * 1024 * 1024,
            open_files: 256,
        }
    }
    /// CPU seconds scale with the job's cgroup CPU allowance and timeout.
    pub(super) fn trusted(timeout: Duration, resources: &super::profile::Resources) -> Self {
        Self {
            cpu_seconds: timeout.as_secs().saturating_mul(resources.cpus.into()) + 2,
            file_bytes: resources.file_bytes,
            open_files: resources.open_files.into(),
        }
    }
}

/// `inherited` entries below zero are unused slots.
pub(super) fn configure(command: &mut std::process::Command, inherited: [i32; 6], limits: Rlimits) {
    use std::os::unix::process::CommandExt;
    // SAFETY: after fork, only fixed syscalls/errno access; no allocation or locks.
    // Mark all inherited descriptors CLOEXEC, except our sealed seccomp policy.
    // The standard Command exec-error channel remains usable until exec succeeds.
    unsafe {
        command.pre_exec(move || {
            if close_range(3, u32::MAX, 4) != 0 || prctl(38, 1_u64, 0_u64, 0_u64, 0_u64) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            for fd in inherited {
                if fd >= 0 && fcntl(fd, 2, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            // CPU seconds, file bytes, core bytes, fd count. Memory and task
            // counts are enforced for the entire subtree, not this shared UID.
            // No RLIMIT_NPROC: its same-UID accounting could affect unrelated work;
            // process/thread counts are bounded by this exact job cgroup.
            for (resource, value) in [
                (0, limits.cpu_seconds),
                (1, limits.file_bytes),
                (4, 0),
                (7, limits.open_files),
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

/// `network` permits only socket creation (socket/socketpair) and is used
/// solely with a profile that shares the host network namespace on purpose.
pub(super) fn filter(network: bool) -> Result<File> {
    // Classic BPF sock_filter fields: code, jt, jf, k. Kill wrong ABI/x32.
    let mut instructions: Vec<(u16, u8, u8, u32)> = vec![
        (0x20, 0, 0, 4),
        (0x15, 1, 0, 0xc000003e),
        (0x06, 0, 0, 0x80000000),
        (0x20, 0, 0, 0),
        (0x35, 0, 1, 0x40000000),
        (0x06, 0, 0, 0x80000000),
    ];
    // clone is allowed only within the existing namespaces; clone3 returns
    // ENOSYS so libc can use the inspectable clone ABI. Fork/vfork/exec and
    // setsid are deliberately allowed and bounded by the job cgroup.
    instructions.extend([
        (0x15, 0, 4, 56),         // clone
        (0x20, 0, 0, 16),         // flags low word
        (0x45, 0, 1, 0x7e82a080), // namespaces, ptrace, untraced
        (0x06, 0, 0, 0x00050001),
        (0x20, 0, 0, 0),          // reload syscall number
        (0x15, 0, 1, 435),        // clone3
        (0x06, 0, 0, 0x00050026), // ENOSYS
    ]);
    // Sockets; namespace/mount; ptrace/process-memory;
    // io_uring (can bypass syscall-specific restrictions), keyring/kernel APIs.
    // Anonymous shared-memory files/SysV IPC cannot bypass our bounded tmpfs.
    for syscall in [
        41, 53, 272, 308, 165, 166, 155, 161, 101, 310, 311, 438, 425, 426, 427, 248, 249, 250,
        298, 321, 323, 169, 175, 176, 246, 313, 320, 303, 304, 319, 29, 30, 31, 64, 65, 66, 67, 68,
        69, 70, 71, 220, 428, 429, 430, 431, 432, 433, 442,
    ] {
        if network && matches!(syscall, 41 | 53) {
            continue;
        }
        instructions.push((0x15, 0, 1, syscall));
        instructions.push((0x06, 0, 0, 0x00050001)); // SECCOMP_RET_ERRNO | EPERM
    }
    // ALLOW remaining syscalls.
    instructions.push((0x06, 0, 0, 0x7fff0000));
    let mut bytes = Vec::with_capacity(instructions.len() * 8);
    for (code, jt, jf, k) in instructions {
        bytes.extend_from_slice(&code.to_le_bytes());
        bytes.extend_from_slice(&[jt, jf]);
        bytes.extend_from_slice(&k.to_le_bytes());
    }
    sealed(c"orkestr-workspace-policy", &bytes)
}

/// Sealed, close-on-exec memfd holding exactly `bytes`, positioned at zero.
pub(super) fn sealed(name: &std::ffi::CStr, bytes: &[u8]) -> Result<File> {
    // SAFETY: nul-terminated name; successful fd becomes uniquely owned.
    let fd = unsafe { memfd_create(name.as_ptr(), 3) };
    if fd < 0 {
        return Err(Error::Io);
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    file.write_all(bytes).map_err(|_| Error::Io)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    // Execute the actual generated classic-BPF instructions against synthetic
    // seccomp_data. This checks branch offsets as well as policy intent.
    fn decision(syscall: u32, flags: u32, arch: u32) -> u32 {
        decision_with(false, syscall, flags, arch)
    }
    fn decision_with(network: bool, syscall: u32, flags: u32, arch: u32) -> u32 {
        let mut file = filter(network).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        let instructions: Vec<_> = bytes
            .as_chunks::<8>()
            .0
            .iter()
            .map(|b| {
                (
                    u16::from_le_bytes([b[0], b[1]]),
                    b[2],
                    b[3],
                    u32::from_le_bytes(b[4..8].try_into().unwrap()),
                )
            })
            .collect();
        let (mut at, mut accumulator) = (0, 0);
        for _ in 0..instructions.len() {
            let (code, yes, no, value) = instructions[at];
            match code {
                0x20 => {
                    accumulator = match value {
                        0 => syscall,
                        4 => arch,
                        16 => flags,
                        _ => panic!("unknown data load"),
                    }
                }
                0x15 => at += if accumulator == value { yes } else { no } as usize,
                0x35 => at += if accumulator >= value { yes } else { no } as usize,
                0x45 => at += if accumulator & value != 0 { yes } else { no } as usize,
                0x06 => return value,
                _ => panic!("unknown policy instruction"),
            }
            at += 1;
        }
        panic!("policy did not terminate");
    }
    #[test]
    fn shell_forks_are_bounded_separately_but_namespace_network_escape_refuses() {
        for syscall in [0, 1, 3, 57, 58, 59, 61, 112, 257, 322] {
            assert_eq!(decision(syscall, 0, 0xc000003e), 0x7fff0000);
        }
        assert_eq!(decision(56, 17, 0xc000003e), 0x7fff0000);
        assert_eq!(
            decision(56, 0x00010000 | 0x100 | 0x800, 0xc000003e),
            0x7fff0000
        );
        for flags in [0x20000, 0x10000000, 0x40000000, 0x80] {
            assert_eq!(decision(56, flags | 17, 0xc000003e), 0x50001);
        }
        assert_eq!(decision(435, 0, 0xc000003e), 0x50026);
        for syscall in [41, 53, 101, 165, 272, 308, 310, 311, 425, 321] {
            assert_eq!(decision(syscall, 0, 0xc000003e), 0x50001);
        }
        assert_eq!(decision(0, 0, 0x40000003), 0x80000000);
        assert_eq!(decision(0x40000000, 0, 0xc000003e), 0x80000000);
        assert!(policy_is_sealed(&mut filter(false).unwrap()));
    }

    #[test]
    fn network_profile_allows_only_socket_creation_in_addition() {
        for syscall in [41, 53] {
            assert_eq!(decision_with(true, syscall, 0, 0xc000003e), 0x7fff0000);
        }
        for syscall in [101, 165, 272, 308, 310, 425, 321] {
            assert_eq!(decision_with(true, syscall, 0, 0xc000003e), 0x50001);
        }
        for flags in [0x20000, 0x10000000, 0x40000000, 0x80] {
            assert_eq!(decision_with(true, 56, flags | 17, 0xc000003e), 0x50001);
        }
        assert_eq!(decision_with(true, 0, 0, 0x40000003), 0x80000000);
    }
}
