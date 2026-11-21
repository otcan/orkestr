//! Native-attach holds at window admission and dispatch (`native_attach`).
//!
//! While the owner works in a conversation's native session from a terminal,
//! its window intents only queue: no fresh window, no follow-up join and no
//! operator provider switch. Each pass of the dispatcher (at least once a
//! second while rows wait) skips a held conversation's rows, so they are
//! admitted in their order, on the same session binding, once the hold is
//! released or lapses. The hold is a Root file read on every check, so a
//! restarted process honours it the same way. A deploy drain is unaffected:
//! a held conversation has no unresolved window, only queued intents. Held
//! rows count toward the owner-wide queue cap, so a large backlog alerts.
use super::controller::Controller;
use orkestr_v2_contracts::{ConversationId, ExecutionWindowQueued};
use std::collections::{HashMap, HashSet};

impl Controller {
    pub(super) fn native_attach_held(&self, conversation: &ConversationId) -> bool {
        self.config
            .native_attach
            .as_ref()
            .is_some_and(|holds| holds.held(conversation, super::dispatch::now_ms()))
    }

    /// The conversations of one dispatch pass's queued rows that the owner
    /// holds now. Their rows keep their place and `pending` stays set, so a
    /// later pass admits them. A held conversation with more than
    /// `HELD_QUEUE_ALERT` queued intents raises a rate-limited alert.
    pub(super) fn native_attach_held_rows(
        &self,
        rows: &[ExecutionWindowQueued],
    ) -> HashSet<ConversationId> {
        let mut held = HashSet::new();
        let Some(holds) = &self.config.native_attach else {
            return held;
        };
        let now = super::dispatch::now_ms();
        let mut queued: HashMap<&ConversationId, usize> = HashMap::new();
        for row in rows {
            *queued.entry(&row.conversation_id).or_default() += 1;
        }
        for (conversation, count) in queued {
            if !holds.held(conversation, now) {
                continue;
            }
            if let Some(line) = holds.backlog_alert(conversation, count, now) {
                eprintln!("{line}");
            }
            held.insert(conversation.clone());
        }
        held
    }
}
