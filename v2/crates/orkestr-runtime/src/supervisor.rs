//! Short async core transactions around nonblocking provider operations.
use crate::ports::{Blocker, InterruptControl, Provider};
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::{OwnerId, SessionId};

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Store(RuntimeStoreError),
    Provider(Blocker),
}

/// Admission is atomic in core; replay is NOT permission to dispatch again.
/// Candidate disposition is not provider permission. Until durable consumption is
/// implemented and accepted, no provider starts. Low-level fixtures are test-only.
pub async fn start<S: RuntimeStore, P: Provider>(
    store: &S,
    _provider: &mut P,
    claim: &InboxClaim,
    binding: &SessionId,
    expected_generation: u64,
    request_key: &str,
    expected_role: Role,
) -> std::result::Result<RunAdmission, Error> {
    // This port consumes only the canonical deep claim. Workers require a
    // separately reviewed admission port, not another consumption of this inbox.
    if expected_role != Role::Deep || binding != &claim.consumer_session_id {
        return Err(Error::Store(RuntimeStoreError::InvalidInput));
    }
    let result = store
        .admit_run(claim, binding, expected_generation, request_key)
        .await
        .map_err(Error::Store)?;
    let admission = &result.provider.run;
    let returned_binding = &result.provider.binding;
    if admission.owner_id != claim.owner_id
        || admission.conversation_id != claim.conversation_id
        || &admission.session_id != binding
        || admission.role != expected_role
        || admission.purpose != AdmissionPurpose::Execution
        || returned_binding.owner_id != admission.owner_id
        || returned_binding.conversation_id != admission.conversation_id
        || returned_binding.session_id != admission.session_id
        || returned_binding.role != admission.role
        || returned_binding.native_session_id != admission.native_session_id
    {
        return Err(Error::Store(RuntimeStoreError::InvalidInput));
    }
    match result.disposition {
        AdmissionDisposition::Replay | AdmissionDisposition::ReconciliationRequired => {
            return Err(Error::Provider(Blocker::DispatchUnconfirmed));
        }
        AdmissionDisposition::FreshCandidate => {
            if result.run_state != RunState::Starting
                || result.candidate_key.as_ref().is_none_or(String::is_empty)
            {
                return Err(Error::Store(RuntimeStoreError::InvalidInput));
            }
        }
    }
    // Never claim/consume a candidate until durable authority acceptance exists.
    Err(Error::Provider(Blocker::DispatchUnconfirmed))
}

/// Retain one cursor per run/attempt, including transient errors. Recovered runs
/// require reconciliation; a fresh cursor is not durable resume authority.
pub struct PendingObservation {
    admission: Option<ProviderAdmission>,
    next_sequence: u64,
    pending: Option<ProviderEventInput>,
    refused: Option<RuntimeStoreError>,
    rejected: Option<ProviderEventInput>,
}
impl Default for PendingObservation {
    fn default() -> Self {
        Self {
            admission: None,
            next_sequence: 1,
            pending: None,
            refused: None,
            rejected: None,
        }
    }
}
impl PendingObservation {
    pub(crate) fn next_control_sequence(&self) -> std::result::Result<u64, RuntimeStoreError> {
        if self.pending.is_some() || self.rejected.is_some() || self.refused.is_some() {
            return Err(RuntimeStoreError::Busy);
        }
        Ok(self.next_sequence)
    }
    pub fn pending(&self) -> Option<&ProviderEventInput> {
        self.pending.as_ref()
    }
    /// Bounded volatile evidence only; no rejected-evidence storage API exists.
    pub fn rejected(&self) -> Option<(&ProviderAdmission, &ProviderEventInput, RuntimeStoreError)> {
        Some((
            self.admission.as_ref()?,
            self.rejected.as_ref()?,
            self.refused?,
        ))
    }
}

pub async fn step<S: RuntimeStore, P: Provider>(
    store: &S,
    provider: &mut P,
    admission: &ProviderAdmission,
    cursor: &mut PendingObservation,
) -> std::result::Result<bool, Error> {
    let run = &admission.run;
    let binding = &admission.binding;
    if run.purpose != AdmissionPurpose::Execution
        || binding.owner_id != run.owner_id
        || binding.conversation_id != run.conversation_id
        || binding.session_id != run.session_id
        || binding.role != run.role
        || binding.native_session_id != run.native_session_id
    {
        return Err(Error::Store(RuntimeStoreError::InvalidInput));
    }
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
        let Some(event) = provider.poll(run).map_err(Error::Provider)? else {
            return Ok(false);
        };
        cursor.pending = Some(ProviderEventInput {
            run_id: run.run_id.clone(),
            session_id: run.session_id.clone(),
            lease_generation: run.lease_generation,
            dispatch_fence: run.dispatch_fence,
            sequence: cursor.next_sequence,
            event,
        });
    }
    let observation = cursor
        .pending
        .as_ref()
        .expect("pending observation set above");
    if !observation.is_bounded() {
        cursor.refused = Some(RuntimeStoreError::InvalidInput);
        return Err(Error::Store(RuntimeStoreError::InvalidInput));
    }
    match store
        .append_provider_event(&run.owner_id, admission, observation)
        .await
    {
        Ok(receipt) => {
            if receipt.sequence != observation.sequence {
                cursor.refused = Some(RuntimeStoreError::InvalidInput);
                return Err(Error::Store(RuntimeStoreError::InvalidInput));
            }
            cursor.pending = None;
            cursor.next_sequence = next;
            Ok(true)
        }
        Err(error) => {
            // Expired authority is a deliberate delivery discard, never an ACK
            // or permission to repoll, readmit or start another provider turn.
            if matches!(
                error,
                RuntimeStoreError::StaleLease
                    | RuntimeStoreError::Fenced
                    | RuntimeStoreError::Expired
            ) {
                cursor.rejected = cursor.pending.take();
            }
            if matches!(
                error,
                RuntimeStoreError::StaleLease
                    | RuntimeStoreError::Fenced
                    | RuntimeStoreError::Expired
                    | RuntimeStoreError::Unauthorized
                    | RuntimeStoreError::Conflict
                    | RuntimeStoreError::InvalidInput
                    | RuntimeStoreError::NotFound
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
) -> std::result::Result<(CancelReceipt, std::result::Result<(), Blocker>), RuntimeStoreError> {
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
