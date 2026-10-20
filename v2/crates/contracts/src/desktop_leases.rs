//! Brokered V1 desktop leases for a V2 conversation during the parallel run.
//! V1's lease broker stays the authority: V2 binds a conversation to exactly
//! one V1 thread identity and a set of granted desktop slugs, forwards
//! acquire/heartbeat/release to V1 and fences every follow-up by the V1
//! lease's fencing token (stored by V2 only as a hash). V2 never launches a
//! browser, never reads profiles and never returns noVNC/CDP endpoints.
use crate::ConversationId;
use serde::{Deserialize, Serialize};

pub const DESKTOP_SLUGS_MAX: usize = 16;
pub const DESKTOP_TTL_MIN_MS: u64 = 60_000;
pub const DESKTOP_TTL_MAX_MS: u64 = 8 * 60 * 60 * 1000;
/// Header carrying a per-conversation desktop grant (64 lowercase hex).
pub const DESKTOP_GRANT_HEADER: &str = "x-orkestr-desktop-grant";

pub fn desktop_slug_valid(slug: &str) -> bool {
    (1..=64).contains(&slug.len())
        && slug.as_bytes()[0].is_ascii_alphanumeric()
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}
pub fn v1_thread_id_valid(id: &str) -> bool {
    (1..=200).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn short_text(value: &Option<String>, max: usize) -> bool {
    value
        .as_deref()
        .is_none_or(|v| v.len() <= max && !v.chars().any(char::is_control))
}

/// Owner binds a conversation to one V1 thread and its granted slugs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopBindingRequest {
    /// 0 to create; otherwise the current binding revision.
    pub expected_revision: i64,
    pub v1_thread_id: String,
    pub desktop_slugs: Vec<String>,
}
impl DesktopBindingRequest {
    pub fn is_valid(&self) -> bool {
        let mut seen = std::collections::HashSet::new();
        self.expected_revision >= 0
            && v1_thread_id_valid(&self.v1_thread_id)
            && !self.desktop_slugs.is_empty()
            && self.desktop_slugs.len() <= DESKTOP_SLUGS_MAX
            && self
                .desktop_slugs
                .iter()
                .all(|s| desktop_slug_valid(s) && seen.insert(s.as_str()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopBinding {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub revision: i64,
    pub v1_thread_id: String,
    pub desktop_slugs: Vec<String>,
    /// Whether a conversation desktop grant is currently issued.
    pub grant_issued: bool,
    pub grant_generation: i64,
}

/// One-time view of a newly issued grant. Only its hash is stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopGrantIssued {
    pub binding: DesktopBinding,
    pub grant: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopAcquireRequest {
    pub ttl_ms: u64,
    #[serde(default)]
    pub purpose: Option<String>,
}
impl DesktopAcquireRequest {
    pub fn is_valid(&self) -> bool {
        (DESKTOP_TTL_MIN_MS..=DESKTOP_TTL_MAX_MS).contains(&self.ttl_ms)
            && short_text(&self.purpose, 200)
    }
}

/// Heartbeat; `extend_ttl_ms` renews V1 expiry through a same-thread acquire
/// that must return the same fencing token, or the lease is reported lost.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopHeartbeatRequest {
    pub fencing_token: String,
    #[serde(default)]
    pub extend_ttl_ms: Option<u64>,
}
impl DesktopHeartbeatRequest {
    pub fn is_valid(&self) -> bool {
        fencing_token_valid(&self.fencing_token)
            && self
                .extend_ttl_ms
                .is_none_or(|t| (DESKTOP_TTL_MIN_MS..=DESKTOP_TTL_MAX_MS).contains(&t))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopReleaseRequest {
    pub fencing_token: String,
    #[serde(default)]
    pub reason: Option<String>,
}
impl DesktopReleaseRequest {
    pub fn is_valid(&self) -> bool {
        fencing_token_valid(&self.fencing_token) && short_text(&self.reason, 200)
    }
}
pub fn fencing_token_valid(token: &str) -> bool {
    (8..=128).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopLeaseState {
    Active,
    Released,
    /// V1 no longer recognises the fencing token (expired, forced, superseded).
    Lost,
}
impl DesktopLeaseState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Released => "released",
            Self::Lost => "lost",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "released" => Some(Self::Released),
            "lost" => Some(Self::Lost),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopLeaseView {
    pub conversation_id: ConversationId,
    pub desktop_slug: String,
    pub v1_thread_id: String,
    pub v1_lease_id: String,
    pub fencing_version: i64,
    pub state: DesktopLeaseState,
    pub expires_at: Option<String>,
    pub acquired_at_ms: i64,
    pub heartbeat_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub end_reason: Option<String>,
}

/// Acquire receipt. The fencing token is shown to the acquirer only.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopLeaseGranted {
    pub lease: DesktopLeaseView,
    pub fencing_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopLeaseList {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub binding: Option<DesktopBinding>,
    pub leases: Vec<DesktopLeaseView>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bindings_slugs_and_tokens_are_closed() {
        let ok = DesktopBindingRequest {
            expected_revision: 0,
            v1_thread_id: "worker-abc_1:x".into(),
            desktop_slugs: vec!["sales-nav".into(), "gmail_signal".into()],
        };
        assert!(ok.is_valid());
        for slugs in [
            vec![],
            vec!["Sales".into()],
            vec!["a".into(), "a".into()],
            vec!["-x".into()],
        ] {
            let mut r = ok.clone();
            r.desktop_slugs = slugs;
            assert!(!r.is_valid());
        }
        let mut r = ok.clone();
        r.v1_thread_id = "../etc".into();
        assert!(!r.is_valid());
        assert!(fencing_token_valid("fence-aaaa-aaaa-0001"));
        assert!(!fencing_token_valid("short"));
        assert!(!fencing_token_valid("has space in it"));
        assert!(!DesktopAcquireRequest {
            ttl_ms: 1000,
            purpose: None
        }
        .is_valid());
        assert!(DesktopAcquireRequest {
            ttl_ms: 600_000,
            purpose: Some("linkedin".into())
        }
        .is_valid());
        assert!(!DesktopHeartbeatRequest {
            fencing_token: "a".repeat(32),
            extend_ttl_ms: Some(DESKTOP_TTL_MAX_MS + 1)
        }
        .is_valid());
    }
}
