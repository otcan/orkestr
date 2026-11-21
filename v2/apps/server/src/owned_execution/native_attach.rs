//! Native-attach holds in a window's Deep writer (`crate::native_attach`).
//!
//! While the owner works in this conversation's native session from a
//! terminal the writer takes no further input. The hold is checked only where
//! the writer's input loop ends with a canonical window close: after a
//! completed Codex turn (`next_after_turn`) and after an accepted Claude turn
//! (`wait_eligible_after_turn`). The native tree is reaped there and the
//! window closes as after its last input: no error, no reconciliation, no
//! withdrawn queue row. Bootstrap and a window's first claim are never gated,
//! because a window that ran no turn has no canonical close; a window admitted
//! just before the hold runs the turn it was admitted for and then closes, and
//! `GET /native-attach` reports `native_idle` only after that. Fast, Worker
//! and parallel Deep slot factories carry no holds: each has its own session
//! binding and native session, never this one.
use super::*;
use orkestr_v2_store_sqlite::ConsumedProviderDispatch;

impl ConfiguredExecution {
    /// The owner works in this conversation's native session from a terminal.
    pub(super) fn native_attach_held(&self) -> bool {
        self.native_attach.as_ref().is_some_and(|holds| {
            holds.held(&self.config.conversation_id, crate::deploy_drain::now_ms())
        })
    }

    /// The first Deep run after the owner's last terminal attach of this
    /// native session gets a one-line internal note before its provider
    /// input. Core decides "first" from its run evidence. Any doubt sends the
    /// input unchanged.
    pub(super) async fn note_native_attach(&self, capability: &mut ConsumedProviderDispatch) {
        let Some(holds) = &self.native_attach else {
            return;
        };
        let now = crate::deploy_drain::now_ms();
        let Some(ended) = holds.ended(&self.config.conversation_id, now) else {
            return;
        };
        let binding = &capability.provider().binding;
        let native = binding
            .native_session_id
            .as_deref()
            .and_then(|id| uuid::Uuid::parse_str(id).ok());
        if native != Some(ended.native_session_id) {
            return;
        }
        let run = capability.provider().run.run_id.clone();
        match self
            .store
            .first_deep_run_since(&run, ended.ended_at_ms)
            .await
        {
            Ok(true) => {
                if capability.prepend_internal_note(&crate::native_attach::note(&ended)) {
                    // Identifiers only, never input text.
                    eprintln!("owned execution noted the owner's terminal attach: run={run}");
                }
            }
            Ok(false) => {}
            Err(_) => eprintln!("owned execution attach note skipped: run evidence unavailable"),
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "native_attach_tests.rs"]
mod tests;
