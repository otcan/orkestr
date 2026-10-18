//! Proposed owned-session broker metadata protocol, not an available broker.
//! No inference frames, credentials, environment or executable selection here.
use crate::ports::Blocker;
use orkestr_v2_application::runtime::ProviderKind;
use orkestr_v2_store_sqlite::BoundSessionMetadata;
use serde_json::{json, Value};

pub const PROTOCOL: &str = "orkestr-v2-provider-broker-v1";

/// One correlated metadata open, derived only from an issuer-created grant.
/// Construction does not refresh the grant; transport must hold metadata fence.
/// No Debug/Clone or public handle accessor: this is never execution authority.
pub struct BrokerOpen {
    identity: Value,
    submitted: bool,
    finished: bool,
    poisoned: bool,
}
impl BrokerOpen {
    pub fn from_metadata(grant: &BoundSessionMetadata) -> Result<Self, Blocker> {
        let provider = match grant.provider() {
            ProviderKind::Codex => "codex",
            ProviderKind::Claude => "claude",
            _ => return Err(Blocker::Unsupported),
        };
        let binding = grant.binding();
        Ok(Self::new(json!({
            "provider": provider,
            "role": binding.role,
            "owner_id": binding.owner_id,
            "session_id": binding.session_id,
            "namespace": grant.namespace(),
            "incarnation": grant.incarnation_id(),
        })))
    }
    fn new(identity: Value) -> Self {
        Self {
            identity,
            submitted: false,
            finished: false,
            poisoned: false,
        }
    }
    /// Wire metadata only. The returned bytes are not admitted to containment's
    /// setup whitelist yet: that integration needs a separately reviewed hook.
    pub fn request(&mut self) -> Result<Vec<u8>, Blocker> {
        if self.submitted || self.poisoned || self.finished {
            return Err(Blocker::Protocol);
        }
        self.submitted = true;
        Ok(json!({"id":1,"method":"OpenOwnedSession","params":{
            "protocol":PROTOCOL,"identity":self.identity,
        }})
        .to_string()
        .into_bytes())
    }
    /// Validates only metadata ownership/correlation. Does not confirm provider
    /// readiness, create a turn or yield a reusable inference locator.
    pub fn receive(&mut self, line: &[u8]) -> Result<OwnedMetadataHandle, Blocker> {
        if self.poisoned || !self.submitted || self.finished {
            self.poisoned = true;
            return Err(Blocker::Protocol);
        }
        let result = self.decode(line);
        if result.is_err() {
            self.poisoned = true;
        }
        if result.is_ok() {
            self.finished = true;
        }
        result
    }
    fn decode(&self, line: &[u8]) -> Result<OwnedMetadataHandle, Blocker> {
        if line.len() > 16 * 1024 {
            return Err(Blocker::Protocol);
        }
        let reply: Value = serde_json::from_slice(line).map_err(|_| Blocker::Protocol)?;
        let fields = reply.as_object().ok_or(Blocker::Protocol)?;
        if fields.len() != 2 || reply.get("id").and_then(Value::as_u64) != Some(1) {
            return Err(Blocker::Protocol);
        }
        let result = reply
            .get("result")
            .and_then(Value::as_object)
            .ok_or(Blocker::Protocol)?;
        if result.len() != 4
            || result.get("protocol").and_then(Value::as_str) != Some(PROTOCOL)
            || result.get("identity") != Some(&self.identity)
            || result.get("metadata_only").and_then(Value::as_bool) != Some(true)
        {
            return Err(Blocker::Protocol);
        }
        let handle = result
            .get("owned_handle")
            .and_then(Value::as_str)
            .ok_or(Blocker::Protocol)?;
        if handle.is_empty()
            || handle.len() > 256
            || !handle
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(Blocker::Protocol);
        }
        Ok(OwnedMetadataHandle {
            _handle: handle.into(),
        })
    }
}

/// Opaque metadata-only result. No serialization, cloning or inference methods.
pub struct OwnedMetadataHandle {
    _handle: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn client() -> BrokerOpen {
        BrokerOpen::new(
            json!({"provider":"codex","role":"deep","owner_id":"synthetic-owner","session_id":"synthetic-session","namespace":"synthetic","incarnation":"synthetic-boot"}),
        )
    }
    fn reply(client: &BrokerOpen) -> Value {
        json!({"id":1,"result":{"protocol":PROTOCOL,"identity":client.identity,"metadata_only":true,"owned_handle":"synthetic_owned_1"}})
    }
    #[test]
    fn correlated_metadata_open_is_once_only_and_not_inference() {
        let mut client = client();
        let request: Value = serde_json::from_slice(&client.request().unwrap()).unwrap();
        assert_eq!(request["method"], "OpenOwnedSession");
        assert!(client.request().is_err());
        let response = reply(&client).to_string();
        client.receive(response.as_bytes()).unwrap();
        assert!(client.receive(response.as_bytes()).is_err());
    }
    #[test]
    fn foreign_identity_credentials_unknown_fields_and_inference_refused() {
        for path in [
            "provider",
            "role",
            "owner_id",
            "session_id",
            "namespace",
            "incarnation",
        ] {
            let mut client = client();
            client.request().unwrap();
            let mut response = reply(&client);
            response["result"]["identity"][path] = json!("foreign");
            assert!(client.receive(response.to_string().as_bytes()).is_err());
            assert!(client
                .receive(reply(&client).to_string().as_bytes())
                .is_err());
        }
        for change in [
            json!({"token":"forbidden"}),
            json!({"metadata_only":false}),
            json!({"owned_handle":"/private/path"}),
            json!({"protocol":"other"}),
            json!({"owned_handle":""}),
        ] {
            let mut client = client();
            client.request().unwrap();
            let mut response = reply(&client);
            response["result"]
                .as_object_mut()
                .unwrap()
                .extend(change.as_object().unwrap().clone());
            assert!(client.receive(response.to_string().as_bytes()).is_err());
        }
    }
    #[test]
    fn unsolicited_malformed_wrong_correlation_and_oversize_poison() {
        let mut unopened = client();
        assert!(unopened.receive(b"{}").is_err());
        for bytes in [
            b"not-json".to_vec(),
            json!({"id":2,"result":{}}).to_string().into_bytes(),
            json!({"id":1,"method":"turn/start"})
                .to_string()
                .into_bytes(),
            vec![b' '; 16385],
        ] {
            let mut client = client();
            client.request().unwrap();
            assert!(client.receive(&bytes).is_err());
            assert!(client
                .receive(reply(&client).to_string().as_bytes())
                .is_err());
        }
    }
}
