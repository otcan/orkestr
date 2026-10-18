//! Correlated framing only. These bytes never confer dispatch authority.
use super::*;

/// Private owned-pipe framing state; a handle is not an execution capability.
pub(crate) struct BrokerChannel {
    handle: String,
    lineage: Option<std::sync::Arc<()>>,
    next: u64,
    pending: Option<(u64, Option<u64>)>,
    poisoned: bool,
}
impl OwnedMetadataHandle {
    pub(crate) fn into_channel(self) -> BrokerChannel {
        BrokerChannel {
            handle: self._handle,
            lineage: self.lineage,
            next: 2,
            pending: None,
            poisoned: false,
        }
    }
}
impl BrokerChannel {
    /// Only setup frames produced by the trusted protocol state machine.
    /// Containment separately validates metadata authority before submission.
    pub(crate) fn metadata(&mut self, frame: Value) -> Result<BrokerMetadataRequest, Blocker> {
        let method = frame
            .get("method")
            .and_then(Value::as_str)
            .ok_or(Blocker::Protocol)?;
        if !matches!(
            method,
            "initialize" | "initialized" | "account/read" | "thread/start"
        ) {
            self.poisoned = true;
            return Err(Blocker::Protocol);
        }
        let lineage = self.lineage.clone().ok_or(Blocker::Protocol)?;
        Ok(BrokerMetadataRequest {
            lineage,
            bytes: self.wrap("BrokerMetadata", frame)?,
        })
    }
    fn wrap(&mut self, method: &str, frame: Value) -> Result<Vec<u8>, Blocker> {
        if self.poisoned || self.pending.is_some() || self.next >= (1_u64 << 53) {
            return Err(Blocker::Protocol);
        }
        let id = self.next;
        let inner = frame.get("id").and_then(Value::as_u64);
        let bytes =
            json!({"id":id,"method":method,"params":{"owned_handle":self.handle,"frame":frame}})
                .to_string()
                .into_bytes();
        if bytes.len() > 65536 {
            self.poisoned = true;
            return Err(Blocker::Protocol);
        }
        self.next += 1;
        self.pending = Some((id, inner));
        Ok(bytes)
    }
    /// Unwrap only the current owned pipe's correlated reply/notification.
    /// Protocol/readiness/turn validation remains the provider parser's job.
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
        let object = value.as_object().ok_or(Blocker::Protocol)?;
        if object.len() != 2 {
            return Err(Blocker::Protocol);
        }
        if value.get("method").and_then(Value::as_str) == Some("BrokerOutput") {
            let params = value["params"].as_object().ok_or(Blocker::Protocol)?;
            if params.len() != 2
                || params.get("owned_handle").and_then(Value::as_str) != Some(&self.handle)
            {
                return Err(Blocker::Protocol);
            }
            let frame = params
                .get("frame")
                .filter(|v| v.is_object())
                .ok_or(Blocker::Protocol)?;
            if frame.get("id").is_some() {
                return Err(Blocker::Protocol);
            }
            return Ok(Some(frame.clone()));
        }
        let (outer, inner) = self.pending.ok_or(Blocker::Protocol)?;
        if value.get("id").and_then(Value::as_u64) != Some(outer) {
            return Err(Blocker::Protocol);
        }
        let result = value["result"].as_object().ok_or(Blocker::Protocol)?;
        if result.len() != 2
            || result.get("owned_handle").and_then(Value::as_str) != Some(&self.handle)
        {
            return Err(Blocker::Protocol);
        }
        let frame = result.get("frame").ok_or(Blocker::Protocol)?;
        match inner {
            None if frame.is_null() => {}
            Some(id)
                if frame.is_object() && frame.get("id").and_then(Value::as_u64) == Some(id) => {}
            _ => return Err(Blocker::Protocol),
        }
        self.pending = None;
        Ok((!frame.is_null()).then(|| frame.clone()))
    }
}

/// Sealed setup submission, bound to one actual owned child; never inference.
pub(crate) struct BrokerMetadataRequest {
    lineage: std::sync::Arc<()>,
    bytes: Vec<u8>,
}
impl BrokerMetadataRequest {
    pub(crate) fn into_submission(self) -> (std::sync::Arc<()>, Vec<u8>) {
        (self.lineage, self.bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn channel() -> BrokerChannel {
        OwnedMetadataHandle {
            _handle: "synthetic_owned".into(),
            lineage: Some(std::sync::Arc::new(())),
        }
        .into_channel()
    }
    #[test]
    fn correlated_setup_and_initialized_null_reply() {
        let mut c = channel();
        let request: Value = serde_json::from_slice(
            &c.metadata(json!({"id":7,"method":"initialize","params":{}}))
                .unwrap()
                .into_submission()
                .1,
        )
        .unwrap();
        assert_eq!(request["id"], 2);
        let response = json!({"id":2,"result":{"owned_handle":"synthetic_owned","frame":{"id":7,"result":{}}}});
        assert_eq!(
            c.receive(response.to_string().as_bytes()).unwrap().unwrap()["id"],
            7
        );
        c.metadata(json!({"method":"initialized"})).unwrap();
        assert_eq!(
            c.receive(
                json!({"id":3,"result":{"owned_handle":"synthetic_owned","frame":null}})
                    .to_string()
                    .as_bytes()
            )
            .unwrap(),
            None
        );
    }
    #[test]
    fn foreign_handle_and_wrong_inner_correlation_poison() {
        for (handle, id) in [("foreign", 7), ("synthetic_owned", 8)] {
            let mut c = channel();
            c.metadata(json!({"id":7,"method":"initialize"})).unwrap();
            assert!(c
                .receive(
                    json!({"id":2,"result":{"owned_handle":handle,"frame":{"id":id,"result":{}}}})
                        .to_string()
                        .as_bytes()
                )
                .is_err());
            assert!(c.metadata(json!({"method":"initialized"})).is_err());
        }
    }
    #[test]
    fn metadata_never_serializes_turn_and_unrelated_output_refused() {
        let mut c = channel();
        assert!(c.metadata(json!({"id":4,"method":"turn/start"})).is_err());
        let mut c = channel();
        assert!(c.receive(json!({"method":"BrokerOutput","params":{"owned_handle":"foreign","frame":{"method":"turn/started"}}}).to_string().as_bytes()).is_err());
    }
}
