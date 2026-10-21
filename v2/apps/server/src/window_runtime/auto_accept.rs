//! Owner auto-acceptance (V1 behaviour) for conversations whose live window
//! this process runs.
//!
//! Principal: the server itself, acting for the owner. It needs no browser
//! or adapter session. Authority is the window task's own Core handle, bound
//! by the window's private credential, plus the conversation's owner setting
//! `review_before_accepting` being off (the owner's explicit, persisted
//! delegation). Core checks both again inside each acceptance transaction,
//! with every owner-path rule (exact owner, conversation and run, an
//! `awaiting_acceptance` proposal, the exact revision, no undecided
//! descendants), and audits each acceptance with actor `auto_accept`.
//! Workers are accepted before Fast and Deep, so a decided Worker never
//! holds its Deep parent. Provider output can never reach this path.
//! Logs carry static text and IDs only.
use super::controller::Controller;

impl Controller {
    /// One pass over every conversation with a live local window task.
    pub(super) async fn auto_accept_once(&self) -> usize {
        if self.queue.is_closed() {
            return 0;
        }
        let owner = self.config.owner_id.clone();
        let mut accepted = 0;
        for (conversation, entry) in self.entries_by_conversation() {
            if !entry.has_local_task().await {
                continue;
            }
            let Some(scope) = entry.handles().snapshot(&owner, &conversation) else {
                continue;
            };
            // An error (window closing, credential retired, store busy) leaves
            // the proposal for the next pass or the owner's manual Accept.
            if let Ok(receipts) = scope
                .store
                .auto_accept_window_proposals(&conversation)
                .await
            {
                for receipt in receipts {
                    eprintln!("owner auto-accept: accepted run {}", receipt.run_id);
                    accepted += 1;
                }
            }
        }
        accepted
    }
}

#[cfg(test)]
#[path = "auto_accept_tests.rs"]
mod tests;
