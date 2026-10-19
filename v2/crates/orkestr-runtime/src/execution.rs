//! By-value bridge from Core's committed dispatch to the owned transport.
//! This does not construct a supervisor, credentials, or a permissive fence.
pub(crate) mod cancellation_fence;
mod claude_pump;
mod claude_session;
mod fence;
mod lease_refresh;
mod provider_write;
mod pump;
mod reuse;
mod session;
pub use claude_pump::ClaudePump;
pub use claude_session::{PreparingClaude, ReadyClaude};
pub use pump::{CodexPump, StopFailure, StoppingCodex};
pub use session::{PreparingCodex, ReadyCodex, SetupFailure};
#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod tests;
use crate::{
    codex_rpc::CodexRpc,
    containment::{ConsumedTurn, ExecutionScope, OwnedChild},
    ports::Blocker,
};
use orkestr_v2_application::runtime::{AdmissionPurpose, ProviderKind};
use orkestr_v2_store_sqlite::ConsumedProviderDispatch;
use serde_json::json;

/// Failure after durable consumption is uncertain delivery, never a retry grant.
#[derive(Debug, PartialEq, Eq)]
pub enum SubmissionFailure {
    Protocol(Blocker),
    Transport(crate::containment::Error),
}

// No public constructor, Clone, Debug, serialized representation, or caller frame.
struct CodexTurn {
    capability: Box<ConsumedProviderDispatch>,
    scope: ExecutionScope,
    request_id: u64,
    broker: Option<crate::broker::channel::BrokerExecutionEnvelope>,
}

fn execution_scope(
    cap: &ConsumedProviderDispatch,
) -> Result<ExecutionScope, crate::containment::Error> {
    let run = &cap.provider().run;
    ExecutionScope::new(
        cap.namespace(),
        cap.incarnation_id(),
        &run.owner_id.to_string(),
        &run.session_id.to_string(),
        &run.run_id.to_string(),
        run.dispatch_fence,
    )
}

fn turn_frame(capability: &ConsumedProviderDispatch, request_id: u64) -> serde_json::Value {
    let provider = capability.provider();
    json!({"id":request_id,"method":"turn/start","params":{
        "threadId":provider.binding.native_session_id,
        "clientUserMessageId":capability.message_id().to_string(),
        "input":[{"type":"text","text":capability.text(),"text_elements":[]}]}})
}

impl ConsumedTurn for CodexTurn {
    fn broker_lineage(&self) -> Option<std::sync::Arc<()>> {
        self.broker.as_ref().map(|b| b.lineage.clone())
    }
    fn into_submission(self) -> (ExecutionScope, Vec<u8>) {
        let frame = turn_frame(&self.capability, self.request_id);
        let bytes = match self.broker {
            Some(broker) => broker.wrap(frame),
            None => frame.to_string().into_bytes(),
        };
        (self.scope, bytes)
    }
}

/// Takes the issuer capability by value on every path. An enqueue success means
/// queued bytes only, never provider acknowledgement or verified completion.
/// Caller must reconcile any failure; this function cannot return the grant.
/// The child's injected durable fence must also be current at enqueue/flush.
pub fn submit_codex(
    capability: Box<ConsumedProviderDispatch>,
    rpc: &mut CodexRpc,
    child: &OwnedChild,
) -> Result<(), SubmissionFailure> {
    let provider = capability.provider();
    let run = &provider.run;
    let binding = &provider.binding;
    if binding.provider_kind != ProviderKind::Codex
        || run.purpose != AdmissionPurpose::Execution
        || run.owner_id != binding.owner_id
        || run.conversation_id != binding.conversation_id
        || run.session_id != binding.session_id
        || run.role != binding.role
        || run.native_session_id != binding.native_session_id
    {
        return Err(SubmissionFailure::Protocol(Blocker::Protocol));
    }
    let native = binding
        .native_session_id
        .as_deref()
        .ok_or(SubmissionFailure::Protocol(Blocker::UnknownSession))?;
    let scope = execution_scope(&capability).map_err(SubmissionFailure::Transport)?;
    let request_id = rpc
        .claim_turn_request(native)
        .map_err(SubmissionFailure::Protocol)?;
    child
        .enqueue_turn(CodexTurn {
            capability,
            scope,
            request_id,
            broker: None,
        })
        .map_err(|failure| SubmissionFailure::Transport(failure.cause))
}

#[cfg(test)]
mod claude_tests;
