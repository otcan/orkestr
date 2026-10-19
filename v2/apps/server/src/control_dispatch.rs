//! One durable cancellation handoff per exact owned run. This module issues no
//! control record, execution grant, lease or request key. Receipt fields alone
//! are not authority: Runtime rechecks Core's current fence before native I/O.
use crate::stop_execution::StopExecution;
pub use crate::stop_execution::StopProgress;
use orkestr_runtime::{
    containment::Authority,
    execution::{CodexPump, StopFailure},
};
use orkestr_v2_application::runtime::{
    AdmissionPurpose, CancelReceipt, ProviderEvent, ProviderEventInput,
};
use orkestr_v2_contracts::{ConversationId, OwnerId, RunId};
use orkestr_v2_store_sqlite::Store;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandoffError {
    WrongScope,
    Conflict,
    Closed,
    Unavailable,
}

struct Mailbox {
    owner: OwnerId,
    conversation: ConversationId,
    run: RunId,
    open: bool,
    receipt: Option<CancelReceipt>,
}

/// Trusted route wiring only. Clone before awaiting authentication; this type
/// holds no lock across an await and grants no access to another run.
#[derive(Clone)]
pub struct ControlSender {
    shared: Arc<Mutex<Mailbox>>,
}

/// Owned by the exact run's lifecycle. Neither Clone nor Deserialize; a receipt
/// can be taken once even when authenticated requests replay concurrently.
pub struct ControlReceiver {
    shared: Arc<Mutex<Mailbox>>,
    store: Store,
    taken: bool,
}

pub fn mailbox(
    store: Store,
    owner: OwnerId,
    conversation: ConversationId,
    run: RunId,
) -> Result<(ControlSender, ControlReceiver), HandoffError> {
    if owner.0.is_nil() || conversation.0.is_nil() || run.0.is_nil() {
        return Err(HandoffError::WrongScope);
    }
    let shared = Arc::new(Mutex::new(Mailbox {
        owner,
        conversation,
        run,
        open: true,
        receipt: None,
    }));
    Ok((
        ControlSender {
            shared: Arc::clone(&shared),
        },
        ControlReceiver {
            shared,
            store,
            taken: false,
        },
    ))
}

impl ControlSender {
    pub fn is_open(&self) -> bool {
        self.shared.lock().is_ok_and(|mailbox| mailbox.open)
    }

    /// Publish only the exact receipt returned by Core's committed authenticated
    /// cancellation. Identical replay succeeds after take or receiver cleanup,
    /// without redelivery. A first publish to a closed receiver refuses, even
    /// though the caller's durable cancellation may already have committed.
    pub fn publish(&self, receipt: CancelReceipt) -> Result<(), HandoffError> {
        let mut mailbox = self.shared.lock().map_err(|_| HandoffError::Unavailable)?;
        let admission = &receipt.new_fenced_admission;
        if admission.owner_id != mailbox.owner
            || admission.conversation_id != mailbox.conversation
            || admission.run_id != mailbox.run
            || admission.purpose != AdmissionPurpose::CancellationAcknowledgement
        {
            return Err(HandoffError::WrongScope);
        }
        if let Some(original) = &mailbox.receipt {
            return if original == &receipt {
                Ok(())
            } else {
                Err(HandoffError::Conflict)
            };
        }
        if !mailbox.open {
            return Err(HandoffError::Closed);
        }
        mailbox.receipt = Some(receipt);
        Ok(())
    }
}

impl ControlReceiver {
    pub fn take(&mut self) -> Result<Option<PendingControl>, HandoffError> {
        if self.taken {
            return Ok(None);
        }
        let mailbox = self.shared.lock().map_err(|_| HandoffError::Unavailable)?;
        let Some(receipt) = mailbox.receipt.as_ref() else {
            return Ok(None);
        };
        self.taken = true;
        Ok(Some(PendingControl {
            store: self.store.clone(),
            receipt: receipt.clone(),
        }))
    }
}

impl Drop for ControlReceiver {
    fn drop(&mut self) {
        if let Ok(mut mailbox) = self.shared.lock() {
            mailbox.open = false;
        }
    }
}

/// No caller constructor, Clone, Deserialize, native identity or secret Debug.
/// Handoff is not an enduring authority: Runtime rechecks Core's cancellation
/// fence at enqueue and every actual native write after this handle is consumed.
pub struct PendingControl {
    store: Store,
    receipt: CancelReceipt,
}

