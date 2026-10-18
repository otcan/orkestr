//! Production observation replay metadata. No native identity or I/O grant.
use crate::*;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderObservedEnvelope {
    pub event_id: EventId,
    /// Exactly 5 in the canonical replay union.
    pub schema_version: u32,
    pub owner_id: OwnerId,
    pub scope: Scope,
    pub aggregate_id: ConversationId,
    pub aggregate_version: i64,
    pub sequence: i64,
    pub occurred_at: String,
    pub source_message_id: MessageId,
    pub source_event_id: EventId,
    pub payload_ref_or_safe_payload: ProviderObserved,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderObserved {
    pub kind: ProviderObservedTag,
    pub run_id: RunId,
    pub session_id: SessionId,
    pub run_sequence: u64,
    pub observation: ProductionObservationKind,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderObservedTag {
    ProviderObserved,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProductionObservationKind {
    Started,
    /// Schema 8 only. Text lives in removable owner-scoped storage.
    ProgressRef { payload_id: PayloadId },
    ApprovalRequested,
    /// Provider completion proposes output; never verified success.
    CompletedProposal,
    Failed,
    Lost,
}
impl ProviderObservedEnvelope {
    pub fn is_valid(&self) -> bool {
        (matches!((&self.payload_ref_or_safe_payload.observation, self.schema_version),
            (ProductionObservationKind::ProgressRef { payload_id }, 8) if !payload_id.0.is_nil())
            || self.schema_version == 5 && !matches!(self.payload_ref_or_safe_payload.observation, ProductionObservationKind::ProgressRef { .. }))
            && self.sequence > 0
            && self.aggregate_version == self.sequence
            && self.payload_ref_or_safe_payload.run_sequence > 0
    }
}
