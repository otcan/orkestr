//! Issued stop authority, separate from execution freshness and inference grants.
use crate::containment::{Error, ExecutionScope};
use orkestr_v2_application::runtime::{
    AdmissionPurpose, CancelReceipt, InflightStatus, ProviderAdmission, RunState,
};
use orkestr_v2_store_sqlite::Store;

pub(crate) struct CancellationFence {
    store: Store,
    control: ProviderAdmission,
    scope: ExecutionScope,
}
impl CancellationFence {
    pub(super) fn new(
        store: Store,
        original: &ProviderAdmission,
        receipt: &CancelReceipt,
        scope: ExecutionScope,
    ) -> Result<Self, Error> {
        let old = &original.run;
        let issued = &receipt.new_fenced_admission;
        let mut expected = old.clone();
        expected.purpose = AdmissionPurpose::CancellationAcknowledgement;
        expected.lease_generation = issued.lease_generation;
        expected.dispatch_fence = issued.dispatch_fence;
        expected.lease_deadline_ms = issued.lease_deadline_ms;
        if old.purpose != AdmissionPurpose::Execution
            || issued != &expected
            || issued.lease_generation <= old.lease_generation
            || issued.dispatch_fence <= old.dispatch_fence
            || receipt.state != RunState::CancelRequested
            || receipt.inflight_status != InflightStatus::Unknown
        {
            return Err(Error::AuthorityProtocol);
        }
        let control = ProviderAdmission {
            run: issued.clone(),
            binding: original.binding.clone(),
        };
        let fence = Self {
            store,
            control,
            scope,
        };
        fence.dispatch(&fence.scope, || Ok(()))?;
        Ok(fence)
    }
    pub(crate) fn dispatch<T>(
        &self,
        scope: &ExecutionScope,
        action: impl FnOnce() -> Result<T, Error>,
    ) -> Result<T, Error> {
        if scope != &self.scope {
            return Err(Error::WrongScope);
        }
        self.store
            .with_cancellation_fence(&self.control, action)
            .map_err(|_| Error::Revoked)?
    }
    pub(super) fn control(&self) -> &ProviderAdmission {
        &self.control
    }
}
