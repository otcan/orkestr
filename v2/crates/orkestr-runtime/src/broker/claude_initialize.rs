//! Protocol initialization only. No native identity, account or dispatch proof.
use super::{channel::BrokerMetadataRequest, Blocker, Value};
use std::sync::Arc;

pub(crate) fn frame() -> Value {
    serde_json::json!({"type":"control_request","request_id":"initialize:2",
        "request":{"subtype":"initialize","hooks":null}})
}

pub(crate) struct ClaudeInitialize {
    handle: String,
    lineage: Arc<()>,
    queued: bool,
    prepared: bool,
    offset: usize,
    bytes: Vec<u8>,
    finished: bool,
    poisoned: bool,
}
impl ClaudeInitialize {
    pub(super) fn new(handle: String, lineage: Arc<()>) -> Self {
        let mut bytes = frame().to_string().into_bytes();
        bytes.push(b'\n');
        Self {
            handle,
            lineage,
            queued: false,
            prepared: false,
            offset: 0,
            bytes,
            finished: false,
            poisoned: false,
        }
    }
    pub(crate) fn request(&mut self) -> Result<BrokerMetadataRequest, Blocker> {
        if self.queued || self.poisoned {
            return Err(Blocker::Protocol);
        }
        self.queued = true;
        let bytes = serde_json::json!({"id":2,"method":"BrokerMetadata","params":{
            "owned_handle":self.handle,"frame":frame()}})
        .to_string()
        .into_bytes();
        Ok(BrokerMetadataRequest::sealed(self.lineage.clone(), bytes))
    }
    pub(crate) fn write(
        &mut self,
        action: impl FnOnce(&[u8]) -> Result<usize, crate::containment::Error>,
    ) -> Result<bool, Blocker> {
        if self.poisoned || !self.prepared || self.finished || self.offset == self.bytes.len() {
            return Err(Blocker::Protocol);
        }
        // MetadataChild performs the real Core metadata fence around each suffix.
        let count = match action(&self.bytes[self.offset..]) {
            Ok(n) if n <= self.bytes.len() - self.offset => n,
            _ => {
                self.poisoned = true;
                return Err(Blocker::Protocol);
            }
        };
        self.offset += count;
        Ok(self.offset == self.bytes.len())
    }
    pub(crate) fn receive(&mut self, bytes: &[u8]) -> Result<bool, Blocker> {
        let result = self.decode(bytes);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }
    fn decode(&mut self, bytes: &[u8]) -> Result<bool, Blocker> {
        if self.poisoned || !self.queued || self.finished || bytes.len() > 16384 {
            return Err(Blocker::Protocol);
        }
        let value: Value = serde_json::from_slice(bytes).map_err(|_| Blocker::Protocol)?;
        let prepared = serde_json::json!({"method":"BrokerPrepared","params":{
            "owned_handle":self.handle,"request_id":2}});
        if value == prepared && !self.prepared && self.offset == 0 {
            self.prepared = true;
            return Ok(false);
        }
        let success = serde_json::json!({"method":"BrokerOutput","params":{
            "owned_handle":self.handle,"request_id":2,"frame":{
                "type":"control_response","response":{"subtype":"success","request_id":"initialize:2"}}}});
        if !self.prepared || self.offset != self.bytes.len() || value != success {
            return Err(Blocker::Protocol);
        }
        self.finished = true;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> ClaudeInitialize {
        let mut state = ClaudeInitialize::new("synthetic".into(), Arc::new(()));
        state.request().unwrap();
        state
    }
    fn prepared() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"method":"BrokerPrepared","params":{
            "owned_handle":"synthetic","request_id":2}}))
        .unwrap()
    }
    fn ack() -> Value {
        serde_json::json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic","request_id":2,
            "frame":{"type":"control_response","response":{"subtype":"success","request_id":"initialize:2"}}}})
    }
    #[test]
    fn metadata_ack_requires_prepared_and_complete_actual_write() {
        let mut state = setup();
        assert!(state.write(|_| Ok(0)).is_err());
        assert!(!state.receive(&prepared()).unwrap());
        let mut actual = Vec::new();
        assert!(!state
            .write(|b| {
                actual.extend_from_slice(&b[..3]);
                Ok(3)
            })
            .unwrap());
        assert!(state
            .write(|b| {
                actual.extend_from_slice(b);
                Ok(b.len())
            })
            .unwrap());
        assert_eq!(serde_json::from_slice::<Value>(&actual).unwrap(), frame());
        assert!(state.receive(&serde_json::to_vec(&ack()).unwrap()).unwrap());
        assert!(state.receive(&serde_json::to_vec(&ack()).unwrap()).is_err());
    }
    #[test]
    fn early_foreign_or_unsanitized_ack_poison_permanently() {
        for mutation in 0..4 {
            let mut state = setup();
            state.receive(&prepared()).unwrap();
            if mutation != 0 {
                state.write(|b| Ok(b.len())).unwrap();
            }
            let mut bad = ack();
            match mutation {
                1 => bad["params"]["frame"]["response"]["request_id"] = "foreign".into(),
                2 => bad["params"]["frame"]["response"]["account"] = serde_json::json!({}),
                3 => bad["params"]["owned_handle"] = "foreign".into(),
                _ => {}
            }
            assert!(state.receive(&serde_json::to_vec(&bad).unwrap()).is_err());
            assert!(state.receive(&serde_json::to_vec(&ack()).unwrap()).is_err());
        }
    }
}
