//! Native-attach holds at window admission and dispatch (`native_attach`).
//!
//! While the owner works in a conversation's native session from a terminal,
//! its window intents only queue: no fresh window, no follow-up join and no
//! operator provider switch. Each pass of the dispatcher (at least once a
//! second while rows wait) skips a held conversation's rows, so they are
//! admitted in their order, on the same session binding, once the hold is
//! released or lapses. The hold is a Root file read on every check, so a
//! restarted process honours it the same way. A deploy drain is unaffected:
//! a held conversation has no unresolved window, only queued intents.
use super::controller::Controller;
use orkestr_v2_contracts::ConversationId;

impl Controller {
    pub(super) fn native_attach_held(&self, conversation: &ConversationId) -> bool {
        self.config
            .native_attach
            .as_ref()
            .is_some_and(|holds| holds.held(conversation, super::dispatch::now_ms()))
    }
}
