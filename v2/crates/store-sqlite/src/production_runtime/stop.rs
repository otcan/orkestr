//! Session-bound browser and trusted internal boundaries for guarded Stop.
use super::*;
use orkestr_v2_contracts::{
    ConversationId, ExecutionControlRequest, ExecutionStopOutcome, ExecutionStopReceipt,
};
impl Store {
    /// Trusted internal boundary; cached owner is not current browser authority.
    /// HTTP callers must use stop_execution_authenticated instead. This still
    /// requires a production supervisor-bound handle; an ordinary unbound Store
    /// cannot mint cancellation authority from a browser's IDs or request text.
    /// Same key + same expected revision replays the original receipt even after
    /// status advances; changed revision conflicts and never sends more control.
    pub async fn stop_execution(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &ExecutionControlRequest,
    ) -> Result<ExecutionStopReceipt> {
        self.stop_execution_guarded(owner, conversation, input, None)
            .await
    }

    /// Browser boundary: revalidate the exact original credential inside the
    /// cancellation write transaction, before both fresh and replay lookups.
    /// HTTP composition must independently enforce Origin and CSRF.
    pub async fn stop_execution_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        input: &ExecutionControlRequest,
    ) -> Result<ExecutionStopReceipt> {
        if credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let owner = self
            .authenticate(credential)
            .await
            .map_err(|_| RuntimeStoreError::Unavailable)?
            .ok_or(RuntimeStoreError::Unauthorized)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("stop-after-authentication")
            .await?;
        self.stop_execution_guarded(&owner, conversation, input, Some(credential))
            .await
    }

    pub(super) async fn stop_execution_guarded(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &ExecutionControlRequest,
        credential: Option<&str>,
    ) -> Result<ExecutionStopReceipt> {
        if !input.is_valid() || !valid(&input.request_key) || conversation.0.is_nil() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let (receipt, revision) = self
            .production_cancel_guarded(
                owner,
                &input.run_id,
                &input.request_key,
                Some((conversation, input.expected_revision)),
                credential,
            )
            .await?;
        let outcome = match (receipt.state, receipt.inflight_status) {
            (RunState::Cancelled, InflightStatus::NotDispatched) => {
                ExecutionStopOutcome::NotDispatched
            }
            (RunState::CancelRequested, InflightStatus::Unknown) => {
                ExecutionStopOutcome::RequestedUnknown
            }
            _ => return Err(RuntimeStoreError::Unavailable),
        };
        Ok(ExecutionStopReceipt {
            schema_version: 1,
            conversation_id: conversation.clone(),
            run_id: input.run_id.clone(),
            request_key: input.request_key.clone(),
            requested_revision: input.expected_revision,
            revision,
            outcome,
        })
    }
}
