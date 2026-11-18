//! Every interim update of a conversation's Deep runs, in event order, so the
//! web chat can show each one as its own message the way WhatsApp does
//! (`docs/v2/accepted-results.md`, "Run updates"). An update is a canonical
//! progress payload; its text is read like an accepted answer's
//! (`/payloads?ids=`). The payload a run's accepted result names is that run's
//! final answer and is marked `final_answer`: the chat shows it once, as the
//! accepted reply.
use crate::{ConversationId, PayloadId, RunId};
use serde::{Deserialize, Serialize};

/// Largest page of `GET /api/v2/conversations/{id}/updates`.
pub const RUN_UPDATES_PAGE_MAX: u16 = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunUpdate {
    pub run_id: RunId,
    pub payload_id: PayloadId,
    /// Conversation event sequence of the progress observation: the update
    /// is shown at this place in the chat. Also the page cursor.
    pub sequence: i64,
    /// When Core recorded it.
    pub observed_at_ms: i64,
    pub payload_removed: bool,
    /// This payload is its run's accepted answer (the accepted result names it).
    pub final_answer: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunUpdates {
    pub conversation_id: ConversationId,
    /// Oldest first.
    pub updates: Vec<RunUpdate>,
    /// Present only when another forward page existed at this read cut.
    pub next_after_sequence: Option<i64>,
}

impl RunUpdates {
    pub fn is_valid(&self) -> bool {
        !self.conversation_id.0.is_nil()
            && self.updates.len() <= usize::from(RUN_UPDATES_PAGE_MAX)
            && self
                .updates
                .iter()
                .all(|u| !u.run_id.0.is_nil() && !u.payload_id.0.is_nil() && u.sequence > 0)
            && self
                .updates
                .windows(2)
                .all(|w| w[0].sequence < w[1].sequence)
            && self
                .next_after_sequence
                .is_none_or(|n| self.updates.last().is_some_and(|u| u.sequence == n))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(sequence: i64) -> RunUpdate {
        RunUpdate {
            run_id: RunId(uuid::Uuid::from_u128(1)),
            payload_id: PayloadId(uuid::Uuid::from_u128(100 + sequence as u128)),
            sequence,
            observed_at_ms: 1,
            payload_removed: false,
            final_answer: false,
        }
    }

    #[test]
    fn pages_are_ordered_and_bounded() {
        let page = |updates: Vec<RunUpdate>, next| RunUpdates {
            conversation_id: ConversationId(uuid::Uuid::from_u128(9)),
            updates,
            next_after_sequence: next,
        };
        assert!(page(vec![update(3), update(5)], None).is_valid());
        assert!(page(vec![update(3), update(5)], Some(5)).is_valid());
        assert!(!page(vec![update(3), update(5)], Some(3)).is_valid());
        assert!(!page(vec![update(5), update(3)], None).is_valid());
        assert!(!page(vec![update(3), update(3)], None).is_valid());
        assert!(!page(vec![update(0)], None).is_valid());
        assert!(!page(vec![], Some(1)).is_valid());
        assert!(!page((1..=101).map(update).collect(), None).is_valid());
        let json = serde_json::to_value(update(3)).unwrap();
        assert_eq!(json["final_answer"], false);
        assert_eq!(json["sequence"], 3);
    }
}
