//! Read-only accepted result provenance; these records are not chat messages.
use crate::{ConversationId, EventId, PayloadId, RunId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedResult {
    pub run_id: RunId,
    pub completion_event_id: EventId,
    pub acceptance_event_id: EventId,
    /// Conversation event sequence, used as the exclusive pagination cursor.
    pub acceptance_sequence: i64,
    /// Last canonical progress payload before this exact completion, if any.
    pub payload_id: Option<PayloadId>,
    pub payload_removed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedResults {
    pub conversation_id: ConversationId,
    pub results: Vec<AcceptedResult>,
    /// Present only when another page existed at this read cut.
    pub next_after_sequence: Option<i64>,
}
impl AcceptedResults {
    pub fn is_valid(&self) -> bool {
        !self.conversation_id.0.is_nil()
            && self.results.len() <= 50
            && self.results.iter().all(|r| {
                !r.run_id.0.is_nil()
                    && !r.completion_event_id.0.is_nil()
                    && !r.acceptance_event_id.0.is_nil()
                    && r.acceptance_sequence > 0
                    && r.payload_id.as_ref().is_none_or(|p| !p.0.is_nil())
                    && (!r.payload_removed || r.payload_id.is_some())
            })
            && self.results.windows(2).all(|w| w[0].acceptance_sequence < w[1].acceptance_sequence)
            && self.next_after_sequence.is_none_or(|n| self.results.last().is_some_and(|r| r.acceptance_sequence == n))
    }
}
