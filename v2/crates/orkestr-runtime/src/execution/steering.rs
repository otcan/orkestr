//! A consumed steer is one immutable native frame, never a dispatch retry.
use super::*;
use crate::broker::channel::{BrokerChannel, PreparedRequest};
use orkestr_v2_store_sqlite::{CodexSteeringAuthority, ConsumedSteering, Store};
use std::sync::Arc;

/// Native acknowledgement is independent of terminal provider completion.
#[derive(Debug, PartialEq, Eq)]
pub enum SteeringProgress {
    Pending,
    Acknowledged,
}
pub(super) struct SteerWrite {
    delivery: Option<Box<ConsumedSteering>>,
    bytes: Vec<u8>,
    lineage: Arc<()>,
    proof: Option<PreparedRequest>,
    written: bool,
}
impl SteerWrite {
    pub(super) fn prepare(&mut self, channel: &mut BrokerChannel) -> Result<(), Blocker> {
        if self.proof.is_some() || self.written {
            return Err(Blocker::Protocol);
        }
        self.proof = Some(channel.take_prepared()?);
        Ok(())
    }
}
impl CodexPump {
    /// Capture the Core issuer before attachment; bind it only to the native
    /// turn actually observed on this owned channel. No caller turn ID exists.
    pub async fn bind_steering_turn(
        &self,
        store: &Store,
        authority: &CodexSteeringAuthority,
    ) -> Result<(), Blocker> {
        if authority.provider() != &self.admission
            || self.source.failed.is_some()
            || self.cursor.pending().is_some()
            || self.source.writing.is_some()
        {
            return Err(Blocker::Protocol);
        }
        let turn = self
            .source
            .broker
            .as_ref()
            .ok_or(Blocker::Unsupported)?
            .steering_turn()?;
        store
            .bind_codex_steering_turn(authority, turn)
            .await
            .map_err(|_| Blocker::Protocol)
    }
    /// Takes the already consumed Core capability on every outcome. Flush the
    /// broker pipe and drive step/poll_steering under the same per-run lock.
    pub fn begin_steering(&mut self, delivery: Box<ConsumedSteering>) -> Result<(), Blocker> {
        let result = (|| {
            if self.source.failed.is_some()
                || self.source.eof
                || self.source.writing.is_some()
                || self.source.steering.is_some()
                || self.source.tool_write.is_some()
                || self.pending_offline_python().is_some()
                || self.cursor.pending().is_some()
                || delivery.provider() != &self.admission
                || delivery.written_bytes() != 0
            {
                return Err(Blocker::Protocol);
            }
            let channel = self.source.broker.as_mut().ok_or(Blocker::Unsupported)?;
            if channel.steering_turn()? != delivery.expected_turn_id() {
                return Err(Blocker::Protocol);
            }
            let frame = frame(&delivery);
            let mut bytes = serde_json::to_vec(&frame).map_err(|_| Blocker::Protocol)?;
            bytes.push(b'\n');
            if bytes.len() > 65536 {
                return Err(Blocker::Protocol);
            }
            let (lineage, envelope) = channel.steering(
                delivery.request_id().to_string(),
                delivery.expected_turn_id(),
                frame,
            )?;
            self.source
                .child
                .enqueue_steering(&self.source.scope, &lineage, &envelope)
                .map_err(|_| Blocker::Protocol)?;
            self.source.steering = Some(SteerWrite {
                delivery: Some(delivery),
                bytes,
                lineage,
                proof: None,
                written: false,
            });
            Ok(())
        })();
        if result.is_err() {
            self.source.child.quarantine();
            self.source.failed = Some(Blocker::Protocol);
        }
        result
    }
    /// One bounded nonblocking native suffix. Preparation/ACK waits occur
    /// outside SQLite. Any uncertainty burns the writer and quarantines child.
    pub async fn poll_steering(&mut self, store: &Store) -> Result<SteeringProgress, Blocker> {
        let result = self.poll_steering_inner(store).await;
        if result.is_err() {
            self.source.child.quarantine();
            self.source.failed = Some(Blocker::Protocol);
        }
        result
    }
    async fn poll_steering_inner(&mut self, store: &Store) -> Result<SteeringProgress, Blocker> {
        let write = self.source.steering.as_mut().ok_or(Blocker::Protocol)?;
        let channel = self.source.broker.as_mut().ok_or(Blocker::Protocol)?;
        if write.proof.is_none() && !write.written {
            return Ok(SteeringProgress::Pending);
        }
        let delivery = write.delivery.as_mut().ok_or(Blocker::Protocol)?;
        if !write.written {
            let offset = delivery.written_bytes();
            if offset >= write.bytes.len() {
                return Err(Blocker::Protocol);
            }
            let end = (offset + 16384).min(write.bytes.len());
            self.source
                .child
                .write_steering_suffix(
                    store,
                    &self.source.scope,
                    &self.admission,
                    &write.lineage,
                    delivery,
                    &write.bytes[offset..end],
                )
                .map_err(|_| Blocker::Protocol)?;
            if delivery.written_bytes() != write.bytes.len() {
                return Ok(SteeringProgress::Pending);
            }
            channel.finish_provider_write(write.proof.take().ok_or(Blocker::Protocol)?)?;
            write.written = true;
        }
        let Some(accepted) = channel.take_steering_ack() else {
            return Ok(SteeringProgress::Pending);
        };
        let delivery = write.delivery.take().ok_or(Blocker::Protocol)?;
        store
            .acknowledge_codex_steering(*delivery, write.bytes.len(), accepted)
            .await
            .map_err(|_| Blocker::Protocol)?;
        self.source.steering = None;
        Ok(SteeringProgress::Acknowledged)
    }
}
fn frame(delivery: &ConsumedSteering) -> serde_json::Value {
    json!({"id":delivery.request_id().to_string(),"method":"turn/steer","params":{
        "threadId":delivery.thread_id(),"expectedTurnId":delivery.expected_turn_id(),
        "input":[{"type":"text","text":delivery.text(),"text_elements":[]}]}})
}
