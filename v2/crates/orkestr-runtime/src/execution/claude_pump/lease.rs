//! Same-turn Claude lease refresh; mirrors the Codex transfer. A transition
//! never carries inference authority and never writes a native frame.
use super::ClaudePump;
use crate::{
    containment::{Authority, Error},
    execution::fence::StoreFence,
};
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_store_sqlite::{RunRenewalAuthority, Store};
use std::sync::Arc;

impl ClaudePump {
    /// Check under the per-run scheduling lock before consuming the pump:
    /// the input is fully written, native identity is committed and no
    /// observation awaits its original receipt.
    pub fn renewal_quiescent(&self) -> bool {
        let source = &self.source;
        !source.failed
            && !source.eof
            && source.started
            && !source.completed
            && !source.pending_native
            && source.prepared
            && source.offset == source.bytes.len()
            && source.events.is_empty()
            && self.cursor.next_control_sequence().is_ok()
    }

    /// Consume on every outcome. Failed or uncertain renewal quarantines the
    /// owned process; the same native child keeps its turn and cursor.
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
        let (owner, child) = self
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
        Ok((owner, self))
    }
}
