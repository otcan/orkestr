//! By-value bridge from Core's committed dispatch to the owned transport.
//! This does not construct a supervisor, credentials, or a permissive fence.
pub(crate) mod cancellation_fence;
mod claude_lifecycle;
mod claude_pump;
mod claude_session;
mod fence;
mod lease_refresh;
mod model_evidence;
mod offline_pump;
mod offline_result;
mod provider_write;
mod pump;
mod reuse;
mod session;
mod steering;
mod workspace_pump;
mod workspace_result;
pub use claude_pump::{ClaudePump, StoppingClaude};
pub use claude_session::{PreparingClaude, ReadyClaude};
pub use pump::{CodexPump, StopFailure, StoppingCodex};
pub use session::{PreparingCodex, ReadyCodex, SetupFailure};
pub use steering::{SteeringProgress, SteeringReadiness};
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

/// Prefixed to every Fast turn: Fast answers quickly while Deep (and its
/// Workers) does long work in parallel. A long command in Fast only holds the
/// window and is stopped by Fast's short run budget.
pub const FAST_TURN_NOTE: &str =
    "[Fast reply: answer within about a minute. Do not start long-running commands, \
waits or polling loops; a Deep turn is working on this message in parallel and handles long work.]";

pub(crate) fn turn_text(role: orkestr_v2_contracts::runtime::Role, text: &str) -> String {
    match role {
        orkestr_v2_contracts::runtime::Role::Fast => format!("{FAST_TURN_NOTE}\n\n{text}"),
        _ => text.to_owned(),
    }
}

fn turn_frame(capability: &ConsumedProviderDispatch, request_id: u64) -> serde_json::Value {
    let provider = capability.provider();
    let text = turn_text(provider.binding.role, capability.text());
    let mut frame = json!({"id":request_id,"method":"turn/start","params":{
        "threadId":provider.binding.native_session_id,
        "clientUserMessageId":capability.message_id().to_string(),
        "input":[{"type":"text","text":text,"text_elements":[]}]}});
    // Owner conversation settings (V1 `turnStartParams`): per-turn overrides,
    // so a change applies from the next turn and never to a running one.
    if let Some((model, effort)) = capability.launch().and_then(|l| l.codex_overrides()) {
        if let Some(model) = model {
            frame["params"]["model"] = json!(model);
        }
        if let Some(effort) = effort {
            frame["params"]["effort"] = json!(effort);
        }
    }
    frame
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
