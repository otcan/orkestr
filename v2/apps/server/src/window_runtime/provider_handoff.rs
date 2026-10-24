//! Provider changes use the same admission lock and custody proof as reset.
use super::*;
use orkestr_v2_contracts::{ProviderHandoffReceipt, ProviderHandoffRequest};

pub(crate) enum HandoffError {
    Refused,
    Uncertain,
}
fn store_failure(error: RuntimeStoreError) -> HandoffError {
    if matches!(error, RuntimeStoreError::Unavailable) {
        HandoffError::Uncertain
    } else {
        HandoffError::Refused
    }
}

impl Controller {
    pub(crate) async fn handoff_provider(
        &self,
        browser: &str,
        conversation: &ConversationId,
        request: &ProviderHandoffRequest,
    ) -> Result<ProviderHandoffReceipt, HandoffError> {
        // Returning an existing decision is read-only, even if a later window
        // is now active. Authenticate and compare semantics inside the Store.
        if let Some(receipt) = self
            .store
            .provider_handoff_existing_authenticated(browser, conversation, request)
            .await
            .map_err(store_failure)?
        {
            return Ok(receipt);
        }
        let _opening = self.opening.lock().await;
        if let Some(receipt) = self
            .store
            .provider_handoff_existing_authenticated(browser, conversation, request)
            .await
            .map_err(store_failure)?
        {
            return Ok(receipt);
        }
        if self.live_owner(conversation).await {
            return Err(HandoffError::Refused);
        }
        let window = self
            .store
            .execution_window_status_authenticated(browser, conversation)
            .await
            .map_err(store_failure)?
            .ok_or(HandoffError::Refused)?;
        if window.window_id != request.window_id
            || window.generation != request.generation
            || window.state != ExecutionWindowState::Closed
            || !self.manager_released(&window, true).await
        {
            return Err(HandoffError::Refused);
        }
        let receipt = self
            .store
            .handoff_provider_authenticated(browser, conversation, request)
            .await
            .map_err(store_failure)?;
        self.forget(conversation)
            .map_err(|_| HandoffError::Uncertain)?;
        Ok(receipt)
    }
}
