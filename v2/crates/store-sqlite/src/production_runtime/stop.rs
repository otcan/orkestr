//! Trusted server boundary for cookie-authenticated, revision-guarded Stop.
use super::*;
use orkestr_v2_contracts::{
    ConversationId, ExecutionControlRequest, ExecutionStopOutcome, ExecutionStopReceipt,
};
impl Store {
    /// Server supplies authenticated owner and validates CSRF/origin. This still
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
        if !input.is_valid() || !valid(&input.request_key) || conversation.0.is_nil() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let (receipt, revision) = self
            .production_cancel_guarded(
                owner,
                &input.run_id,
                &input.request_key,
                Some((conversation, input.expected_revision)),
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
