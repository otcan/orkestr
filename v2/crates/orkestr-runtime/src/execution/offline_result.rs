//! One immutable native response, derived only from a consumed result grant.
use super::*;
use crate::broker::{
    channel::{BrokerChannel, PreparedRequest},
    offline_tool::PendingOfflinePythonCall,
};
use orkestr_v2_application::runtime::ProviderAdmission;
use orkestr_v2_store_sqlite::{CompletedToolDelivery, OfflinePythonNativeRequestId, Store};

/// Private until the opt-in pending-call channel is composed. No raw response
/// constructor or reusable result grant is exposed to server/browser callers.
pub(super) struct ToolResultWrite {
    delivery: Option<CompletedToolDelivery>,
    bytes: Vec<u8>,
    proof: Option<PreparedRequest>,
}
impl ToolResultWrite {
    pub(super) fn prepared(&self) -> bool {
        self.proof.is_some()
    }
    pub(super) fn finished(&self) -> bool {
        self.delivery.is_none()
    }
    pub(super) fn enqueue(
        &self,
        channel: &mut BrokerChannel,
        child: &OwnedChild,
        scope: &ExecutionScope,
    ) -> Result<(), Blocker> {
        let frame = serde_json::from_slice(&self.bytes).map_err(|_| Blocker::Protocol)?;
        let (lineage, envelope) = channel.tool_result(frame)?;
        child
            .enqueue_tool_result(scope, &lineage, &envelope)
            .map_err(|_| Blocker::Protocol)
    }
    pub(super) fn new(
        pending: &PendingOfflinePythonCall,
        original: &ProviderAdmission,
        delivery: CompletedToolDelivery,
    ) -> Result<Self, Blocker> {
        let call = delivery.native_call();
        if delivery.parent() != original
            || !delivery.matches_source(pending.source())
            || delivery.written_bytes() != 0
            || &call.request_id != pending.request_id()
            || call.call_id != pending.call_id()
            || call.thread_id != pending.thread_id()
            || call.turn_id != pending.turn_id()
            || original.binding.native_session_id.as_deref() != Some(pending.thread_id())
        {
            return Err(Blocker::Protocol);
        }
        let bytes = response(&call.request_id, delivery.text(), delivery.success())?;
        Ok(Self {
            delivery: Some(delivery),
            bytes,
            proof: None,
        })
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
    /// One bounded actual suffix. No broker/provider wait occurs inside Core.
    #[allow(clippy::too_many_arguments)] // Exact child, call and issuer identities remain explicit.
    pub(super) async fn poll(
        &mut self,
        store: &Store,
        credential: &str,
        child: &OwnedChild,
        scope: &ExecutionScope,
        pending: &PendingOfflinePythonCall,
        original: &ProviderAdmission,
        channel: &mut BrokerChannel,
    ) -> Result<bool, Blocker> {
        if self.proof.is_none() {
            return Ok(false);
        }
        let delivery = self.delivery.as_mut().ok_or(Blocker::Protocol)?;
        let offset = delivery.written_bytes();
        if offset > self.bytes.len() {
            child.quarantine();
            return Err(Blocker::Protocol);
        }
        if offset < self.bytes.len() {
            let end = (offset + 16384).min(self.bytes.len());
            child
                .write_tool_result_suffix(
                    store,
                    credential,
                    scope,
                    pending,
                    original,
                    delivery,
                    &self.bytes[offset..end],
                )
                .map_err(|_| Blocker::Protocol)?;
        }
        if delivery.written_bytes() != self.bytes.len() {
            return Ok(false);
        }
        // Consumed on every finish outcome: uncertainty cannot recover a writer.
        let delivery = self.delivery.take().ok_or(Blocker::Protocol)?;
        if store
            .finish_offline_python_result(credential, delivery, self.bytes.len())
            .await
            .is_err()
        {
            child.quarantine();
            return Err(Blocker::Protocol);
        }
        if channel
            .finish_provider_write(self.proof.take().ok_or(Blocker::Protocol)?)
            .is_err()
        {
            child.quarantine();
            return Err(Blocker::Protocol);
        }
        Ok(true)
    }
}
fn response(
    id: &OfflinePythonNativeRequestId,
    text: &str,
    success: bool,
) -> Result<Vec<u8>, Blocker> {
    if !id.is_valid() || text.len() > 8192 {
        return Err(Blocker::Protocol);
    }
    let id = match id {
        OfflinePythonNativeRequestId::Text(s) => json!(s),
        OfflinePythonNativeRequestId::Integer(n) => json!(n),
    };
    let mut bytes = serde_json::to_vec(&json!({"id":id,"result":{"contentItems":[{"type":"inputText","text":text}],"success":success}})).map_err(|_| Blocker::Protocol)?;
    bytes.push(b'\n');
    if bytes.len() > 65536 {
        return Err(Blocker::Protocol);
    }
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_response_preserves_id_kind_and_escapes_one_jsonl_frame() {
        for id in [
            OfflinePythonNativeRequestId::Text("call:1".into()),
            OfflinePythonNativeRequestId::Integer(7),
        ] {
            let bytes = response(&id, "line1\nline2\"", false).unwrap();
            assert_eq!(bytes.iter().filter(|b| **b == b'\n').count(), 1);
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["result"]["success"], false);
            assert_eq!(value["result"]["contentItems"][0]["text"], "line1\nline2\"");
            assert_eq!(
                value["id"].is_string(),
                matches!(id, OfflinePythonNativeRequestId::Text(_))
            );
        }
    }
    #[test]
    fn maximum_utf8_and_escaping_are_bounded_without_truncation() {
        let id = OfflinePythonNativeRequestId::Integer(1);
        let text = "\u{0000}".repeat(8192);
        assert!(response(&id, &text, true).unwrap().len() < 65536);
        assert!(response(&id, &(text + "x"), true).is_err());
        assert!(response(&OfflinePythonNativeRequestId::Integer(0), "", true).is_err());
    }
}
