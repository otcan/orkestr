//! Same-turn lease refresh. A transition never carries inference authority.
use super::{
    fence::StoreFence,
    renewal_refusal::{QuarantineOwned, RenewalRefusal},
    CodexPump,
};
use crate::containment::{Authority, Error};
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_store_sqlite::{
    CodexSteeringAuthority, RunLeaseTransition, RunRenewalAuthority, Store,
};
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
            && self.source.steering.is_none()
            && self.pending_offline_python().is_none()
            && self.pending_workspace_exec().is_none()
            && self.source.tool_write.is_none()
            && self.source.workspace_write.is_none()
            && self.source.stream.renewal_quiescent()
            && self.cursor.next_control_sequence().is_ok()
    }

    /// Consume on every outcome but one. A failed or uncertain renewal
    /// quarantines the owned process; no new frame, spawn, or observation
    /// sequence is generated. Only when Core wrote nothing (`Busy`) does the
    /// untouched pump come back as `RenewalRefusal::Retry`.
    pub async fn renew_lease(
        self,
        store: Store,
        authority: &mut RunRenewalAuthority,
    ) -> Result<(Authority, Self), RenewalRefusal<Self>> {
        let (owner, pump, _) = self.renew_lease_transition(store, authority).await?;
        Ok((owner, pump))
    }

    /// Refresh the captured issuer only after the actual same-child fence has
    /// transferred successfully. Any subsequent refusal quarantines that child.
    /// A `Retry` returns the issuer with the pump, both unchanged.
    pub async fn renew_lease_with_steering(
        self,
        store: Store,
        authority: &mut RunRenewalAuthority,
        steering: CodexSteeringAuthority,
    ) -> Result<
        (Authority, Self, CodexSteeringAuthority),
        RenewalRefusal<(Self, CodexSteeringAuthority)>,
    > {
        if steering.provider() != &self.admission {
            self.source.child.quarantine();
            return Err(RenewalRefusal::Lost(RuntimeStoreError::Fenced));
        }
        let (owner, pump, transition) =
            match self.renew_lease_transition(store.clone(), authority).await {
                Ok(renewed) => renewed,
                Err(RenewalRefusal::Retry { retained, error }) => {
                    return Err(RenewalRefusal::Retry {
                        retained: Box::new((*retained, steering)),
                        error,
                    })
                }
                Err(RenewalRefusal::Lost(error)) => return Err(RenewalRefusal::Lost(error)),
            };
        match store.refresh_codex_steering(steering, &transition).await {
            Ok(steering) => Ok((owner, pump, steering)),
            Err(error) => {
                pump.source.child.quarantine();
                Err(RenewalRefusal::Lost(error))
            }
        }
    }

    async fn renew_lease_transition(
        mut self,
        store: Store,
        authority: &mut RunRenewalAuthority,
    ) -> Result<(Authority, Self, RunLeaseTransition), RenewalRefusal<Self>> {
        if !self.renewal_quiescent() {
            self.source.child.quarantine();
            return Err(RenewalRefusal::Lost(RuntimeStoreError::Busy));
        }
        // This SQL future is large in debug builds. Keeping it out of the
        // owned-pump transfer state also bounds every enclosing steering/run
        // poll frame; the exact same typed renewal and failure path apply.
        let transition = match Box::pin(store.renew_running(authority)).await {
            Ok(transition) => transition,
            // Core wrote nothing; the child keeps its current lease and fence.
            Err(RuntimeStoreError::Busy) => {
                return Err(RenewalRefusal::Retry {
                    retained: Box::new(self),
                    error: RuntimeStoreError::Busy,
                })
            }
            Err(error) => {
                self.source.child.quarantine();
                return Err(RenewalRefusal::Lost(error));
            }
        };
        if transition.previous() != &self.admission
            || self.cursor.refresh_admission(&transition).is_err()
        {
            self.source.child.quarantine();
            return Err(RenewalRefusal::Lost(RuntimeStoreError::Fenced));
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
            .map_err(|error| {
                RenewalRefusal::Lost(match error {
                    Error::Revoked | Error::WrongScope => RuntimeStoreError::Fenced,
                    _ => RuntimeStoreError::Unavailable,
                })
            })?;
        self.source.child = child;
        self.source.admission = transition.current().run.clone();
        self.admission = transition.current().clone();
        Ok((authority, self, transition))
    }
}

impl QuarantineOwned for CodexPump {
    fn quarantine_owned(self) {
        self.source.child.quarantine();
    }
}

impl QuarantineOwned for (CodexPump, CodexSteeringAuthority) {
    fn quarantine_owned(self) {
        self.0.quarantine_owned();
    }
}
