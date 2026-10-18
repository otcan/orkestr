use super::*;
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::{ConversationId, RunId, SessionId};
use std::time::Duration;

#[async_trait]
impl RuntimeStore for FixtureSupervisorStore {
    async fn ensure_role_bindings(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<RoleBindings> {
        let _ = (owner, conversation);
        Err(RuntimeStoreError::Unavailable)
    }
    async fn create_worker_binding(
        &self,
        _: &OwnerId,
        _: &ConversationId,
        _: Option<&SessionId>,
        _: &str,
    ) -> Result<Binding> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn claim_next(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        consumer: &SessionId,
        duration: Duration,
    ) -> Result<Option<InboxClaim>> {
        let _ = (owner, conversation, consumer, duration);
        Err(RuntimeStoreError::Unavailable)
    }
    async fn admit_run(
        &self,
        claim: &InboxClaim,
        binding: &SessionId,
        generation: u64,
        key: &str,
    ) -> Result<RunAdmissionResult> {
        self.admit(claim, binding, generation, key).await
    }
    async fn claim_provider_dispatch(
        &self,
        candidate: &RunAdmissionResult,
        key: &str,
    ) -> Result<DispatchClaimResult> {
        self.reserve(candidate, key).await
    }
    async fn consume_provider_dispatch(
        &self,
        claim: &DispatchClaim,
    ) -> Result<DispatchConsumption> {
        self.consume(claim).await
    }
    async fn bind_native_session(
        &self,
        _: &RunAdmission,
        _: &str,
        _: &str,
    ) -> Result<RunAdmission> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn renew_lease(&self, admission: &RunAdmission, generation: u64) -> Result<RunAdmission> {
        self.renew(admission, generation).await
    }
    async fn append_provider_event(
        &self,
        owner: &OwnerId,
        admission: &ProviderAdmission,
        input: &ProviderEventInput,
    ) -> Result<ProviderEventReceipt> {
        self.append_observation(owner, admission, input).await
    }
    async fn request_cancel(&self, _: &OwnerId, _: &RunId, _: &str) -> Result<CancelReceipt> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn acknowledge_inbox(&self, _: &InboxClaim, _: &RunAdmission) -> Result<()> {
        // No standalone ack: successful admit already consumed exactly its row.
        Err(RuntimeStoreError::Unavailable)
    }
    async fn recover_runtime(
        &self,
        _: &OwnerId,
        _: &str,
        _: i64,
        _: Option<&str>,
        _: u32,
    ) -> Result<RecoveryPage> {
        Err(RuntimeStoreError::Unavailable)
    }
}
