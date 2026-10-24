use super::*;
pub use orkestr_v2_contracts::tracker_actions::{
    SelectedMailSource, TrackerCheckReceipt, TrackerCheckRequest, TrackerScanAuthority,
    TrackerScanReceipt, TrackerSourceReceipt, TrackerSourceRemove, TrackerSourceSelect,
};

#[derive(Debug, Clone)]
pub struct TrackerScanEnable {
    pub timer: TimerEnableRequest,
    pub expected_source_revision: i64,
    pub expected_recipe: String,
    pub classifier_id: String,
    pub classifier_digest: String,
}

/// The scheduler chooses this type before taking any occurrence. An action is
/// never retried as a model instruction when its own admission is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimerWorkKind {
    Instruction,
    TrackerScan,
}

/// Trusted server registry data. Intentionally no wire decoder or Debug.
/// Backing paths stay in local storage and never enter the selection receipt.
pub struct TrackerLocalSource {
    pub source_id: Uuid,
    pub backing_json: String,
}

/// Private Core read/commit capability. It has no wire decoder, Clone, provider
/// admission or native identity. The bounded reader slot must precede its issue.
pub struct TrackerScanClaim {
    pub(super) read_policy_id: String,
    pub(super) id: Uuid,
    pub(super) owner: OwnerId,
    pub(super) namespace: Uuid,
    pub(super) generation: i64,
    pub(super) conversation: ConversationId,
    pub(super) authority_id: Uuid,
    pub(super) due_ms: i64,
    pub(super) attempt: i64,
    pub(super) source_revision: i64,
    pub(super) source: SelectedMailSource,
    pub(super) recipe_id: String,
    pub(super) classifier_id: String,
    pub(super) classifier_digest: String,
    pub(super) stop_sequence: i64,
    pub(super) deadline_ms: i64,
    pub(super) issuer_key: String,
}
impl TrackerScanClaim {
    pub fn read_policy_id(&self) -> &str {
        &self.read_policy_id
    }
    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }
    pub fn source(&self) -> &SelectedMailSource {
        &self.source
    }
    pub fn source_revision(&self) -> i64 {
        self.source_revision
    }
    pub fn recipe_id(&self) -> &str {
        &self.recipe_id
    }
    pub fn classifier_id(&self) -> &str {
        &self.classifier_id
    }
    pub fn classifier_digest(&self) -> &str {
        &self.classifier_digest
    }
    pub fn deadline_ms(&self) -> i64 {
        self.deadline_ms
    }
    pub fn request_key(&self) -> String {
        format!(
            "scan:{}:{}:{}",
            self.namespace, self.generation, self.due_ms
        )
    }
}
