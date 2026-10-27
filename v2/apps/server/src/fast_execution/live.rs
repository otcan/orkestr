//! One private Fast transport; every continuation consumes a fresh Core grant.
use super::{consume_fast, FastDispatch, FastFailure, FastStart};
use crate::control_dispatch::{ActiveControl, PendingControl};
use orkestr_runtime::{
    containment::{Authority, RetiringBroker},
    execution::{CodexPump, StopFailure},
    ports::Blocker,
    supervisor,
};
use orkestr_v2_application::runtime::{ProviderAdmission, ProviderEventInput, RuntimeStoreError};
use orkestr_v2_contracts::{ExecutionPhase, RunId};
use orkestr_v2_store_sqlite::{FastAdmissionInput, RunRenewalAuthority, Store};

struct OwnedFast {
    authority: Authority,
    pump: CodexPump,
    renewal: RunRenewalAuthority,
}

pub struct LiveFast {
    store: Store,
    // Immutable binding/source identity, not a renewed execution grant.
    provider: ProviderAdmission,
    owned: Option<OwnedFast>,
}

impl LiveFast {
    pub(super) fn new(
        store: Store,
        provider: ProviderAdmission,
        renewal: RunRenewalAuthority,
        authority: Authority,
        pump: CodexPump,
    ) -> Self {
        Self {
            store,
            provider,
            owned: Some(OwnedFast {
                authority,
                pump,
                renewal,
            }),
        }
    }

    pub fn run_id(&self) -> &RunId {
        &self.provider.run.run_id
    }

