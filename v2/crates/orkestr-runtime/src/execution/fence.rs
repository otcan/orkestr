//! Durable freshness only; this object cannot authorize an inference frame.
use crate::containment::{DispatchFence, Error, ExecutionScope};
use orkestr_v2_application::runtime::{ProviderAdmission, RuntimeStoreError};
use orkestr_v2_store_sqlite::{ConsumedProviderDispatch, Store};

pub(super) struct StoreFence {
    store: Store,
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
            provider: cap.provider().clone(),
            scope: super::execution_scope(cap)?,
        })
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
        self.store
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
