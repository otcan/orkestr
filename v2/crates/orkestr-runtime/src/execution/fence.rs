//! Durable freshness only; this object cannot authorize an inference frame.
use crate::containment::{DispatchFence, Error, ExecutionScope};
use orkestr_v2_application::runtime::{ProviderAdmission, RuntimeStoreError};
use orkestr_v2_store_sqlite::{ConsumedProviderDispatch, Store};

pub(super) struct StoreFence {
    store: Store,
    #[cfg(all(test, feature = "fixture-test-controls"))]
    armed_store: std::sync::Mutex<Option<Store>>,
    provider: ProviderAdmission,
    scope: ExecutionScope,
}

impl StoreFence {
    // The binding/scope originates in the issuer capability, not caller IDs.
    pub(super) fn from_consumed(
        store: Store,
        cap: &ConsumedProviderDispatch,
    ) -> Result<Self, Error> {
        Ok(Self {
            store,
            #[cfg(all(test, feature = "fixture-test-controls"))]
            armed_store: std::sync::Mutex::new(None),
            provider: cap.provider().clone(),
            scope: super::execution_scope(cap)?,
        })
    }
    pub(super) fn from_renewal(
        store: Store,
        transition: &orkestr_v2_store_sqlite::RunLeaseTransition,
        scope: &ExecutionScope,
    ) -> Self {
        Self {
            store,
            #[cfg(all(test, feature = "fixture-test-controls"))]
            armed_store: std::sync::Mutex::new(None),
            provider: transition.current().clone(),
            scope: scope.clone(),
        }
    }
    // Arm the exact fence already owned by the attached child, after Prepared.
    // This seam is absent from all non-test builds, even with the feature set.
    #[cfg(all(test, feature = "fixture-test-controls"))]
    pub(super) async fn arm_post_action_rollback(&self, marker: std::path::PathBuf) {
        let mut store = self.store.clone();
        store
            .production_arm_checkpoint(
                orkestr_v2_store_sqlite::ProductionCheckpoint::ExecutionFenceAfterActionRollback,
                marker,
            )
            .await
            .unwrap();
        *self.armed_store.lock().unwrap() = Some(store);
    }
}

impl DispatchFence for StoreFence {
    fn dispatch(
        &self,
        scope: &ExecutionScope,
        action: &mut dyn FnMut() -> Result<(), Error>,
    ) -> Result<(), Error> {
        if scope != &self.scope {
            return Err(Error::WrongScope);
        }
        // BEGIN IMMEDIATE remains held across the bounded nonblocking action.
        // No inference replay follows an outer commit error after action ran.
        #[cfg(all(test, feature = "fixture-test-controls"))]
        let store = self
            .armed_store
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| self.store.clone());
        #[cfg(not(all(test, feature = "fixture-test-controls")))]
        let store = &self.store;
        store
            .with_execution_fence(&self.provider, action)
            .map_err(|error| match error {
                RuntimeStoreError::Unauthorized
                | RuntimeStoreError::NotFound
                | RuntimeStoreError::StaleLease
                | RuntimeStoreError::Fenced
                | RuntimeStoreError::Expired => Error::Revoked,
                _ => Error::Io,
            })?
    }
}
