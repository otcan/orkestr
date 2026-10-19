//! Single retained raw frame. Preparation is correlation, never authority.
use crate::{
    broker::channel::{BrokerChannel, PreparedRequest},
    containment::Error,
    ports::Blocker,
};
pub(super) struct PendingWrite {
    bytes: Vec<u8>,
    offset: usize,
    proof: Option<PreparedRequest>,
}
impl PendingWrite {
    pub(super) fn new(frame: &serde_json::Value) -> Result<Self, Blocker> {
        let mut bytes = serde_json::to_vec(frame).map_err(|_| Blocker::Protocol)?;
        if bytes.len() > 65536 || bytes.contains(&b'\n') {
            return Err(Blocker::Protocol);
        }
        bytes.push(b'\n');
        Ok(Self {
            bytes,
            offset: 0,
            proof: None,
        })
    }
    #[cfg(test)]
    pub(super) fn offset(&self) -> usize {
        self.offset
    }
    pub(super) fn prepared(&self) -> bool {
        self.proof.is_some()
    }
    pub(super) fn prepare(&mut self, channel: &mut BrokerChannel) -> Result<(), Blocker> {
        if self.proof.is_some() || self.offset != 0 {
            return Err(Blocker::Protocol);
        }
        self.proof = Some(channel.take_prepared()?);
        Ok(())
    }
    pub(super) fn write(
        &mut self,
        channel: &mut BrokerChannel,
        write: impl FnOnce(&[u8]) -> Result<usize, Error>,
    ) -> Result<bool, super::session::SetupFailure> {
        if self.proof.is_none() {
            return Err(Blocker::Protocol.into());
        }
        let end = (self.offset + 16384).min(self.bytes.len());
        // Offset advances only after the complete Core fenced call succeeds.
        // If COMMIT fails after I/O, caller quarantines; no suffix/replay follows.
        self.offset += write(&self.bytes[self.offset..end])?;
        if self.offset == self.bytes.len() {
            channel.finish_provider_write(self.proof.take().ok_or(Blocker::Protocol)?)?;
            return Ok(true);
        }
        Ok(false)
    }
}