    pub(crate) fn check_broker_liveness(&self) -> Result<(), &'static str> {
        self.owned
            .as_ref()
            .ok_or("Fast transport is missing")?
            .pump
            .check_broker_liveness()
            .map_err(|_| "Fast broker exited")
    }

    pub fn pending(&self) -> Option<&ProviderEventInput> {
        self.owned.as_ref().and_then(|owned| owned.pump.pending())
    }

    pub fn renewal_quiescent(&self) -> bool {
        self.owned
            .as_ref()
            .is_some_and(|owned| owned.pump.renewal_quiescent())
    }

    /// Local scheduling hint only; zero denotes a consumed/failed wrapper.
    pub fn lease_deadline_ms(&self) -> i64 {
        self.owned
            .as_ref()
            .map_or(0, |owned| owned.pump.lease_deadline_ms())
    }

    /// Caller serializes this bounded step with Stop and renewal. Pending durable
    /// evidence must receive its original receipt before more native I/O.
    pub async fn tick(&mut self) -> Result<bool, supervisor::Error> {
        let owned = self
            .owned
            .as_mut()
            .ok_or(supervisor::Error::Provider(Blocker::Protocol))?;
        if owned.pump.pending().is_none() && owned.pump.flush().is_err() {
            let _ = owned.authority.revoke();
            return Err(supervisor::Error::Provider(Blocker::Protocol));
        }
        owned.pump.step(&self.store).await
    }

    /// Same live child/turn only. The factory enforces its finite run budget and
    /// owns the same scheduling lock as HTTP Stop. Core rechecks current Running,
    /// original machine authentication, context and unexpired lease atomically.
    pub async fn renew(&mut self) -> Result<(), FastFailure> {
        if !self.renewal_quiescent() {
            return Err(FastFailure::Store(RuntimeStoreError::Busy));
        }
        let OwnedFast {
            authority,
            pump,
            mut renewal,
        } = self
            .owned
            .take()
            .ok_or(FastFailure::Store(RuntimeStoreError::Fenced))?;
        let (next_authority, next_pump) = pump
            .renew_lease(self.store.clone(), &mut renewal)
            .await
            .map_err(FastFailure::Store)?;
        // Runtime has atomically retired the old owner; its Drop cannot signal
        // the transferred child. Failed transfers return no executable pump.
        drop(authority);
        self.owned = Some(OwnedFast {
            authority: next_authority,
            pump: next_pump,
            renewal,
        });
        Ok(())
    }

    async fn accepted(&self, credential: &str) -> Result<(), FastFailure> {
        let prior = &self.provider.run;
        let current = self
            .store
            .execution_run_status(
                credential,
                &prior.owner_id,
                &prior.conversation_id,
                &prior.run_id,
            )
            .await
            .map_err(FastFailure::Store)?
            .ok_or(FastFailure::Store(RuntimeStoreError::Fenced))?;
        if current.phase != ExecutionPhase::Completed
            || current.run_id.as_ref() != Some(&prior.run_id)
        {
            return Err(FastFailure::Store(RuntimeStoreError::Fenced));
        }
        Ok(())
    }

    /// Owner acceptance is a prerequisite, never synthesized by this wrapper.
    /// Every outcome consumes the previous owner. Wrong binding, replay and
    /// uncertainty cannot return a capability or start a replacement process.
    pub async fn continue_accepted(
        mut self,
        credential: &str,
        input: &FastAdmissionInput,
    ) -> Result<FastStart, FastFailure> {
        self.accepted(credential).await?;
        let previous = &self.provider.binding;
        if input.fast_binding_id != previous.session_id
            || previous.generation.checked_add(1) != Some(input.expected_binding_generation)
        {
            return Err(FastFailure::Store(RuntimeStoreError::Fenced));
        }
        let capability = match consume_fast(&self.store, credential, input)
            .await
            .map_err(FastFailure::Store)?
        {
            FastDispatch::Consumed(cap) => cap,
            FastDispatch::Replay => return Ok(FastStart::Replay),
            FastDispatch::ReconciliationRequired => return Ok(FastStart::ReconciliationRequired),
        };
        let provider = capability.provider().clone();
        let renewal = self
            .store
            .authorize_running_renewal(&capability)
            .await
            .map_err(FastFailure::Store)?;
        let OwnedFast {
            authority, pump, ..
        } = self
            .owned
            .take()
            .ok_or(FastFailure::Store(RuntimeStoreError::Fenced))?;
        let (next_authority, next_pump) = pump
            .attach_next_fast(self.store.clone(), capability)
            .map_err(FastFailure::Submission)?;
        drop(authority);
        Ok(FastStart::Live(Box::new(Self::new(
            self.store.clone(),
            provider,
            renewal,
            next_authority,
            next_pump,
        ))))
    }

    /// Only an existing typed Core cancellation can enter this path. ACK alone
    /// cannot settle or retire; ActiveControl requires genuine Stopped evidence.
    pub fn stopping(mut self, pending: PendingControl) -> Result<ActiveControl, StopFailure> {
        let owned = self.owned.take().ok_or(StopFailure {
            cause: Blocker::Protocol,
            pending: None,
            terminal: None,
        })?;
        pending.dispatch_retiring(owned.authority, owned.pump)
    }

    /// Negative cleanup first; root still must wait for the exact reaped witness
    /// before asking Core to record graceful retirement/recovery eligibility.
    pub async fn retire_accepted(
        mut self,
        credential: &str,
    ) -> Result<RetiringBroker, FastFailure> {
        self.accepted(credential).await?;
        let owned = self
            .owned
            .take()
            .ok_or(FastFailure::Store(RuntimeStoreError::Fenced))?;
        let retiring = owned.pump.retire_broker().map_err(FastFailure::Transport)?;
        drop(owned.authority);
        Ok(retiring)
    }

    /// Idle accepted state only: has the retained broker exited (for example
    /// after its native was OOM-killed)? Pure observation, no quarantine, so
    /// the original child can still be claimed by `retire_ended_accepted`.
    pub(crate) fn idle_broker_exited(&self) -> bool {
        self.owned
            .as_ref()
            .is_none_or(|owned| !matches!(owned.pump.broker_exited(), Ok(false)))
    }

    /// The accepted broker already exited on its own. Claims its exact
    /// native-ended ECHILD status as retirement evidence; any other status
    /// refuses (and dropping the transport quarantines as before).
    pub async fn retire_ended_accepted(
        mut self,
        credential: &str,
    ) -> Result<RetiringBroker, FastFailure> {
        self.accepted(credential).await?;
        let owned = self
            .owned
            .take()
            .ok_or(FastFailure::Store(RuntimeStoreError::Fenced))?;
        let retiring = owned
            .pump
            .retire_ended_broker()
            .map_err(FastFailure::Transport)?;
        drop(owned.authority);
        Ok(retiring)
    }

    /// Window expiry removes transport authority while a genuine proposal stays
    /// pending. This supplies only original-child cleanup, never acceptance.
    pub(crate) async fn retire_for_owner_decision(
        mut self,
        credential: &str,
    ) -> Result<RetiringBroker, FastFailure> {
        let run = &self.provider.run;
        let current = self
            .store
            .execution_run_status(credential, &run.owner_id, &run.conversation_id, &run.run_id)
            .await
            .map_err(FastFailure::Store)?
            .ok_or(FastFailure::Store(RuntimeStoreError::Fenced))?;
        if current.run_id.as_ref() != Some(&run.run_id)
            || !matches!(
                current.phase,
                ExecutionPhase::AwaitingAcceptance | ExecutionPhase::Completed
            )
        {
            return Err(FastFailure::Store(RuntimeStoreError::Fenced));
        }
        let owned = self
            .owned
            .take()
            .ok_or(FastFailure::Store(RuntimeStoreError::Fenced))?;
        let retiring = owned.pump.retire_broker().map_err(FastFailure::Transport)?;
        drop(owned.authority);
        Ok(retiring)
    }

    /// Cleanup is negative authority, never terminal truth or owner acceptance.
    pub fn quarantine(&mut self) {
        if let Some(owned) = &self.owned {
            let _ = owned.authority.revoke();
        }
    }
}

impl Drop for LiveFast {
    fn drop(&mut self) {
        self.quarantine();
    }
}
