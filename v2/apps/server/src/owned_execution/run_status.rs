//! The owned run is selected by its consumed capability, never inbox ordering.
use super::*;
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::{ConversationId, ExecutionStatus, RunId};

impl ConfiguredExecution {
    pub(super) async fn owned_run_status(
        &self,
        run: &RunId,
    ) -> Result<ExecutionStatus, &'static str> {
        read(
            &self.store,
            &self.token,
            &self.owner,
            &self.config.conversation_id,
            run,
        )
        .await
        .map_err(|_| "execution status unavailable")
    }
}

async fn read(
    store: &Store,
    credential: &str,
    owner: &OwnerId,
    conversation: &ConversationId,
    run: &RunId,
) -> Result<ExecutionStatus, RuntimeStoreError> {
    store
        .execution_run_status(credential, owner, conversation, run)
        .await?
        .ok_or(RuntimeStoreError::NotFound)
}

#[cfg(test)]
mod tests;
