//! Same-turn lease refresh. A transition never carries inference authority.
use super::{fence::StoreFence, CodexPump};
use crate::containment::{Authority, Error};
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_store_sqlite::{RunRenewalAuthority, Store};
use std::sync::Arc;

impl CodexPump {
    /// Trusted scheduling hint only; this timestamp grants no authority.
    pub fn lease_deadline_ms(&self) -> i64 {
        self.admission.run.lease_deadline_ms
    }

    /// Check under the same per-run lock as polling and cancellation before
    /// consuming the pump; pending evidence must receive its original receipt.
    pub fn renewal_quiescent(&self) -> bool {
        self.source.failed.is_none()
            && !self.source.eof
            && self.source.writing.is_none()
            && self.source.stream.renewal_quiescent()
            && self.cursor.next_control_sequence().is_ok()
    }

    /// Consume on every outcome. Failed or uncertain renewal quarantines the
    /// owned process; no new frame, spawn, or observation sequence is generated.
    pub async fn renew_lease(
        mut self,
        store: Store,
        authority: &mut RunRenewalAuthority,
    ) -> Result<(Authority, Self), RuntimeStoreError> {
        if !self.renewal_quiescent() {
            self.source.child.quarantine();
            return Err(RuntimeStoreError::Busy);
        }
        let transition = match store.renew_running(authority).await {
            Ok(transition) => transition,
            Err(error) => {
                self.source.child.quarantine();
                return Err(error);
            }
        };
        if transition.previous() != &self.admission
            || self.cursor.refresh_admission(&transition).is_err()
        {
            self.source.child.quarantine();
            return Err(RuntimeStoreError::Fenced);
        }
        let fence = Arc::new(StoreFence::from_renewal(
            store,
            &transition,
            &self.source.scope,
        ));
        let (authority, child) = self
            .source
            .child
            .refresh_lease_fence(&self.source.scope, fence)
            .map_err(|error| match error {
                Error::Revoked | Error::WrongScope => RuntimeStoreError::Fenced,
                _ => RuntimeStoreError::Unavailable,
            })?;
        self.source.child = child;
        self.source.admission = transition.current().run.clone();
        self.admission = transition.current().clone();
        Ok((authority, self))
    }
}
