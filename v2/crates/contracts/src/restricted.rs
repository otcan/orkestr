//! Restricted threads: a conversation whose model (a self-hosted OpenAI-compatible
//! endpoint) has no shell, files, credentials or network of its own. It can only
//! emit structured action requests; the Orkestr broker decides each one against
//! this per-thread policy. These DTOs are owner preferences and audit evidence;
//! none of them is a grant a model-controlled string can mint.
use crate::ConversationId;
use serde::{Deserialize, Serialize};

pub const RESTRICTED_SCHEMA_VERSION: u32 = 1;
/// The provider kind this feature adds ("openai-compatible restricted").
pub const RESTRICTED_PROVIDER_KIND: &str = "openai_compatible_restricted";
pub const RESTRICTED_PATH_MAX: usize = 4096;
pub const RESTRICTED_NAME_MAX: usize = 64;
pub const RESTRICTED_HOSTS_MAX: usize = 64;

/// Per-thread broker policy. Everything not listed here is decided by the fixed
/// rules in the broker (credentials, sudo/host commands, other threads' data and
/// deletes are always denied; sending, writing outside the workspace, spending
/// and starting the GPU always ask the owner).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestrictedPolicy {
    /// Absolute directory that is this thread's own workspace.
    pub workspace: String,
    /// Name of a server-configured endpoint. Never a URL and never a secret.
    pub endpoint: String,
    /// Model name sent to the endpoint; `None` uses the endpoint's default.
    #[serde(default)]
    pub model: Option<String>,
    /// `web_search` and `fetch_url` are auto-allowed when set, denied otherwise.
    #[serde(default)]
    pub web_enabled: bool,
    /// Optional fetch allowlist (exact host or `*.suffix`). Empty allows any public host.
    #[serde(default)]
    pub fetch_hosts: Vec<String>,
    /// `run_sandboxed` is denied unless set.
    #[serde(default)]
    pub sandbox_enabled: bool,
    /// Mount the workspace read-write into the sandbox (default: read-only).
    #[serde(default)]
    pub sandbox_workspace_writable: bool,
    /// The owner's standing grant of network access to sandbox runs. Without it a
    /// run that asks for network access needs a per-request approval.
    #[serde(default)]
    pub sandbox_network_granted: bool,
    #[serde(default = "default_image")]
    pub sandbox_image: String,
    #[serde(default = "default_cpus")]
    pub sandbox_cpus: u32,
    #[serde(default = "default_memory")]
    pub sandbox_memory_mb: u32,
    #[serde(default = "default_timeout")]
    pub sandbox_timeout_secs: u32,
    /// `send_message` may be requested (always asks). Off: denied outright.
    #[serde(default)]
    pub messaging_enabled: bool,
    /// `start_gpu` may be requested (always asks, never session-scoped). Off: denied.
    #[serde(default)]
    pub gpu_enabled: bool,
    /// Model round trips per owner message.
    #[serde(default = "default_steps")]
    pub max_steps: u32,
}
fn default_image() -> String {
    "python:3.12-slim".into()
}
fn default_cpus() -> u32 {
    1
}
fn default_memory() -> u32 {
    256
}
fn default_timeout() -> u32 {
    30
}
fn default_steps() -> u32 {
    12
}
/// Characters allowed in names that reach a command line (image, endpoint, model).
pub fn restricted_name_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with(['-', '.', '/'])
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-@".contains(&b))
        && !value.contains("..")
}
/// A workspace path that is safe to place in a container mount specification.
pub fn restricted_workspace_valid(value: &str) -> bool {
    value.starts_with('/')
        && value.len() <= RESTRICTED_PATH_MAX
        && value.len() > 1
        && !value.split('/').any(|part| part == "..")
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, ',' | ':' | '"' | '\'' | '\\' | '=' | ' '))
}
impl RestrictedPolicy {
    pub fn is_valid(&self) -> bool {
        restricted_workspace_valid(&self.workspace)
            && restricted_name_valid(&self.endpoint)
            && self.model.as_deref().is_none_or(restricted_name_valid)
            && restricted_name_valid(&self.sandbox_image)
            && (1..=4).contains(&self.sandbox_cpus)
            && (64..=4096).contains(&self.sandbox_memory_mb)
            && (1..=300).contains(&self.sandbox_timeout_secs)
            && (1..=32).contains(&self.max_steps)
            && self.fetch_hosts.len() <= RESTRICTED_HOSTS_MAX
            && self.fetch_hosts.iter().all(|h| {
                !h.is_empty()
                    && h.len() <= 253
                    && h.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-.*".contains(&b))
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestrictedThread {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    /// 0 means the conversation was never made restricted.
    pub revision: i64,
    pub enabled: bool,
    pub provider_kind: String,
    pub policy: Option<RestrictedPolicy>,
    /// Session-scoped approvals belong to this id.
    pub session_id: Option<String>,
    pub last_owner_input_ms: Option<i64>,
    pub updated_at_ms: i64,
}

/// Full replacement of the owner-editable thread policy, guarded by revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestrictedThreadUpdate {
    pub expected_revision: i64,
    pub enabled: bool,
    pub policy: RestrictedPolicy,
}
impl RestrictedThreadUpdate {
    pub fn is_valid(&self) -> bool {
        self.expected_revision >= 0 && self.policy.is_valid()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestrictedDecision {
    Allow,
    Ask,
    Deny,
}
impl RestrictedDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "allow" => Some(Self::Allow),
            "ask" => Some(Self::Ask),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }
}

/// Who made the decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestrictedDecider {
    Policy,
    Owner,
    SessionGrant,
    Timeout,
    System,
}
impl RestrictedDecider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Policy => "policy",
            Self::Owner => "owner",
            Self::SessionGrant => "session_grant",
            Self::Timeout => "timeout",
            Self::System => "system",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "policy" => Some(Self::Policy),
            "owner" => Some(Self::Owner),
            "session_grant" => Some(Self::SessionGrant),
            "timeout" => Some(Self::Timeout),
            "system" => Some(Self::System),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestrictedAuditRecord {
    pub id: i64,
    pub session_id: String,
    pub at_ms: i64,
    pub action: String,
    /// The request as the model sent it, bounded and with no secrets by construction.
    pub request: String,
    pub decision: RestrictedDecision,
    pub decider: RestrictedDecider,
    pub reason: Option<String>,
    pub approval_id: Option<String>,
    /// `ok`, `error` or `denied`; `None` while the action is still running or awaiting the owner.
    pub outcome: Option<String>,
    pub result_summary: Option<String>,
    pub finished_at_ms: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestrictedAuditPage {
    pub records: Vec<RestrictedAuditRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestrictedApprovalState {
    Pending,
    Approved,
    Denied,
    Expired,
}
impl RestrictedApprovalState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Expired => "expired",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "approved" => Some(Self::Approved),
            "denied" => Some(Self::Denied),
            "expired" => Some(Self::Expired),
            _ => None,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestrictedApprovalScope {
    Once,
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestrictedApproval {
    pub id: String,
    pub audit_id: i64,
    pub action: String,
    /// Human summary of exactly what would happen (recipient and text, path, command...).
    pub summary: String,
    /// Present when "allow for this session" is offered for this request.
    pub session_grant_label: Option<String>,
    pub state: RestrictedApprovalState,
    pub scope: Option<RestrictedApprovalScope>,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub decided_at_ms: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestrictedApprovalList {
    pub approvals: Vec<RestrictedApproval>,
}
/// The owner's one-tap answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestrictedApprovalDecision {
    pub approve: bool,
    pub scope: RestrictedApprovalScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestrictedMessage {
    pub id: i64,
    /// `user`, `assistant`, `tool` or `notice`.
    pub role: String,
    pub content: Option<String>,
    pub created_at_ms: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestrictedMessagePage {
    pub messages: Vec<RestrictedMessage>,
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn policy() -> RestrictedPolicy {
        serde_json::from_str(r#"{"workspace":"/srv/ws/one","endpoint":"runpod"}"#).unwrap()
    }
    #[test]
    fn defaults_are_closed() {
        let p = policy();
        assert!(p.is_valid());
        assert!(!p.web_enabled && !p.sandbox_enabled && !p.messaging_enabled && !p.gpu_enabled);
        assert!(!p.sandbox_network_granted && !p.sandbox_workspace_writable);
    }
    #[test]
    fn unknown_fields_and_injection_shaped_values_are_refused() {
        assert!(serde_json::from_str::<RestrictedPolicy>(
            r#"{"workspace":"/w","endpoint":"e","privileged":true}"#
        )
        .is_err());
        for bad in [
            "/ws,dst=/etc",
            "/ws:/etc:rw",
            "relative/ws",
            "/ws/../etc",
            "/",
            "/ws\n",
            "/ws with space",
        ] {
            let mut p = policy();
            p.workspace = bad.into();
            assert!(!p.is_valid(), "{bad}");
        }
        for bad in ["--privileged", "-v", "img name", "../x", "", "a;b"] {
            let mut p = policy();
            p.sandbox_image = bad.into();
            assert!(!p.is_valid(), "{bad}");
        }
        let mut p = policy();
        p.sandbox_memory_mb = 1 << 20;
        assert!(!p.is_valid());
    }
}
