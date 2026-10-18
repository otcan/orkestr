//! Trusted factory adapter after authenticated cancellation has committed.
//! HTTP authentication and receipt lookup remain the route's responsibility.
use orkestr_runtime::{
    containment::Authority,
    execution::{CodexPump, StopFailure, StoppingCodex},
    ports::Blocker,
    supervisor,
};
use orkestr_v2_application::runtime::{
    CancelReceipt, ProviderEvent, ProviderEventInput, RuntimeStoreError,
};
use orkestr_v2_contracts::{OwnerId, RunId};
use orkestr_v2_store_sqlite::Store;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopProgress {
    Pending,
    InterruptAcknowledged,
    Stopped,
    ReconciliationRequired,
}

/// One registered run, one issued cancellation, one owned child. No Clone or
/// serialized constructor; an interrupt acknowledgement never becomes Stopped.
pub struct StopExecution {
    store: Store,
    authority: Authority,
    stopping: StoppingCodex,
    progress: StopProgress,
}
impl StopExecution {
    /// Trusted factory only. `owner` and `run` identify the factory's registered
    /// pump; the receipt must come from authenticated durable cancellation.
    pub fn begin(
        owner: &OwnerId,
        run: &RunId,
        store: Store,
        authority: Authority,
        pump: CodexPump,
        receipt: &CancelReceipt,
    ) -> Result<Self, StopFailure> {
        if &receipt.new_fenced_admission.owner_id != owner
            || &receipt.new_fenced_admission.run_id != run
        {
            let pending = pump.pending().cloned();
            let _ = authority.revoke();
            drop(pump);
            return Err(StopFailure {
                cause: Blocker::StaleLease,
                pending,
                terminal: None,
            });
        }
        match pump.into_stopping(store.clone(), receipt) {
            Ok(stopping) => Ok(Self {
                store,
                authority,
                stopping,
                progress: StopProgress::Pending,
            }),
            Err(error) => {
                let _ = authority.revoke();
                Err(error)
            }
        }
    }
    pub fn progress(&self) -> StopProgress {
        self.progress
    }
    pub fn pending(&self) -> Option<&ProviderEventInput> {
        self.stopping.pending()
    }
    pub fn retained(&self) -> &[ProviderEvent] {
        self.stopping.retained()
    }

    /// A bounded transport step. Transient persistence failures retain the exact
    /// pending event; this object is kept by the factory, never reconstructed.
    pub async fn tick(&mut self) -> StopProgress {
        if matches!(
            self.progress,
            StopProgress::Stopped | StopProgress::ReconciliationRequired
        ) {
            return self.progress;
        }
        // Once terminal evidence awaits storage, flush would unnecessarily
        // require live control authority before an authenticated committed replay.
        if self.stopping.pending().is_none() && self.stopping.flush().is_err() {
            return self.reconcile();
        }
        match self.stopping.step(&self.store).await {
            Ok(_) if self.stopping.stopped() => {
                self.progress = StopProgress::Stopped;
                let _ = self.authority.revoke();
            }
            Ok(_) => {
                self.progress = if self.stopping.acknowledged() {
                    StopProgress::InterruptAcknowledged
                } else {
                    StopProgress::Pending
                }
            }
            Err(supervisor::Error::Store(
                RuntimeStoreError::Busy | RuntimeStoreError::Unavailable,
            )) if self.stopping.pending().is_some() => {}
            Err(_) => return self.reconcile(),
        }
        self.progress
    }
    fn reconcile(&mut self) -> StopProgress {
        let _ = self.authority.revoke();
        self.progress = StopProgress::ReconciliationRequired;
        self.progress
    }
}
