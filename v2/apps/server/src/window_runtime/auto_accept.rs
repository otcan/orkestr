//! Owner auto-acceptance (V1 behaviour) for conversations with a live window.
//!
//! Authority: a conversation's `review_before_accepting` setting is the
//! owner's explicit, persisted delegation. While it is false (the default),
//! this pass accepts each completed Deep or Fast proposal on the owner's
//! behalf, through the same store decision as `POST /accept` and with the
//! owner's own most recent browser session (remembered by the dispatcher).
//! Core re-authenticates that credential in the acceptance transaction.
//! Without a remembered credential nothing happens and proposals wait for a
//! manual "Accept", exactly as with the setting on. Provider output can never
//! reach this path: it reads only Core's committed status projection.
//!
//! Only `awaiting_acceptance` proposals are accepted; a failed, blocked or
//! cancelled run is never accepted. Logs carry static text and IDs only.
use super::controller::Controller;
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::{
    ConversationId, ExecutionAcceptanceRequest, ExecutionPhase, ExecutionStatus,
};

/// Deterministic per-run request key, so a retried pass replays its receipt.
pub(super) fn request_key(run: &orkestr_v2_contracts::RunId) -> String {
    format!("auto-accept:{run}")
}

/// The acceptance this status warrants, if any. Never a terminal failure.
pub(super) fn acceptance(
    conversation: &ConversationId,
    status: &ExecutionStatus,
) -> Option<ExecutionAcceptanceRequest> {
    if status.conversation_id != *conversation
        || status.phase != ExecutionPhase::AwaitingAcceptance
        || status.failure.is_some()
    {
        return None;
    }
    let candidate = status.acceptance_candidate.as_ref()?;
    if status.run_id.as_ref() != Some(&candidate.run_id) {
        return None;
    }
    let request = ExecutionAcceptanceRequest {
        run_id: candidate.run_id.clone(),
        completion_event_id: candidate.completion_event_id.clone(),
        expected_revision: status.revision,
        request_key: request_key(&candidate.run_id),
    };
    request.is_valid().then_some(request)
}

impl Controller {
    /// One pass over every conversation whose live window this process owns.
    pub(super) async fn auto_accept_once(&self) {
        let Some(browser) = self.queue.credential() else {
            return;
        };
        if self.queue.is_closed() {
            return;
        }
        let windows = match self
            .store
            .unresolved_execution_windows_authenticated(&browser)
            .await
        {
            Ok(windows) => windows,
            Err(RuntimeStoreError::Unauthorized) => {
                self.queue.forget(&browser);
                return;
            }
            Err(_) => return,
        };
        for window in windows {
            if self.existing(&window.conversation_id).is_some() {
                self.auto_accept_conversation(&browser, &window.conversation_id)
                    .await;
            }
        }
    }

    /// Accept this conversation's pending Deep, then Fast, proposal unless the
    /// owner chose to review. Returns how many proposals were accepted.
    pub(super) async fn auto_accept_conversation(
        &self,
        browser: &str,
        conversation: &ConversationId,
    ) -> u32 {
        let owner = self.config.owner_id.clone();
        // Fail closed: unreadable settings leave the proposal for the owner.
        match self
            .store
            .conversation_settings(browser, &owner, conversation)
            .await
        {
            Ok(settings) if !settings.review_before_accepting => {}
            _ => return 0,
        }
        let mut accepted = 0;
        let deep = self.store.execution_status(&owner, conversation).await;
        if let Ok(Some(status)) = deep {
            accepted += u32::from(self.accept_status(browser, conversation, &status).await);
        }
        // Read Fast after any Deep acceptance: the revision is per conversation.
        if let Some(scope) = self.fast_snapshot(&owner, conversation) {
            let fast = scope
                .store
                .execution_fast_status_authenticated(browser, conversation)
                .await;
            if let Ok(Some(status)) = fast {
                accepted += u32::from(self.accept_status(browser, conversation, &status).await);
            }
        }
        accepted
    }

    async fn accept_status(
        &self,
        browser: &str,
        conversation: &ConversationId,
        status: &ExecutionStatus,
    ) -> bool {
        let Some(request) = acceptance(conversation, status) else {
            return false;
        };
        match self
            .store
            .accept_execution_authenticated(browser, conversation, &request)
            .await
        {
            Ok(receipt) if receipt.run_id == request.run_id => {
                eprintln!("owner auto-accept: accepted run {}", request.run_id);
                true
            }
            Ok(_) => false,
            Err(RuntimeStoreError::Unauthorized) => {
                self.queue.forget(browser);
                false
            }
            // Busy (Workers still deciding), a moved revision or a fenced run:
            // the next pass reads fresh status and tries again.
            Err(_) => false,
        }
    }
}

#[cfg(test)]
#[path = "auto_accept_tests.rs"]
mod tests;
