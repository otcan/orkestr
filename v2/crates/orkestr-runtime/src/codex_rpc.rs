//! Codex 0.163 stdio protocol state, separate from process and durable authority.
//! This module never starts a process or grants permission to dispatch a turn.
use crate::ports::Blocker;
use serde_json::{json, Value};
mod turn;
pub use turn::{TurnStream, ASYNC_QUESTION_PREFIX};

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
    turn_submitted: bool,
    reported_model: Option<String>,
    /// Fast connections are read-only on every instance (see `for_role`).
    fast_read_only: bool,
}
enum Request {
    Initialize,
    Account,
    Thread {
        cwd: String,
        expected_native: Option<String>,
    },
}
impl Default for CodexRpc {
    fn default() -> Self {
        Self {
            next_id: 1,
            pending: None,
            readiness: Readiness::Uninitialized,
            native_session: None,
            turn_submitted: false,
            reported_model: None,
            fast_read_only: false,
        }
    }
}
impl CodexRpc {
    /// Fast runs in parallel with Deep on the same input, so any Fast side
    /// effect would happen twice. A Fast connection therefore always requests
    /// (and requires the provider to confirm) the read-only sandbox, even when
    /// the instance otherwise runs providers with host full access. The broker
    /// enforces the same rule independently for a Fast identity.
    pub(crate) fn for_role(role: orkestr_v2_contracts::runtime::Role) -> Self {
        Self {
            fast_read_only: role == orkestr_v2_contracts::runtime::Role::Fast,
            ..Self::default()
        }
    }

    /// A read-only parallel Deep connection (docs/v2/parallel-deep.md): the
    /// same read-only sandbox, network off, as Fast on every instance. The
    /// broker independently forces it for every identity it serves on the
    /// read-only (Fast) service profile.
    pub(crate) fn read_only() -> Self {
        Self {
            fast_read_only: true,
            ..Self::default()
        }
    }

    /// The sandbox this connection requests and requires.
    pub(crate) fn access(&self) -> crate::provider_access::ProviderAccess {
        connection_access(self.fast_read_only, crate::provider_access::current())
    }

