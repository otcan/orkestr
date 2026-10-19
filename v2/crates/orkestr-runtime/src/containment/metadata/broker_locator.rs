//! Owned-child locators for an independent manager ownership check only.
use super::{Error, MetadataChild};

/// Not authority, not serializable, and never accepted back for signalling.
pub struct BrokerChildLocator {
    pid: u32,
    start: u64,
}
impl BrokerChildLocator {
    pub fn pid(&self) -> u32 {
        self.pid
    }
    pub fn start(&self) -> u64 {
        self.start
    }
}
impl MetadataChild {
    pub(crate) fn broker_locator(&self) -> Result<BrokerChildLocator, Error> {
        if !self.broker_launcher {
            return Err(Error::AuthorityProtocol);
        }
        let live = self.process.live.lock().map_err(|_| Error::Revoked)?;
        let child = live.child.as_ref().ok_or(Error::PipeClosed)?;
        let pid = child.id();
        // The original Child remains retained under the lock. This is merely
        // a locator; the root manager authenticates ancestry/source independently.
        locator(pid)
    }
}

fn locator(pid: u32) -> Result<BrokerChildLocator, Error> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|_| Error::Io)?;
    let (_, fields) = stat.rsplit_once(')').ok_or(Error::AuthorityProtocol)?;
    let start = fields
        .split_whitespace()
        .nth(19)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n != 0)
        .ok_or(Error::AuthorityProtocol)?;
    Ok(BrokerChildLocator { pid, start })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[test]
    fn stopped_original_child_has_locator_without_fd_handoff() {
        let mut child = Command::new("/usr/bin/python3")
            .args([
                "-I",
                "-S",
                "-c",
                "import os,signal; os.kill(os.getpid(),signal.SIGSTOP)",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let stopped = loop {
            let status = std::fs::read_to_string(format!("/proc/{}/status", child.id())).unwrap();
            if status
                .lines()
                .any(|line| line.starts_with("State:") && line.contains("T (stopped)"))
            {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(2));
        };
        let result = locator(child.id());
        // Always reap the original Child, including assertion failure paths.
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(stopped, "synthetic broker never reached pre-native stop");
        let bound = result.unwrap();
        assert_eq!(bound.pid(), child.id());
        assert_ne!(bound.start(), 0);
    }
}
