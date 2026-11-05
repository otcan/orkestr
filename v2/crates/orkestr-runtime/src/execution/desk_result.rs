//! One immutable Core result, never caller-supplied helper output.
use super::*;
use crate::broker::channel::{BrokerChannel, PreparedRequest};
use orkestr_v2_store_sqlite::{CompletedDeskLogin, Store};
pub(super) struct DeskResultWrite {
    delivery: Option<CompletedDeskLogin>,
    bytes: Vec<u8>,
    proof: Option<PreparedRequest>,
}
impl DeskResultWrite {
    pub(super) fn prepared(&self) -> bool {
        self.proof.is_some()
    }
    pub(super) fn finished(&self) -> bool {
        self.delivery.is_none()
    }
    pub(super) fn prepare(&mut self, channel: &mut BrokerChannel) -> Result<(), Blocker> {
        if self.proof.is_some()
            || self
                .delivery
                .as_ref()
                .is_none_or(|d| d.written_bytes() != 0)
        {
            return Err(Blocker::Protocol);
        }
        self.proof = Some(channel.take_prepared()?);
        Ok(())
    }
}
impl CodexPump {
    pub fn pending_desk_login(&self) -> Option<&crate::broker::desk_tool::PendingDeskLoginCall> {
        self.source.broker.as_ref()?.pending_desk_login()
    }
    pub fn write_desk_login_result(&mut self, delivery: CompletedDeskLogin) -> Result<(), Blocker> {
        let result = (|| {
            if self.source.desk_write.is_some()
                || self.source.tool_write.is_some()
                || self.source.workspace_write.is_some()
                || self.cursor.pending().is_some()
                || self.source.failed.is_some()
            {
                return Err(Blocker::Protocol);
            }
            let pending = self
                .pending_desk_login()
                .ok_or(Blocker::Protocol)?
                .native_call();
            let call = delivery.native_call();
            if delivery.parent() != &self.admission
                || delivery.written_bytes() != 0
                || call.request_id != pending.request_id
                || call.call_id != pending.call_id
                || call.thread_id != pending.thread_id
                || call.turn_id != pending.turn_id
                || call.operation_id != pending.operation_id
            {
                return Err(Blocker::Protocol);
            }
            let bytes = delivery.bytes().to_vec();
            let frame = serde_json::from_slice(&bytes).map_err(|_| Blocker::Protocol)?;
            let channel = self.source.broker.as_mut().ok_or(Blocker::Protocol)?;
            let (lineage, envelope) = channel.desk_result(frame)?;
            self.source
                .child
                .enqueue_tool_result(&self.source.scope, &lineage, &envelope)
                .map_err(|_| Blocker::Protocol)?;
            self.source.desk_write = Some(DeskResultWrite {
                delivery: Some(delivery),
                bytes,
                proof: None,
            });
            Ok(())
        })();
        if result.is_err() {
            self.source.child.quarantine();
            self.source.failed = Some(Blocker::Protocol);
        }
        result
    }
    pub async fn poll_desk_login_result(
        &mut self,
        store: &Store,
        credential: &str,
    ) -> Result<bool, Blocker> {
        let result = self.poll_desk_result_inner(store, credential).await;
        if result.is_err() {
            self.source.child.quarantine();
            self.source.failed = Some(Blocker::Protocol);
        }
        result
    }
    async fn poll_desk_result_inner(
        &mut self,
        store: &Store,
        credential: &str,
    ) -> Result<bool, Blocker> {
        let Some(write) = self.source.desk_write.as_mut() else {
            return Ok(false);
        };
        let channel = self.source.broker.as_mut().ok_or(Blocker::Protocol)?;
        if write.finished() {
            if channel.pending_desk_login().is_none() {
                self.source.desk_write = None;
                return Ok(true);
            }
            return Ok(false);
        }
        if !write.prepared() {
            return Ok(false);
        }
        let delivery = write.delivery.as_mut().ok_or(Blocker::Protocol)?;
        let offset = delivery.written_bytes();
        if offset < write.bytes.len() {
            let end = (offset + 16384).min(write.bytes.len());
            self.source
                .child
                .write_desk_result_suffix(
                    store,
                    credential,
                    &self.source.scope,
                    channel.pending_desk_login().ok_or(Blocker::Protocol)?,
                    &self.admission,
                    delivery,
                    &write.bytes[offset..end],
                )
                .map_err(|_| Blocker::Protocol)?;
        }
        if delivery.written_bytes() != write.bytes.len() {
            return Ok(false);
        }
        store
            .finish_desk_login_result(credential, write.delivery.take().ok_or(Blocker::Protocol)?)
            .await
            .map_err(|_| Blocker::Protocol)?;
        channel.finish_provider_write(write.proof.take().ok_or(Blocker::Protocol)?)?;
        Ok(false)
    }
}
