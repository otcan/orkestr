//! One-shot Linux ancillary transfer to the already authenticated root manager.
use super::{ManagerError, Result};
use std::os::fd::{AsRawFd, OwnedFd};
use tokio::net::UnixStream;

#[repr(C)]
struct IoVec {
    base: *const u8,
    len: usize,
}
#[repr(C)]
struct Message {
    name: *const u8,
    name_len: u32,
    vectors: *const IoVec,
    vector_count: usize,
    control: *const u8,
    control_len: usize,
    flags: i32,
}
#[repr(C, align(8))]
struct Control([u8; 32]);
unsafe extern "C" {
    fn sendmsg(fd: i32, message: *const Message, flags: i32) -> isize;
}

pub(super) async fn write(stream: &UnixStream, bytes: &[u8], fds: &[OwnedFd]) -> Result<()> {
    if fds.len() != 4 || bytes.is_empty() {
        return Err(ManagerError::InvalidRequest);
    }
    loop {
        stream
            .writable()
            .await
            .map_err(|_| ManagerError::Unavailable)?;
        let count = match send_once(stream, bytes, fds) {
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(_) => return Err(ManagerError::Unavailable),
        };
        if count == 0 || count > bytes.len() {
            return Err(ManagerError::Protocol);
        }
        return super::wire::write(stream, &bytes[count..]).await;
    }
}

fn send_once(stream: &UnixStream, bytes: &[u8], fds: &[OwnedFd]) -> std::io::Result<usize> {
    let mut control = Control([0; 32]);
    control.0[..8].copy_from_slice(&32usize.to_ne_bytes());
    control.0[8..12].copy_from_slice(&1i32.to_ne_bytes());
    control.0[12..16].copy_from_slice(&1i32.to_ne_bytes());
    for (index, fd) in fds.iter().enumerate() {
        control.0[16 + index * 4..20 + index * 4].copy_from_slice(&fd.as_raw_fd().to_ne_bytes());
    }
    let vector = IoVec {
        base: bytes.as_ptr(),
        len: bytes.len(),
    };
    let message = Message {
        name: std::ptr::null(),
        name_len: 0,
        vectors: &vector,
        vector_count: 1,
        control: control.0.as_ptr(),
        control_len: 32,
        flags: 0,
    };
    // SAFETY: all stack buffers and owned descriptors remain live across this
    // synchronous syscall. MSG_NOSIGNAL avoids SIGPIPE. No raw pointer survives
    // an async suspension point.
    let count = unsafe { sendmsg(stream.as_raw_fd(), &message, 0x4000) };
    if count < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(count as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::FromRawFd;
    #[tokio::test]
    async fn one_transfer_carries_four_owned_descriptors_and_exact_frame() {
        let (sender, receiver) = std::os::unix::net::UnixStream::pair().unwrap();
        sender.set_nonblocking(true).unwrap();
        let stream = UnixStream::from_std(sender).unwrap();
        let descriptors: Vec<OwnedFd> = (0..4)
            .map(|_| std::fs::File::open("/dev/null").unwrap().into())
            .collect();
        let receive = tokio::task::spawn_blocking(move || {
            unsafe extern "C" {
                fn recvmsg(fd: i32, message: *mut Message, flags: i32) -> isize;
            }
            let mut bytes = [0u8; 128];
            let mut control = Control([0; 32]);
            let vector = IoVec {
                base: bytes.as_mut_ptr(),
                len: bytes.len(),
            };
            let mut message = Message {
                name: std::ptr::null(),
                name_len: 0,
                vectors: &vector,
                vector_count: 1,
                control: control.0.as_mut_ptr(),
                control_len: 32,
                flags: 0,
            };
            // SAFETY: mutable buffers remain live for this synchronous receive.
            let count = unsafe { recvmsg(receiver.as_raw_fd(), &mut message, 0x40000000) };
            assert!(count > 0);
            assert_eq!(message.flags & 8, 0);
            let size = usize::from_ne_bytes(control.0[..8].try_into().unwrap());
            assert_eq!(size, 32);
            let received: Vec<OwnedFd> = (0..4)
                .map(|index| {
                    let raw = i32::from_ne_bytes(
                        control.0[16 + index * 4..20 + index * 4]
                            .try_into()
                            .unwrap(),
                    );
                    // SAFETY: SCM_RIGHTS transferred a fresh descriptor to this process.
                    unsafe { OwnedFd::from_raw_fd(raw) }
                })
                .collect();
            assert_eq!(received.len(), 4);
            bytes[..count as usize].to_vec()
        });
        write(&stream, b"synthetic-launch-frame", &descriptors)
            .await
            .unwrap();
        assert_eq!(receive.await.unwrap(), b"synthetic-launch-frame");
    }
}
