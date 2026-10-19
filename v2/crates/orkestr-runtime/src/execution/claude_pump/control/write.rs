//! Actual prepared native bytes, with the caller's cancellation fence per suffix.
use crate::{broker::claude::control::ClaudeControl, containment::Error, ports::Blocker};

pub(super) struct ControlWrite {
    bytes: Vec<u8>,
    offset: usize,
    failed: bool,
}
impl ControlWrite {
    pub(super) fn prepare(channel: &mut ClaudeControl) -> Result<Self, Blocker> {
        Ok(Self {
            bytes: channel.begin_write()?,
            offset: 0,
            failed: false,
        })
    }
    pub(super) fn write(
        &mut self,
        channel: &mut ClaudeControl,
        action: impl FnOnce(&[u8]) -> Result<usize, Error>,
    ) -> Result<bool, Blocker> {
        if self.failed || self.offset == self.bytes.len() {
            return Err(Blocker::Protocol);
        }
        let end = (self.offset + 16384).min(self.bytes.len());
        let count = match action(&self.bytes[self.offset..end]) {
            Ok(n) if n <= end - self.offset => n,
            _ => {
                self.failed = true;
                return Err(Blocker::Protocol);
            }
        };
        self.offset += count;
        if self.offset == self.bytes.len() {
            channel.finish_write()?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}
