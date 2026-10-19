//! Private, one-shot Linux SCM_RIGHTS handoff. Never exposes a provider fd.
use super::Error;
use std::fs::File;
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::FileTypeExt;
use std::os::unix::net::UnixStream;

const MARKER: &[u8] = b"provider-stdin-v1";
#[repr(C)]
struct IoVec {
    base: *mut u8,
    len: usize,
}
#[repr(C)]
struct Message {
    name: *mut u8,
    name_len: u32,
    vectors: *mut IoVec,
    vector_count: usize,
    control: *mut u8,
    control_len: usize,
    flags: i32,
}
#[repr(C, align(8))]
struct Control([u8; 256]);
unsafe extern "C" {
    fn fcntl(fd: i32, command: i32, ...) -> i32;
    fn recvmsg(fd: i32, message: *mut Message, flags: i32) -> isize;
}

pub(super) struct Handoff {
    socket: UnixStream,
    finished: bool,
}
pub(super) struct ProviderWriter {
    file: File,
}
impl Handoff {
    pub(super) fn pair() -> Result<(Self, UnixStream), Error> {
        let (parent, child) = UnixStream::pair().map_err(|_| Error::Io)?;
        parent.set_nonblocking(true).map_err(|_| Error::Io)?;
        Ok((
            Self {
                socket: parent,
                finished: false,
            },
            child,
        ))
    }
    /// MSG_CMSG_CLOEXEC closes the exec leak window. Every received descriptor is
    /// adopted before validation, so malformed/multiple rights cannot leak fds.
    pub(super) fn receive(&mut self) -> Result<Option<ProviderWriter>, Error> {
        if self.finished {
            return Err(Error::AuthorityProtocol);
        }
        let mut bytes = [0u8; 64];
        let mut control = Control([0; 256]);
        let mut vector = IoVec {
            base: bytes.as_mut_ptr(),
            len: bytes.len(),
        };
        let mut message = Message {
            name: std::ptr::null_mut(),
            name_len: 0,
            vectors: &mut vector,
            vector_count: 1,
            control: control.0.as_mut_ptr(),
            control_len: control.0.len(),
            flags: 0,
        };
        // SAFETY: all buffers remain live and correctly aligned for recvmsg.
        let count = unsafe { recvmsg(self.socket.as_raw_fd(), &mut message, 0x40000000) };
        if count < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock {
                return Ok(None);
            }
            self.finished = true;
            return Err(Error::Io);
        }
        self.finished = true;
        let mut descriptors = Vec::new();
        let mut offset = 0;
        let mut valid = true;
        while offset + 16 <= message.control_len {
            let header = &control.0[offset..];
            let length = usize::from_ne_bytes(header[..8].try_into().unwrap());
            let level = i32::from_ne_bytes(header[8..12].try_into().unwrap());
            let kind = i32::from_ne_bytes(header[12..16].try_into().unwrap());
            if length < 16 || length > message.control_len - offset {
                valid = false;
                break;
            }
            if level == 1 && kind == 1 {
                if !(length - 16).is_multiple_of(4) {
                    valid = false;
                }
                for raw in header[16..length].as_chunks::<4>().0 {
                    let fd = i32::from_ne_bytes(*raw);
                    // SAFETY: SCM_RIGHTS returns newly owned descriptors.
                    descriptors.push(unsafe { OwnedFd::from_raw_fd(fd) });
                }
            } else {
                valid = false;
            }
            offset += (length + 7) & !7;
        }
        if !valid
            || message.flags & (8 | 32) != 0
            || count as usize != MARKER.len()
            || &bytes[..count.max(0) as usize] != MARKER
            || descriptors.len() != 1
        {
            return Err(Error::AuthorityProtocol);
        }
        let file = File::from(descriptors.pop().unwrap());
        // Only a write-only anonymous pipe is a provider writer; never accept a
        // socket, regular file or readable descriptor from even a trusted child.
        if !file
            .metadata()
            .map_err(|_| Error::Io)?
            .file_type()
            .is_fifo()
            || unsafe { fcntl(file.as_raw_fd(), 3) } & 3 != 1
        {
            return Err(Error::AuthorityProtocol);
        }
        super::sys::nonblocking(&file)?;
        Ok(Some(ProviderWriter { file }))
    }
}
impl ProviderWriter {
    /// Caller holds the actual Core purpose fence. One syscall, bounded suffix;
    /// no waits, retries or offset advancement on WouldBlock.
    pub(super) fn write_suffix(&mut self, bytes: &[u8]) -> Result<usize, Error> {
        if bytes.is_empty() || bytes.len() > 65536 {
            return Err(Error::InvalidBounds);
        }
        match self.file.write(bytes) {
            Ok(0) => Err(Error::PipeClosed),
            Ok(count) => Ok(count),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(0),
            Err(_) => Err(Error::Io),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    fn handoff(marker: &str, count: usize) -> Result<Vec<u8>, Error> {
        let (mut handoff, child_socket) = Handoff::pair()?;
        let script = r#"import socket,os,array,sys
s=socket.socket(fileno=3)
r,w=os.pipe()
s.sendmsg([sys.argv[1].encode()],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[w]*int(sys.argv[2])))])
os.close(w)
s.close()
sys.stdout.buffer.write(os.read(r,64))
"#;
        let mut command = Command::new("/usr/bin/python3");
        command
            .args(["-c", script, marker, &count.to_string()])
            .stdout(Stdio::piped());
        super::super::sys::configure_command(&mut command);
        super::super::sys::inherit_handoff(&mut command, child_socket.as_raw_fd(), None).unwrap();
        let child = command.spawn().map_err(|_| Error::Io)?;
        drop(child_socket);
        let deadline = Instant::now() + Duration::from_secs(5);
        let result = loop {
            match handoff.receive() {
                Ok(None) if Instant::now() < deadline => std::thread::yield_now(),
                other => break other,
            }
        };
        let result = match result {
            Ok(Some(mut writer)) => {
                assert_eq!(writer.write_suffix(b"owned-provider-input")?, 20);
                drop(writer);
                Ok(())
            }
            Ok(None) => Err(Error::Io),
            Err(error) => Err(error),
        };
        let output = child.wait_with_output().map_err(|_| Error::Io)?;
        result?;
        assert!(output.status.success());
        Ok(output.stdout)
    }
    #[test]
    fn transfers_only_owned_writer_and_closes_broker_copy() {
        assert_eq!(
            handoff("provider-stdin-v1", 1).unwrap(),
            b"owned-provider-input"
        );
    }
    #[test]
    fn refuses_wrong_marker_and_multiple_descriptors_without_leaking_writer() {
        assert_eq!(handoff("wrong", 1), Err(Error::AuthorityProtocol));
        assert_eq!(
            handoff("provider-stdin-v1", 2),
            Err(Error::AuthorityProtocol)
        );
    }
}
