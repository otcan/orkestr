//! Single-turn Claude framing. Correlation never creates execution authority.
use super::{Blocker, BrokerOpen, Value};
use crate::claude_rpc::ClaudeRpc;
use std::sync::Arc;

pub(crate) struct ClaudeChannel {
    native: String,
    handle: String,
    lineage: Arc<()>,
    initialized: bool,
    system_seen: bool,
    reserved: bool,
    prepared: bool,
    writing: bool,
    written: bool,
    poisoned: bool,
}
/// Private consumed-turn wrapper receives this once. No Clone or raw constructor.
pub(crate) struct ClaudeExecutionEnvelope {
    pub(super) lineage: Arc<()>,
    handle: String,
}
impl ClaudeExecutionEnvelope {
    pub(crate) fn lineage(&self) -> Arc<()> {
        self.lineage.clone()
    }
    pub(crate) fn wrap(self, message_id: &str, frame: Value) -> Value {
        serde_json::json!({"id":3,"method":"CommitExecution","params":{
            "owned_handle":self.handle,"message_id":message_id,"frame":frame}})
    }
}
impl ClaudeChannel {
    pub(crate) fn open(mut open: BrokerOpen, bytes: &[u8]) -> Result<Self, Blocker> {
        if bytes.len() > 16384 || open.identity["provider"] != "claude" {
            return Err(Blocker::Protocol);
        }
        let mut reply: Value = serde_json::from_slice(bytes).map_err(|_| Blocker::Protocol)?;
        let result = reply
            .get_mut("result")
            .and_then(Value::as_object_mut)
            .ok_or(Blocker::Protocol)?;
        if result.len() != 5 {
            return Err(Blocker::Protocol);
        }
        let native = result
            .remove("native_session")
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or(Blocker::Protocol)?;
        // Parser validates the native UUID without granting readiness or auth.
        ClaudeRpc::new(&native, "turn:2")?;
        let handle = open.receive(&serde_json::to_vec(&reply).map_err(|_| Blocker::Protocol)?)?;
        Ok(Self {
            native,
            handle: handle._handle,
            lineage: handle.lineage.ok_or(Blocker::Protocol)?,
            initialized: false,
            system_seen: false,
            reserved: false,
            prepared: false,
            writing: false,
            written: false,
            poisoned: false,
        })
    }
    pub(crate) fn initialize_protocol(&self) -> super::claude_initialize::ClaudeInitialize {
        super::claude_initialize::ClaudeInitialize::new(self.handle.clone(), self.lineage.clone())
    }
    pub(crate) fn complete_initialization(
        &mut self,
        proof: super::claude_initialize::ClaudeInitialize,
    ) -> Result<(), Blocker> {
        if self.poisoned
            || self.initialized
            || self.reserved
            || !proof.matches_completed(&self.handle, &self.lineage)
        {
            self.poisoned = true;
            return Err(Blocker::Protocol);
        }
        self.initialized = true;
        Ok(())
    }
    pub(crate) fn native(&self) -> &str {
        &self.native
    }
    pub(crate) fn reserve(&mut self) -> Result<ClaudeExecutionEnvelope, Blocker> {
        if self.poisoned || !self.initialized || self.reserved {
            return Err(Blocker::Protocol);
        }
        self.reserved = true;
        Ok(ClaudeExecutionEnvelope {
            lineage: self.lineage.clone(),
            handle: self.handle.clone(),
        })
    }
    pub(crate) fn begin_write(&mut self) -> Result<(), Blocker> {
        if self.poisoned || !self.prepared || self.writing || self.written {
            return Err(Blocker::Protocol);
        }
        self.writing = true;
        Ok(())
    }
    pub(crate) fn finish_write(&mut self) -> Result<(), Blocker> {
        if self.poisoned || !self.writing || self.written {
            return Err(Blocker::Protocol);
        }
        self.written = true;
        Ok(())
    }
    /// None is a preparation notification. Any failure permanently poisons this
    /// owned channel; neither a lost reply nor a terminal permits another turn.
    pub(crate) fn receive(&mut self, bytes: &[u8]) -> Result<Option<Value>, Blocker> {
        if self.poisoned {
            return Err(Blocker::Protocol);
        }
        let result = self.decode(bytes);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }
    fn decode(&mut self, bytes: &[u8]) -> Result<Option<Value>, Blocker> {
        if bytes.len() > 65536 {
            return Err(Blocker::Protocol);
        }
        let value: Value = serde_json::from_slice(bytes).map_err(|_| Blocker::Protocol)?;
        let outer = value.as_object().ok_or(Blocker::Protocol)?;
        let params = value
            .get("params")
            .and_then(Value::as_object)
            .ok_or(Blocker::Protocol)?;
        if outer.len() != 2
            || params.get("owned_handle").and_then(Value::as_str) != Some(&self.handle)
        {
            return Err(Blocker::Protocol);
        }
        match value.get("method").and_then(Value::as_str) {
            Some("BrokerPrepared")
                if params.len() == 2
                    && self.reserved
                    && !self.prepared
                    && params.get("request_id").and_then(Value::as_u64) == Some(3) =>
            {
                self.prepared = true;
                Ok(None)
            }
            Some("BrokerOutput") if params.len() == 3 => {
                let frame = params.get("frame").ok_or(Blocker::Protocol)?;
                if frame.get("session_id").and_then(Value::as_str) != Some(&self.native) {
                    return Err(Blocker::StaleLease);
                }
                let init = frame.get("type").and_then(Value::as_str) == Some("system")
                    && frame.get("subtype").and_then(Value::as_str) == Some("init");
                if init {
                    if self.system_seen
                        || !self.initialized
                        || !self.written
                        || params.get("request_id").and_then(Value::as_u64) != Some(3)
                    {
                        return Err(Blocker::Protocol);
                    }
                    self.system_seen = true;
                } else if !self.written
                    || params.get("request_id").and_then(Value::as_u64) != Some(3)
                {
                    return Err(Blocker::Protocol);
                }
                Ok(Some(frame.clone()))
            }
            _ => Err(Blocker::Protocol),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn channel() -> ClaudeChannel {
        let identity = json!({"provider":"claude"});
        let mut open = BrokerOpen::new(identity.clone());
        open.bind_lineage(Arc::new(())).unwrap();
        open.request().unwrap();
        ClaudeChannel::open(
            open,
            &serde_json::to_vec(&json!({"id":1,"result":{
            "protocol":super::super::PROTOCOL,"identity":identity,"metadata_only":true,
            "owned_handle":"synthetic","native_session":"11111111-1111-4111-8111-111111111111"}}))
            .unwrap(),
        )
        .unwrap()
    }
    fn initialize(c: &mut ClaudeChannel) {
        let mut init = c.initialize_protocol();
        init.request().unwrap();
        init.receive(
            &serde_json::to_vec(&json!({"method":"BrokerPrepared","params":{
            "owned_handle":"synthetic","request_id":2}}))
            .unwrap(),
        )
        .unwrap();
        init.write(|bytes| Ok(bytes.len())).unwrap();
        init.receive(
            &serde_json::to_vec(&json!({"method":"BrokerOutput","params":{
            "owned_handle":"synthetic","request_id":2,"frame":{"type":"control_response",
            "response":{"subtype":"success","request_id":"initialize:2"}}}}))
            .unwrap(),
        )
        .unwrap();
        c.complete_initialization(init).unwrap();
    }
    #[test]
    fn setup_is_required_once_and_does_not_grant_authentication() {
        let mut c = channel();
        assert!(c.reserve().is_err());
        initialize(&mut c);
        let duplicate = serde_json::to_vec(&json!({"method":"BrokerOutput","params":{
            "owned_handle":"synthetic","request_id":null,"frame":{
                "type":"system","subtype":"init","session_id":c.native()}}}))
        .unwrap();
        assert!(c.receive(&duplicate).is_err());
        assert!(c.reserve().is_err());
    }
    fn output(c: &ClaudeChannel, request: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({"method":"BrokerOutput","params":{
        "owned_handle":"synthetic","request_id":request,"frame":{"type":"result","session_id":c.native(),"is_error":false,"subtype":"success","result":"synthetic"}}})).unwrap()
    }
    #[test]
    fn first_turn_requires_preparation_and_actual_write_no_continuation() {
        let mut c = channel();
        initialize(&mut c);
        let envelope = c.reserve().unwrap();
        assert!(Arc::ptr_eq(&envelope.lineage(), &c.lineage));
        assert!(c.reserve().is_err());
        assert!(c.begin_write().is_err());
        assert!(c.receive(br#"{"method":"BrokerPrepared","params":{"owned_handle":"synthetic","request_id":3}}"#).unwrap().is_none());
        c.begin_write().unwrap();
        c.finish_write().unwrap();
        let frame = c.receive(&output(&c, json!(3))).unwrap().unwrap();
        assert_eq!(frame["type"], "result");
        assert!(c.reserve().is_err());
        assert!(c.finish_write().is_err());
        let wrapped = envelope.wrap("message:1", json!({"type":"user"}));
        assert_eq!(wrapped["params"]["message_id"], "message:1");
    }
    #[test]
    fn output_before_write_or_foreign_correlation_poison_channel() {
        let mut c = channel();
        initialize(&mut c);
        c.reserve().unwrap();
        let frame = output(&c, json!(3));
        assert!(c.receive(&frame).is_err());
        assert!(c.reserve().is_err());
        let mut c = channel();
        let frame = output(&c, json!(4));
        assert!(c.receive(&frame).is_err());
    }
}
