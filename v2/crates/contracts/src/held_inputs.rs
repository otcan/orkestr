//! Durable owner input held by Stop. This read evidence cannot release a hold.
use crate::{ConversationId, EventId, MessageId, RunId};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeldInputReason {
    StopBoundary,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeldOwnerInput {
    pub message_id: MessageId,
    pub source_event_id: EventId,
    pub scope_sequence: i64,
    pub reason: HeldInputReason,
    pub boundary_run_id: RunId,
    pub boundary_event_id: EventId,
    pub through_scope_sequence: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeldOwnerInputPage {
    pub schema_version: u32,
    pub conversation_id: ConversationId,
    pub revision: i64,
    pub observed_at_ms: i64,
    pub held: Vec<HeldOwnerInput>,
    pub next_after_sequence: Option<i64>,
    /// Fresh unheld queued/claimed owner input exists. Not native readiness or a
    /// dispatch grant; ordinary claim/admission still checks all current fences.
    pub eligible_input_available: bool,
}
impl HeldOwnerInputPage {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && !self.conversation_id.0.is_nil()
            && self.revision >= 0
            && self.observed_at_ms > 0
            && self.held.len() <= 100
            && self.held.iter().all(|h| {
                h.scope_sequence > 0
                    && h.through_scope_sequence >= h.scope_sequence
                    && [
                        &h.message_id.0,
                        &h.source_event_id.0,
                        &h.boundary_run_id.0,
                        &h.boundary_event_id.0,
                    ]
                    .iter()
                    .all(|id| !id.is_nil())
            })
            && self
                .held
                .windows(2)
                .all(|h| h[0].scope_sequence < h[1].scope_sequence)
            && self
                .next_after_sequence
                .is_none_or(|s| self.held.last().is_some_and(|h| h.scope_sequence == s))
    }
}
