//! Native UI data for read-only tracker actions. No filesystem paths or executable authority.
use crate::ConversationId;
use uuid::Uuid;

pub const TRACKER_READ_POLICY_V1: &str = "local-mail-v1";
fn default_read_policy() -> String {
    TRACKER_READ_POLICY_V1.into()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackerDiscoveryRequest {
    pub request_key: String,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TrackerSourceDiscovery {
    pub request_key: String,
    pub sources: Vec<TrackerMailSource>,
    pub expires_ms: i64,
    pub read_only: bool,
    pub duplicate: bool,
}

/// Opaque entries in the trusted local source registry. Browser input never
/// supplies filesystem paths; the runtime must re-resolve these before reading.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectedMailSource {
    pub source_id: Uuid,
    pub inbox: Vec<Uuid>,
    pub sent: Vec<Uuid>,
}
impl SelectedMailSource {
    pub fn is_valid(&self) -> bool {
        let folders: Vec<_> = self.inbox.iter().chain(&self.sent).collect();
        !self.source_id.is_nil()
            && !self.inbox.is_empty()
            && !self.sent.is_empty()
            && folders.len() <= 8
            && folders.iter().all(|id| !id.is_nil())
            && folders
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                == folders.len()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackerSourceSelect {
    pub request_key: String,
    pub expected_revision: i64,
    pub source: SelectedMailSource,
    pub acknowledge_read_only_access: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackerSourceRemove {
    pub request_key: String,
    pub expected_revision: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TrackerMailFolder {
    pub id: Uuid,
    pub label: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TrackerMailSource {
    pub id: Uuid,
    pub label: String,
    pub inbox: Vec<TrackerMailFolder>,
    pub sent: Vec<TrackerMailFolder>,
    pub ready: bool,
}

/// One owner-authorized check; no implicit recurring automation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackerCheckRequest {
    pub request_key: String,
    pub expected_source_revision: i64,
    pub expected_recipe: String,
    pub expected_classifier_id: String,
    pub expected_classifier_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TrackerCheckReceipt {
    pub request_key: String,
    pub authority: Option<TrackerScanAuthority>,
    pub cancelled: bool,
    pub duplicate: bool,
    pub result: Option<TrackerScanReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TrackerSourceReceipt {
    pub request_key: String,
    pub source_revision: i64,
    pub source_digest: String,
    pub duplicate: bool,
}

/// An owner decision receipt, not an executable read capability.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TrackerScanAuthority {
    #[serde(default = "default_read_policy")]
    pub read_policy_id: String,
    pub authority_id: Uuid,
    pub namespace: Uuid,
    pub generation: i64,
    pub conversation_id: ConversationId,
    pub source_revision: i64,
    pub recipe_id: String,
    pub classifier_digest: String,
    pub duplicate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TrackerScanReceipt {
    pub id: Uuid,
    pub request_key: String,
    pub namespace: Uuid,
    pub generation: i64,
    pub due_ms: i64,
    pub source_revision: i64,
    pub recipe_id: String,
    pub classifier_digest: String,
    pub news: bool,
    pub digest_id: Option<Uuid>,
    pub labelled: usize,
    pub dropped: usize,
    pub duplicates: usize,
    /// Unknown for older receipts. A truncated read never means full catch-up.
    #[serde(default)]
    pub more_mail: Option<bool>,
    #[serde(default)]
    pub read_warnings: Option<TrackerReadWarnings>,
    pub changes: Vec<crate::TrackerChange>,
    pub recorded_ms: i64,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct TrackerReadWarnings {
    pub skipped_large: u64,
    pub skipped_unsafe: u64,
    pub skipped_missing: u64,
    pub skipped_unsettled: u64,
}
impl TrackerReadWarnings {
    pub fn total(&self) -> u64 {
        self.skipped_large
            .saturating_add(self.skipped_unsafe)
            .saturating_add(self.skipped_missing)
            .saturating_add(self.skipped_unsettled)
    }
}
