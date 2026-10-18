//! Short async core transactions around nonblocking provider operations.
use crate::ports::{Blocker, InterruptControl, Provider};
use orkestr_v2_application::runtime::{RuntimeStore, RuntimeStoreError};
use orkestr_v2_contracts::{runtime::*, OwnerId, SessionId};

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Store(RuntimeStoreError),
    Provider(Blocker),
}

/// Admission is atomic in core; replay is NOT permission to dispatch again.
/// Until core returns a per-call dispatch disposition, this path never starts
/// a provider. Low-level fixture commands remain explicitly test-only.
pub async fn start<S: RuntimeStore, P: Provider>(
    store: &S,
    _provider: &mut P,
    claim: &InboxClaim,
    binding: &SessionId,
    expected_generation: u64,
    request_key: &str,
    expected_role: Role,
) -> Result<RunAdmission, Error> {
    let admission = store
        .admit_run(claim, binding, expected_generation, request_key)
        .await
        .map_err(Error::Store)?;
    if admission.owner_id != claim.owner_id
        || admission.conversation_id != claim.conversation_id
        || &admission.session_id != binding
        || admission.role != expected_role
        || admission.purpose != AdmissionPurpose::Execution
    {
        return Err(Error::Store(RuntimeStoreError::InvalidInput));
    }
    Err(Error::Provider(Blocker::DispatchUnconfirmed))
}

/// Retain one cursor per run/attempt, including transient errors. Recovered runs
/// require reconciliation; a fresh cursor is not durable resume authority.
pub struct PendingObservation {
    admission: Option<RunAdmission>,
    next_sequence: u64,
    pending: Option<ProviderObservation>,
    refused: Option<RuntimeStoreError>,
}
impl Default for PendingObservation {
    fn default() -> Self {
        Self {
            admission: None,
            next_sequence: 1,
            pending: None,
            refused: None,
        }
    }
}
impl PendingObservation {
    pub fn pending(&self) -> Option<&ProviderObservation> {
        self.pending.as_ref()
    }
}

pub async fn step<S: RuntimeStore, P: Provider>(
    store: &S,
    provider: &mut P,
    admission: &RunAdmission,
    cursor: &mut PendingObservation,
) -> Result<bool, Error> {
    if let Some(original) = &cursor.admission {
        if original != admission {
            return Err(Error::Store(RuntimeStoreError::StaleLease));
        }
    } else {
        cursor.admission = Some(admission.clone());
    }
    if let Some(refusal) = cursor.refused {
        return Err(Error::Store(refusal));
    }
    let next = cursor
        .next_sequence
        .checked_add(1)
        .ok_or(Error::Store(RuntimeStoreError::InvalidInput))?;
    if cursor.pending.is_none() {
        let Some(kind) = provider.poll(admission).map_err(Error::Provider)? else {
            return Ok(false);
        };
        cursor.pending = Some(ProviderObservation {
            source_event_key: format!(
                "runtime:{}:{}:{}:{}",
                admission.run_id,
                admission.attempt,
                admission.lease_generation,
                cursor.next_sequence
            ),
            run_id: admission.run_id.clone(),
            session_id: admission.session_id.clone(),
            lease_generation: admission.lease_generation,
            kind,
        });
    }
    let observation = cursor
        .pending
        .as_ref()
        .expect("pending observation set above");
    if !observation.payload_is_bounded()
        || (admission.purpose == AdmissionPurpose::CancellationAcknowledgement
            && observation.kind != ObservationKind::Stopped)
    {
        return Err(Error::Store(RuntimeStoreError::InvalidInput));
    }
    match store
        .record_observation(admission, &observation.source_event_key, observation)
        .await
    {
        Ok(_) => {
            cursor.pending = None;
            cursor.next_sequence = next;
            Ok(true)
        }
        Err(error) => {
            // Expired authority is a deliberate delivery discard, never an ACK
            // or permission to repoll, readmit or start another provider turn.
            if matches!(
                error,
                RuntimeStoreError::StaleLease | RuntimeStoreError::Expired
            ) {
                cursor.pending = None;
            }
            if matches!(
                error,
                RuntimeStoreError::StaleLease
                    | RuntimeStoreError::Expired
                    | RuntimeStoreError::Unauthorized
                    | RuntimeStoreError::Conflict
            ) {
                cursor.refused = Some(error);
            }
            Err(Error::Store(error))
        }
    }
}

/// Preserve core's exact receipt and uncertain in-flight status after failure.
pub async fn cancel<S: RuntimeStore, P: Provider>(
    store: &S,
    provider: &mut P,
    owner: &OwnerId,
    original: &RunAdmission,
    request_key: &str,
) -> Result<(CancelReceipt, Result<(), Blocker>), RuntimeStoreError> {
    if &original.owner_id != owner || original.purpose != AdmissionPurpose::Execution {
        return Err(RuntimeStoreError::InvalidInput);
    }
    let receipt = store
        .request_cancel(owner, &original.run_id, request_key)
        .await?;
    let token = &receipt.new_fenced_admission;
    if token.owner_id != original.owner_id
        || token.conversation_id != original.conversation_id
        || token.run_id != original.run_id
        || token.session_id != original.session_id
        || token.role != original.role
        || token.native_session_id != original.native_session_id
        || token.attempt != original.attempt
        || token.purpose != AdmissionPurpose::CancellationAcknowledgement
        || token.lease_generation <= original.lease_generation
        || token.dispatch_fence <= original.dispatch_fence
    {
        return Err(RuntimeStoreError::InvalidInput);
    }
    // Already cancelled before dispatch needs no provider interrupt.
    let result = if receipt.inflight_status == InflightStatus::NotDispatched
        && receipt.state == RunState::Cancelled
    {
        Ok(())
    } else {
        provider.interrupt(&InterruptControl {
            original: original.clone(),
            cancellation: token.clone(),
        })
    };
    Ok((receipt, result))
}