    // One consumed turn per connection in this slice. Any enqueue/transport
    // failure leaves it latched; reconnect never restores the consumed grant.
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
        self.create_session_with_model(cwd, None)
    }

    /// As `create_session`, optionally naming the thread's model. The native
    /// start reply reports the resolved model; that, not this request, is the
    /// model evidence.
    pub fn create_session_with_model(
        &mut self,
        cwd: &std::path::Path,
        model: Option<&str>,
    ) -> Result<Value, Blocker> {
        if model.is_some_and(|m| !orkestr_v2_contracts::launch_model_valid(m)) {
            return Err(Blocker::Protocol);
        }
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
        let mut params = json!({
            "cwd":cwd,"approvalPolicy":"never",
            "sandbox":self.access().request(),
            "ephemeral":false,"modelProvider":"openai"
        });
        if let Some(model) = model {
            params["model"] = json!(model);
        }
        self.request(
            Request::Thread {
                cwd: cwd.to_owned(),
                expected_native: None,
            },
            "thread/start",
            params,
        )
    }

    /// Resume only the durable identity selected by trusted setup. A refusal
    /// leaves the request pending for quarantine; never fall back to creation.
    pub(crate) fn resume_session(
        &mut self,
        cwd: &std::path::Path,
        native: &str,
    ) -> Result<Value, Blocker> {
        if native.is_empty() || native.len() > 512 || native.chars().any(char::is_control) {
            return Err(Blocker::Protocol);
        }
        // Reuse the exact trusted workspace/readiness checks without issuing a
        // start request: this temporary value cannot reach the transport.
        let mut frame = self.create_session(cwd)?;
        let (_, request) = self.pending.as_mut().ok_or(Blocker::Protocol)?;
        if let Request::Thread {
            expected_native, ..
        } = request
        {
            *expected_native = Some(native.to_owned());
        }
        frame["method"] = json!("thread/resume");
        frame["params"]
            .as_object_mut()
            .ok_or(Blocker::Protocol)?
            .remove("ephemeral");
        frame["params"]["threadId"] = json!(native);
        // Setup needs identity and live state only. Core already owns history;
        // hydrating native turns can exceed the bounded metadata channel.
        frame["params"]["excludeTurns"] = json!(true);
        Ok(frame)
    }

    /// Server-only locator for Core native readiness confirmation. Not dispatch
    /// permission and never a web DTO. Each role requires its own connection.
    pub fn native_session(&self) -> Option<&str> {
        self.native_session.as_deref()
    }

    pub(crate) fn reported_model(&self) -> Option<&str> {
        self.reported_model.as_deref()
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
        let access = self.access();
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
            Request::Thread {
                cwd,
                expected_native,
            } => {
                let native = result
                    .pointer("/thread/id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty() && s.len() <= 512)
                    .ok_or(Blocker::Protocol)?;
                if expected_native
                    .as_deref()
                    .is_some_and(|expected| native != expected)
                    || result.get("modelProvider").and_then(Value::as_str) != Some("openai")
                    || result
                        .pointer("/thread/modelProvider")
                        .and_then(Value::as_str)
                        != Some("openai")
                    || result.pointer("/thread/ephemeral").and_then(Value::as_bool) != Some(false)
                    || result.get("cwd").and_then(Value::as_str) != Some(cwd.as_str())
                    || result.pointer("/thread/cwd").and_then(Value::as_str) != Some(cwd.as_str())
                    || result.get("approvalPolicy").and_then(Value::as_str) != Some("never")
                    || !sandbox_reply(result, access)
                {
                    return Err(Blocker::Protocol);
                }
                self.native_session = Some(native.to_owned());
                self.reported_model = result
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|v| orkestr_v2_contracts::valid_observed_model(v))
                    .map(str::to_owned);
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

/// A Fast connection is read-only whatever the instance selection is.
fn connection_access(
    fast_read_only: bool,
    instance: crate::provider_access::ProviderAccess,
) -> crate::provider_access::ProviderAccess {
    if fast_read_only {
        crate::provider_access::ProviderAccess::ReadOnly
    } else {
        instance
    }
}

/// The provider must report exactly the selected sandbox. Read-only must
/// also keep network off; full access is unrestricted by definition.
fn sandbox_reply(result: &Value, access: crate::provider_access::ProviderAccess) -> bool {
    result.pointer("/sandbox/type").and_then(Value::as_str) == Some(access.reply())
        && (access == crate::provider_access::ProviderAccess::HostFullAccess
            || matches!(
                result.pointer("/sandbox/networkAccess"),
                None | Some(Value::Bool(false))
            ))
}

#[cfg(test)]
mod access_tests {
    use super::*;
    use crate::provider_access::ProviderAccess;
    #[test]
    fn each_mode_accepts_only_its_own_sandbox_reply() {
        let read = json!({"sandbox":{"type":"readOnly","networkAccess":false}});
        let full = json!({"sandbox":{"type":"dangerFullAccess"}});
        let networked = json!({"sandbox":{"type":"readOnly","networkAccess":true}});
        assert!(sandbox_reply(&read, ProviderAccess::ReadOnly));
        assert!(!sandbox_reply(&full, ProviderAccess::ReadOnly));
        assert!(!sandbox_reply(&networked, ProviderAccess::ReadOnly));
        assert!(sandbox_reply(&full, ProviderAccess::HostFullAccess));
        assert!(!sandbox_reply(&read, ProviderAccess::HostFullAccess));
        assert_eq!(ProviderAccess::ReadOnly.request(), "read-only");
        assert_eq!(
            ProviderAccess::HostFullAccess.request(),
            "danger-full-access"
        );
        assert_eq!(crate::provider_access::current(), ProviderAccess::ReadOnly);
    }

    #[test]
    fn fast_connection_is_read_only_even_with_host_full_access() {
        use orkestr_v2_contracts::runtime::Role;
        // Host full access widens Deep and Workers only, never Fast.
        assert_eq!(
            connection_access(true, ProviderAccess::HostFullAccess),
            ProviderAccess::ReadOnly
        );
        assert_eq!(
            connection_access(false, ProviderAccess::HostFullAccess),
            ProviderAccess::HostFullAccess
        );
        assert_eq!(
            connection_access(true, ProviderAccess::ReadOnly),
            ProviderAccess::ReadOnly
        );
        assert!(CodexRpc::for_role(Role::Fast).fast_read_only);
        assert!(CodexRpc::read_only().fast_read_only);
        assert!(!CodexRpc::for_role(Role::Deep).fast_read_only);
        assert!(!CodexRpc::for_role(Role::Worker).fast_read_only);
        // A Fast thread requests read-only and refuses a full-access reply.
        let mut rpc = CodexRpc::for_role(Role::Fast);
        rpc.initialize().unwrap();
        rpc.receive(&json!({"id":1,"result":{"userAgent":"synthetic","platformFamily":"unix","platformOs":"linux","codexHome":"/synthetic"}}).to_string()).unwrap();
        rpc.account_read().unwrap();
        rpc.receive(
            &json!({"id":2,"result":{"requiresOpenaiAuth":true,"account":{"type":"chatgpt"}}})
                .to_string(),
        )
        .unwrap();
        let frame = rpc
            .create_session(std::path::Path::new("/synthetic"))
            .unwrap();
        assert_eq!(frame["params"]["sandbox"], "read-only");
        let full = json!({"id":3,"result":{"thread":{"id":"synthetic-native","cwd":"/synthetic","ephemeral":false,"modelProvider":"openai"},"cwd":"/synthetic","modelProvider":"openai","approvalPolicy":"never","sandbox":{"type":"dangerFullAccess"}}});
        assert_eq!(rpc.receive(&full.to_string()), Err(Blocker::Protocol));
        assert_eq!(rpc.native_session(), None);
    }
}

#[cfg(test)]
mod resume_tests {
    use super::*;
    fn ready() -> CodexRpc {
        let mut rpc = CodexRpc::default();
        rpc.initialize().unwrap();
        rpc.receive(&json!({"id":1,"result":{"userAgent":"synthetic","platformFamily":"unix","platformOs":"linux","codexHome":"/synthetic"}}).to_string()).unwrap();
        rpc.account_read().unwrap();
        rpc.receive(
            &json!({"id":2,"result":{"requiresOpenaiAuth":true,"account":{"type":"chatgpt"}}})
                .to_string(),
        )
        .unwrap();
        rpc
    }
    fn response() -> Value {
        json!({"id":3,"result":{"thread":{"id":"synthetic-native","cwd":"/synthetic","ephemeral":false,"modelProvider":"openai"},"cwd":"/synthetic","modelProvider":"openai","approvalPolicy":"never","sandbox":{"type":"readOnly","networkAccess":false}}})
    }
    #[test]
    fn exact_resume_and_no_creation_fallback() {
        let mut rpc = ready();
        let frame = rpc
            .resume_session(std::path::Path::new("/synthetic"), "synthetic-native")
            .unwrap();
        assert_eq!(frame["method"], "thread/resume");
        assert_eq!(frame["params"]["threadId"], "synthetic-native");
        assert_eq!(frame["params"].as_object().unwrap().len(), 6);
        assert_eq!(frame["params"]["excludeTurns"], true);
        assert!(frame["params"].get("ephemeral").is_none());
        rpc.receive(&response().to_string()).unwrap();
        assert_eq!(rpc.native_session(), Some("synthetic-native"));
    }
    #[test]
    fn changed_or_missing_resume_evidence_stays_quarantined() {
        for pointer in [
            "/result/thread/id",
            "/result/thread/cwd",
            "/result/cwd",
            "/result/thread/modelProvider",
            "/result/modelProvider",
            "/result/thread/ephemeral",
            "/result/approvalPolicy",
            "/result/sandbox/type",
            "/result/sandbox/networkAccess",
        ] {
            let mut rpc = ready();
            rpc.resume_session(std::path::Path::new("/synthetic"), "synthetic-native")
                .unwrap();
            let mut reply = response();
            *reply.pointer_mut(pointer).unwrap() = Value::Null;
            assert_eq!(rpc.receive(&reply.to_string()), Err(Blocker::Protocol));
            assert_eq!(rpc.native_session(), None);
            assert_eq!(
                rpc.create_session(std::path::Path::new("/synthetic")),
                Err(Blocker::Busy)
            );
        }
    }
}
