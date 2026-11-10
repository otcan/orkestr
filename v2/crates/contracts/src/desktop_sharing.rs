//! Owner-level desk sharing. When it is on, every desk is discoverable and
//! reservable by every chat that has a desktop binding, whatever slugs that
//! binding lists; the binding then only names the chat's V1 thread (the lease
//! holder V1 sees) and carries its desktop grant. When it is off, a chat
//! reaches exactly the desks its binding lists, as before. One holder per
//! desk and the fencing of every lease are the same either way.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopSharing {
    pub schema_version: u32,
    pub share_all_desks: bool,
    /// 0 while the owner has never set it (the default, off).
    pub revision: i64,
    pub updated_at_ms: Option<i64>,
}
impl DesktopSharing {
    pub fn default_off() -> Self {
        Self {
            schema_version: 1,
            share_all_desks: false,
            revision: 0,
            updated_at_ms: None,
        }
    }
}

/// Owner change, guarded by the current revision (0 for the default).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopSharingRequest {
    pub expected_revision: i64,
    pub share_all_desks: bool,
}
impl DesktopSharingRequest {
    pub fn is_valid(&self) -> bool {
        self.expected_revision >= 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sharing_request_is_closed_and_revision_guarded() {
        let parsed: DesktopSharingRequest =
            serde_json::from_str(r#"{"expected_revision":0,"share_all_desks":true}"#).unwrap();
        assert!(parsed.is_valid() && parsed.share_all_desks);
        assert!(!DesktopSharingRequest {
            expected_revision: -1,
            share_all_desks: true
        }
        .is_valid());
        assert!(serde_json::from_str::<DesktopSharingRequest>(
            r#"{"expected_revision":0,"share_all_desks":true,"desks":["*"]}"#
        )
        .is_err());
        assert!(!DesktopSharing::default_off().share_all_desks);
    }
}
