//! Trusted fixed-purpose presentation scheduling. No inbox claim, source text,
//! role substitution, worker delegation or provider I/O is accepted here.
mod live;
mod session;
pub use live::LiveFast;
pub use session::{FastFailure, FastStart, PreparingFast, ReadyFast};

use orkestr_v2_application::runtime::{
    AdmissionDisposition, AdmissionPurpose, DispatchClaimResult, Role, RunAdmissionResult,
    RunState, RuntimeStore, RuntimeStoreError,
};
use orkestr_v2_store_sqlite::{
    ConsumedProviderDispatch, ExecutionConsumption, FastAdmissionInput, Store,
};

/// Absence of a fresh grant is explicit and must never trigger automatic replay.
pub enum FastDispatch {
    Consumed(Box<ConsumedProviderDispatch>),
    Replay,
    ReconciliationRequired,
}

fn validate(
    result: &RunAdmissionResult,
    input: &FastAdmissionInput,
) -> Result<(), RuntimeStoreError> {
    let provider = &result.provider;
    let run = &provider.run;
    let binding = &provider.binding;
    if run.role != Role::Fast
        || binding.role != Role::Fast
        || run.purpose != AdmissionPurpose::Execution
        || run.owner_id != binding.owner_id
        || run.conversation_id != binding.conversation_id
        || run.session_id != binding.session_id
        || run.native_session_id != binding.native_session_id
        || binding.native_session_id.is_none()
        || binding.session_id != input.fast_binding_id
        || binding.generation != input.expected_binding_generation
    {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}

/// Caller must obtain a distinct Ready Fast binding via Core metadata setup.
/// This function consumes only the canonical non-inbox issuer. An
/// Unavailable result propagates unchanged on older adapters; Deep admission is never attempted.
/// The returned capability still requires same-child attachment and actual fences.
pub async fn consume_fast(
    store: &Store,
    credential: &str,
    input: &FastAdmissionInput,
) -> Result<FastDispatch, RuntimeStoreError> {
    let admitted = store.admit_fast(credential, input).await?;
    consume_admitted(store, admitted, input).await
}

/// The rest of `consume_fast` after Core committed (or replayed) admission.
pub(crate) async fn consume_admitted(
    store: &Store,
    admitted: RunAdmissionResult,
    input: &FastAdmissionInput,
) -> Result<FastDispatch, RuntimeStoreError> {
    validate(&admitted, input)?;
    match admitted.disposition {
        AdmissionDisposition::Replay => return Ok(FastDispatch::Replay),
        AdmissionDisposition::ReconciliationRequired => {
            return Ok(FastDispatch::ReconciliationRequired);
        }
        AdmissionDisposition::FreshCandidate => {}
    }
    if admitted.run_state != RunState::Starting || admitted.candidate_key.is_none() {
        return Err(RuntimeStoreError::Fenced);
    }
    // Distinct request namespaces keep immutable issuance and reservation keys
    // deterministic without widening the Core request-key bound.
    let reservation = store
        .claim_provider_dispatch(&admitted, &input.request_key)
        .await?;
    let DispatchClaimResult::Reserved(reservation) = reservation else {
        return Ok(match reservation {
            DispatchClaimResult::Replay => FastDispatch::Replay,
            _ => FastDispatch::ReconciliationRequired,
        });
    };
    match store.consume_execution(&reservation).await? {
        ExecutionConsumption::Dispatch(cap) => Ok(FastDispatch::Consumed(cap)),
        ExecutionConsumption::ReconciliationRequired => Ok(FastDispatch::ReconciliationRequired),
    }
}
