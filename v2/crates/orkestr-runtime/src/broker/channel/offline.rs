//! Opt-in wire correlation; no native tool request grants execution authority.
use super::*;
use crate::broker::offline_tool::PendingOfflinePythonCall;
#[derive(Default)]
pub(super) struct OfflineState {
    enabled: bool,
    pub(super) pending: Option<PendingOfflinePythonCall>,
    seen_requests: std::collections::HashSet<String>,
    seen_calls: std::collections::HashSet<String>,
    pub(super) result_pending: bool,
    cancelled: bool,
    retired_tool: bool,
}
impl OfflineState {
    pub(super) fn cancel(&mut self) {
        self.retired_tool = self.pending.take().is_some();
        self.cancelled = true;
    }
}
impl BrokerChannel {
    pub(crate) fn bind_tool_native(&mut self, native: Option<String>) {
        self.native = native;
    }
    pub(crate) fn take_pending_offline_python(&mut self) -> Option<PendingOfflinePythonCall> {
        self.offline.pending.take()
    }
    pub(crate) fn restore_pending_offline_python(
        &mut self,
        call: PendingOfflinePythonCall,
    ) -> Result<(), Blocker> {
        if self.offline.cancelled || self.offline.pending.is_some() {
            return Err(Blocker::Protocol);
        }
        self.offline.pending = Some(call);
        Ok(())
    }
    pub(crate) fn enable_offline_python(&mut self) -> Result<(), Blocker> {
        if self.execution_claimed || self.pending.is_some() || self.next != 2 {
            return Err(Blocker::Protocol);
        }
        self.offline.enabled = true;
        Ok(())
    }
    pub(crate) fn pending_offline_python(&self) -> Option<&PendingOfflinePythonCall> {
        self.offline.pending.as_ref()
    }
    pub(super) fn accept_offline_call(&mut self, frame: &Value) -> Result<(), Blocker> {
        if !self.offline.enabled
            || self.offline.cancelled
            || self.terminal_observed
            || self.offline.pending.is_some()
            || self.pending.is_some()
            || self.offline.seen_calls.len() >= 128
        {
            return Err(Blocker::Protocol);
        }
        let turn = self.active_turn.as_deref().ok_or(Blocker::Protocol)?;
        let native = self.native.as_deref().ok_or(Blocker::Protocol)?;
        // Native identity is checked against the consumed admission again by the
        // pump before exposing this request. A caller cannot construct it.
        let call = PendingOfflinePythonCall::decode(
            frame,
            native,
            turn,
            self.lineage.clone().ok_or(Blocker::Protocol)?,
        )?;
        let key = frame["id"].to_string();
        if self.offline.seen_requests.contains(&key)
            || self.offline.seen_calls.contains(call.call_id())
        {
            return Err(Blocker::Protocol);
        }
        self.offline.seen_requests.insert(key);
        self.offline.seen_calls.insert(call.call_id().to_owned());
        self.offline.pending = Some(call);
        Ok(())
    }
    pub(super) fn validate_offline_terminal(&self, frame: &Value) -> Result<(), Blocker> {
        if frame["method"] == "turn/completed"
            && (self.offline.pending.is_some()
                || (self.offline.retired_tool
                    && frame.pointer("/params/turn/status").and_then(Value::as_str)
                        != Some("interrupted")))
        {
            return Err(Blocker::Protocol);
        }
        Ok(())
    }
    pub(crate) fn tool_result(
        &mut self,
        frame: Value,
    ) -> Result<(std::sync::Arc<()>, Vec<u8>), Blocker> {
        if self.offline.cancelled
            || self.offline.result_pending
            || self.offline.pending.is_none()
            || self.terminal_observed
            || self.preparation != Some(Preparation::Written)
        {
            return Err(Blocker::Protocol);
        }
        let bytes = self.wrap("ToolResult", frame)?;
        // A native response has no provider ACK. The broker's null reply is
        // admitted only after Prepared + every actual suffix + Core finish.
        self.pending.as_mut().ok_or(Blocker::Protocol)?.1 = None;
        self.offline.result_pending = true;
        Ok((self.lineage.clone().ok_or(Blocker::Protocol)?, bytes))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn active() -> BrokerChannel {
        let mut c = OwnedMetadataHandle {
            _handle: "synthetic_owned".into(),
            lineage: Some(std::sync::Arc::new(())),
        }
        .into_channel();
        c.enable_offline_python().unwrap();
        c.bind_tool_native(Some("native".into()));
        c.require_prepared().unwrap();
        c.reserve_execution(7).unwrap();
        feed(&mut c, json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":2}})).unwrap();
        let proof = c.take_prepared().unwrap();
        c.finish_provider_write(proof).unwrap();
        feed(&mut c, json!({"id":2,"result":{"owned_handle":"synthetic_owned","frame":{"id":7,"result":{"turn":{"id":"turn"}}}}})).unwrap();
        c
    }
    fn feed(c: &mut BrokerChannel, v: Value) -> Result<Option<Value>, Blocker> {
        c.receive(v.to_string().as_bytes())
    }
    fn call(native: &str) -> Value {
        json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic_owned","frame":{"id":"request","method":"item/tool/call","params":{"threadId":native,"turnId":"turn","callId":"call","tool":"orkestr_offline_python","arguments":{"source":"print(1)"}}}}})
    }
    #[test]
    fn pending_call_preserves_source_and_progress_then_issued_cancel_retires() {
        let mut c = active();
        feed(&mut c, call("native")).unwrap();
        assert_eq!(c.pending_offline_python().unwrap().source(), "print(1)");
        assert!(feed(&mut c,json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic_owned","frame":{"method":"item/agentMessage/delta","params":{"turnId":"turn","delta":"progress"}}}})).unwrap().is_some());
        c.cancellation(json!({"id":99,"method":"turn/interrupt","params":{"threadId":"native","turnId":"turn"}})).unwrap();
        assert!(c.pending_offline_python().is_none());
        assert!(c.tool_result(json!({"id":"request","result":{}})).is_err());
        assert!(feed(&mut c, call("native")).is_err());
    }
    #[test]
    fn foreign_native_duplicate_and_pending_terminal_refused() {
        let mut c = active();
        assert!(feed(&mut c, call("foreign")).is_err());
        let mut c = active();
        feed(&mut c, call("native")).unwrap();
        assert!(feed(&mut c, call("native")).is_err());
        let mut c = active();
        feed(&mut c, call("native")).unwrap();
        assert!(feed(&mut c,json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic_owned","frame":{"method":"turn/completed","params":{"turn":{"id":"turn","status":"completed"}}}}})).is_err());
    }
    #[test]
    fn result_null_cannot_precede_actual_write_and_retired_id_cannot_recur() {
        let mut c = active();
        feed(&mut c, call("native")).unwrap();
        c.tool_result(json!({"id":"request","result":{"contentItems":[{"type":"inputText","text":"ok"}],"success":true}})).unwrap();
        let null = json!({"id":3,"result":{"owned_handle":"synthetic_owned","frame":null}});
        // Prepared alone never admits the null completion.
        feed(&mut c,json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":3}})).unwrap();
        let proof = c.take_prepared().unwrap();
        c.finish_provider_write(proof).unwrap();
        feed(&mut c, null).unwrap();
        assert!(c.pending_offline_python().is_none());
        assert!(feed(&mut c, call("native")).is_err());
    }
    #[test]
    fn result_null_before_actual_write_is_refused() {
        let mut c = active();
        feed(&mut c, call("native")).unwrap();
        c.tool_result(json!({"id":"request","result":{"contentItems":[{"type":"inputText","text":"ok"}],"success":true}})).unwrap();
        feed(&mut c,json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":3}})).unwrap();
        assert!(feed(
            &mut c,
            json!({"id":3,"result":{"owned_handle":"synthetic_owned","frame":null}})
        )
        .is_err());
    }
    #[test]
    fn duplicate_escaped_native_keys_refused_on_wire() {
        let mut c = active();
        let frame = call("native").to_string().replace(
            "\"threadId\":\"native\"",
            "\"threadId\":\"foreign\",\"thread\\u0049d\":\"native\"",
        );
        assert!(c.receive(frame.as_bytes()).is_err());
    }
}
