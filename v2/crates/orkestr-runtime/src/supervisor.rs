//! Asynchronous core transactions surround prompt, nonblocking provider commands.
use crate::ports::{Blocker, InterruptControl, Provider, ProviderAdmission};
use orkestr_v2_application::runtime::{
    CancelReceipt, ProviderEventInput, RunAdmission, RuntimeStore, RuntimeStoreError,
};
use orkestr_v2_contracts::{runtime::SessionRole, OwnerId};

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Store(RuntimeStoreError),
    Provider(Blocker),
}

/// Admission alone does not prove authoritative role or fresh dispatch in port v0.
/// Keep provider dispatch blocked until core supplies both guarantees.
pub async fn start<S: RuntimeStore, P: Provider>(
    store: &S,
    _provider: &mut P,
    owner: &OwnerId,
    input: &RunAdmission,
    _role: SessionRole,
) -> Result<ProviderAdmission, Error> {
    let _run = store.admit_run(owner, input).await.map_err(Error::Store)?;
    Err(Error::Provider(Blocker::DispatchUnconfirmed))
}

/// One volatile cursor per run, retained across calls. This is not crash durability.
/// Recovered runs require core reconciliation, never a fresh default cursor.
/// Unavailable includes a committed write whose acknowledgement was lost. Retain
/// the exact sequence and body: retry must return the original durable receipt.
pub struct PendingObservation {
    binding: Option<(OwnerId, ProviderAdmission)>,
    next_sequence: i64,
    pending: Option<ProviderEventInput>,
    refused: Option<RuntimeStoreError>,
}
impl Default for PendingObservation {
    fn default() -> Self {
        Self {
            binding: None,
            next_sequence: 1,
            pending: None,
            refused: None,
        }
    }
}
impl PendingObservation {
    /// A refused observation remains available for explicit reconciliation.
    pub fn pending(&self) -> Option<&ProviderEventInput> {
        self.pending.as_ref()
    }
}

pub async fn step<S: RuntimeStore, P: Provider>(
    store: &S,
    provider: &mut P,
    owner: &OwnerId,
    admission: &ProviderAdmission,
    cursor: &mut PendingObservation,
) -> Result<bool, Error> {
    if let Some((original_owner, original)) = &cursor.binding {
        if original_owner != owner || original != admission {
            return Err(Error::Store(RuntimeStoreError::StaleLease));
        }
    } else {
        cursor.binding = Some((owner.clone(), admission.clone()));
    }
    if let Some(refusal) = cursor.refused {
        return Err(Error::Store(refusal));
    }
    let next = cursor
        .next_sequence
        .checked_add(1)
        .ok_or(Error::Store(RuntimeStoreError::InvalidInput))?;
    if cursor.pending.is_none() {
        let Some(event) = provider.poll(admission).map_err(Error::Provider)? else {
            return Ok(false);
        };
        cursor.pending = Some(ProviderEventInput {
            run_id: admission.run_id.clone(),
            session_id: admission.session_id.clone(),
            lease_generation: admission.lease_generation,
            fence_generation: admission.fence_generation,
            provider_sequence: cursor.next_sequence,
            event,
        });
    }
    let input = cursor
        .pending
        .as_ref()
        .expect("pending observation set above");
    match store.append_provider_event(owner, input).await {
        Ok(receipt) => {
            if receipt.run.run_id != input.run_id || receipt.run.session_id != input.session_id {
                return Err(Error::Store(RuntimeStoreError::InvalidInput));
            }
            cursor.pending = None;
            cursor.next_sequence = next;
            Ok(true)
        }
        Err(error) => {
            if matches!(
                error,
                RuntimeStoreError::StaleLease | RuntimeStoreError::Fenced
            ) {
                cursor.refused = Some(error);
            }
            Err(Error::Store(error))
        }
    }
}

/// Return the persisted receipt even when interrupt is unsupported or fails.
/// The provider never receives the cancellation fence as an execution admission.
pub async fn cancel<S: RuntimeStore, P: Provider>(
    store: &S,
    provider: &mut P,
    owner: &OwnerId,
    admission: &ProviderAdmission,
    expected_version: i64,
) -> Result<(CancelReceipt, Result<(), Blocker>), RuntimeStoreError> {
    let receipt = store
        .request_cancel(owner, &admission.run_id, expected_version)
        .await?;
    if receipt.run.run_id != admission.run_id
        || receipt.run.session_id != admission.session_id
        || receipt.run.fence_generation < admission.fence_generation
    {
        return Err(RuntimeStoreError::InvalidInput);
    }
    let control = InterruptControl::for_admission(admission, receipt.run.fence_generation);
    let result = provider.interrupt(&control);
    Ok((receipt, result))
}