impl PendingControl {
    /// Provider-specific adapters consume this private handoff without exposing
    /// a receipt constructor or depending on another provider in this mailbox.
    pub(crate) fn dispatch_provider<T>(
        self,
        dispatch: impl FnOnce(&CancelReceipt) -> Result<T, StopFailure>,
    ) -> Result<T, StopFailure> {
        dispatch(&self.receipt)
    }

    /// One-way move of the exact already-owned child into native interruption.
    /// A wrong pump or stale control is quarantined, never returned for execution.
    pub fn dispatch(
        self,
        authority: Authority,
        pump: CodexPump,
    ) -> Result<ActiveControl, StopFailure> {
        self.dispatch_mode(authority, pump, false)
    }

    /// Deep recovery only, with the reviewed descendant-aware broker package.
    /// Worker callers retain `dispatch` and its immediate terminal cleanup.
    pub fn dispatch_retiring(
        self,
        authority: Authority,
        pump: CodexPump,
    ) -> Result<ActiveControl, StopFailure> {
        self.dispatch_mode(authority, pump, true)
    }

    fn dispatch_mode(
        self,
        authority: Authority,
        pump: CodexPump,
        retain_terminal: bool,
    ) -> Result<ActiveControl, StopFailure> {
        let stopping = StopExecution::begin(
            &self.receipt.new_fenced_admission.owner_id,
            &self.receipt.new_fenced_admission.run_id,
            self.store,
            authority,
            pump,
            &self.receipt,
        )?;
        let stopping = if retain_terminal {
            stopping.retaining_terminal()
        } else {
            stopping
        };
        Ok(ActiveControl {
            stopping: Some(stopping),
            deadline: Instant::now() + Duration::from_secs(2),
            progress: StopProgress::Pending,
            pending: None,
            retained: Vec::new(),
            retain_terminal,
        })
    }
}

/// Shared Deep/Worker lifecycle; ACK alone never reports Stopped. The same
/// object survives transient persistence failure. The two-second deadline is
/// checked between bounded steps, not a hard deadline inside a Store operation.
/// Expiry requires reconciliation and never reports successful termination.
pub struct ActiveControl {
    stopping: Option<StopExecution>,
    deadline: Instant,
    progress: StopProgress,
    pending: Option<ProviderEventInput>,
    retained: Vec<ProviderEvent>,
    retain_terminal: bool,
}

impl ActiveControl {
    /// Consume only this exact committed Stopped handoff. ACK, timeout, signal
    /// death and an ordinary broker exit can never become replacement evidence.
    pub fn retire_broker(
        mut self,
    ) -> Result<orkestr_runtime::containment::RetiringBroker, orkestr_runtime::containment::Error>
    {
        if !self.retain_terminal || self.progress != StopProgress::Stopped {
            return Err(orkestr_runtime::containment::Error::AuthorityProtocol);
        }
        self.stopping
            .take()
            .ok_or(orkestr_runtime::containment::Error::AuthorityProtocol)?
            .retire_broker()
    }
    pub fn pending(&self) -> Option<&ProviderEventInput> {
        self.stopping
            .as_ref()
            .and_then(StopExecution::pending)
            .or(self.pending.as_ref())
    }
    pub fn retained(&self) -> &[ProviderEvent] {
        self.stopping
            .as_ref()
            .map_or(&self.retained, StopExecution::retained)
    }
    pub async fn tick(&mut self) -> StopProgress {
        if matches!(
            self.progress,
            StopProgress::Stopped | StopProgress::ReconciliationRequired
        ) {
            return self.progress;
        }
        if let Some(stopping) = self.stopping.as_mut() {
            self.progress = if Instant::now() >= self.deadline {
                StopProgress::ReconciliationRequired
            } else {
                stopping.tick().await
            };
            if matches!(
                self.progress,
                StopProgress::Stopped | StopProgress::ReconciliationRequired
            ) {
                self.pending = stopping.pending().cloned();
                self.retained = stopping.retained().to_vec();
                // Initiates owned cleanup; Runtime retains process/reaper
                // ownership. No successful native termination is inferred here.
                if !self.retain_terminal || self.progress == StopProgress::ReconciliationRequired {
                    self.stopping = None;
                }
            }
        }
        self.progress
    }
}
