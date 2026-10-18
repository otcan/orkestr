//! Codex 0.163 stdio protocol state, separate from process and durable authority.
//! This module never starts a process or grants permission to dispatch a turn.
use crate::ports::Blocker;
use serde_json::{json, Value};
mod turn;
pub use turn::TurnStream;

const MAX_FRAME: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Readiness {
    Uninitialized,
    Initialized,
    Subscription,
}

/// One connection has one outstanding metadata request. Reconnect starts over.
/// Native identifiers and account contents are deliberately absent from Debug.
pub struct CodexRpc {
    next_id: u64,
    pending: Option<(u64, Request)>,
    readiness: Readiness,
    native_session: Option<String>,
    #[cfg(test)]
    turn_submitted: bool,
}
enum Request {
    Initialize,
    Account,
    Thread { cwd: String },
}
impl Default for CodexRpc {
    fn default() -> Self {
        Self {
            next_id: 1,
            pending: None,
            readiness: Readiness::Uninitialized,
            native_session: None,
            #[cfg(test)]
            turn_submitted: false,
        }
    }
}
impl CodexRpc {
    // One consumed turn per connection in this slice. Any enqueue/transport
    // failure leaves it latched; reconnect never restores the consumed grant.
    #[cfg(test)]
    pub(crate) fn claim_turn_request(&mut self, native: &str) -> Result<u64, Blocker> {
        if self.readiness != Readiness::Subscription
            || self.native_session() != Some(native)
            || self.pending.is_some()
            || self.turn_submitted
        {
            return Err(Blocker::Protocol);
        }
        let id = self.next_id;
        self.next_id = id.checked_add(1).ok_or(Blocker::Protocol)?;
        self.turn_submitted = true;
        Ok(id)
    }
    pub fn readiness(&self) -> Readiness {
        self.readiness
    }

    pub fn initialize(&mut self) -> Result<Value, Blocker> {
        if self.readiness != Readiness::Uninitialized {
            return Err(Blocker::Protocol);
        }
        self.request(
            Request::Initialize,
            "initialize",
            json!({
                "clientInfo":{"name":"orkestr_v2","title":"Orkestr","version":"0.1.0"},
                "capabilities":{"experimentalApi":false}
            }),
        )
    }

    /// Read-only status: never refresh credentials or initiate login.
    pub fn account_read(&mut self) -> Result<Value, Blocker> {
        if self.readiness != Readiness::Initialized {
            return Err(Blocker::Protocol);
        }
        self.request(
            Request::Account,
            "account/read",
            json!({"refreshToken":false}),
        )
    }

    /// Creates a distinct persistent native session without starting inference.
    /// Cwd must come from trusted containment configuration, never a web field.
    pub fn create_session(&mut self, cwd: &std::path::Path) -> Result<Value, Blocker> {
        if self.readiness != Readiness::Subscription || self.native_session.is_some() {
            return Err(Blocker::Protocol);
        }
        if !cwd.is_absolute() {
            return Err(Blocker::Protocol);
        }
        let normalized: std::path::PathBuf = cwd.components().collect();
        if normalized.as_os_str() != cwd.as_os_str()
            || cwd.components().any(|part| {
                matches!(
                    part,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err(Blocker::Protocol);
        }
        let cwd = cwd.to_str().ok_or(Blocker::Protocol)?;
        self.request(
            Request::Thread {
                cwd: cwd.to_owned(),
            },
            "thread/start",
            json!({
                "cwd":cwd,"approvalPolicy":"never","sandbox":"read-only",
                "ephemeral":false,"modelProvider":"openai"
            }),
        )
    }

    /// Server-only locator for Core native readiness confirmation. Not dispatch
    /// permission and never a web DTO. Each role requires its own connection.
    pub fn native_session(&self) -> Option<&str> {
        self.native_session.as_deref()
    }

    fn request(&mut self, kind: Request, method: &str, params: Value) -> Result<Value, Blocker> {
        if self.pending.is_some() {
            return Err(Blocker::Busy);
        }
        let id = self.next_id;
        self.next_id = id.checked_add(1).ok_or(Blocker::Protocol)?;
        self.pending = Some((id, kind));
        Ok(json!({"id":id,"method":method,"params":params}))
    }

    /// Returns the initialized notification only after a matching successful reply.
    /// Unrelated notifications do not consume the pending request. Invalid replies
    /// retain it for explicit connection quarantine; no automatic request replay.
    pub fn receive(&mut self, line: &str) -> Result<Option<Value>, Blocker> {
        if line.len() > MAX_FRAME {
            return Err(Blocker::Protocol);
        }
        let value: Value = serde_json::from_str(line).map_err(|_| Blocker::Protocol)?;
        if value.get("id").is_none() {
            return if value.get("method").and_then(Value::as_str).is_some() {
                Ok(None)
            } else {
                Err(Blocker::Protocol)
            };
        }
        let (id, kind) = self.pending.as_ref().ok_or(Blocker::Protocol)?;
        if value.get("id").and_then(Value::as_u64) != Some(*id) || value.get("error").is_some() {
            return Err(Blocker::Protocol);
        }
        let result = value.get("result").ok_or(Blocker::Protocol)?;
        let notification = match kind {
            Request::Initialize => {
                for key in ["userAgent", "platformFamily", "platformOs", "codexHome"] {
                    if !result
                        .get(key)
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
                    {
                        return Err(Blocker::Protocol);
                    }
                }
                self.readiness = Readiness::Initialized;
                Some(json!({"method":"initialized"}))
            }
            Request::Thread { cwd } => {
                let native = result
                    .pointer("/thread/id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty() && s.len() <= 512)
                    .ok_or(Blocker::Protocol)?;
                if result.get("modelProvider").and_then(Value::as_str) != Some("openai")
                    || result
                        .pointer("/thread/modelProvider")
                        .and_then(Value::as_str)
                        != Some("openai")
                    || result.pointer("/thread/ephemeral").and_then(Value::as_bool) != Some(false)
                    || result.get("cwd").and_then(Value::as_str) != Some(cwd.as_str())
                    || result.pointer("/thread/cwd").and_then(Value::as_str) != Some(cwd.as_str())
                    || result.get("approvalPolicy").and_then(Value::as_str) != Some("never")
                    || result.pointer("/sandbox/type").and_then(Value::as_str) != Some("readOnly")
                    || !matches!(
                        result.pointer("/sandbox/networkAccess"),
                        None | Some(Value::Bool(false))
                    )
                {
                    return Err(Blocker::Protocol);
                }
                self.native_session = Some(native.to_owned());
                None
            }
            Request::Account => {
                // API-key/Bedrock/unknown accounts cannot silently purchase compute.
                if result.get("requiresOpenaiAuth").and_then(Value::as_bool) != Some(true)
                    || result.pointer("/account/type").and_then(Value::as_str) != Some("chatgpt")
                {
                    return Err(Blocker::Unsupported);
                }
                self.readiness = Readiness::Subscription;
                None
            }
        };
        self.pending = None;
        Ok(notification)
    }
}
