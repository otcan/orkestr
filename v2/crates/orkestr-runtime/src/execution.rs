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
mod native_model_tests;
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

/// Prefixed to every Fast turn (Codex and Claude). Fast is a quick, read-only
/// acknowledgement: a Deep turn handles the same input in parallel and owns
/// every action, check and fact. The broker independently runs Fast with a
/// read-only sandbox and without side-effect tools; this note is the reply
/// contract, not the enforcement.
pub const FAST_TURN_NOTE: &str = "[Fast reply rules. A Deep turn is working on this same message in parallel and does all real work. You are the quick, read-only first reply.
- Read-only: never send messages, emails or requests to other threads, never write files, logs, notes or ledgers, never run git, schedule, deploy or use browser or desktop tools. Writes and network are blocked here; do not try them or work around them. Short read-only lookups are fine; no long-running commands, waits or polling loops.
- Acknowledge and briefly restate the request. Answer it only when the answer is directly in this message or the conversation history; otherwise say Deep is looking into it.
- Never say or imply that anything was done, sent, verified, fixed, scheduled or queued, and never promise a time. Do not state dates, numbers or statuses that are not written in this message or the history.
- If the owner reports a problem or bug, do not call it a user error or tell them how they caused it; acknowledge it and say Deep is investigating.
- If the input lists attachments, open each listed local file before answering (use your image viewing tool for images). Never say you cannot see an attachment that is listed unless opening it failed.
- Reply in the language of the owner's message, in at most three short sentences.]";

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

#[cfg(test)]
mod fast_contract_tests {
    use super::{turn_text, FAST_TURN_NOTE};
    use orkestr_v2_contracts::runtime::Role;

    #[test]
    fn fast_note_is_a_read_only_no_claims_contract() {
        let note = FAST_TURN_NOTE.to_lowercase();
        for required in [
            // Read-only: no cross-thread requests, writes, git, browser.
            "read-only",
            "never send messages, emails or requests to other threads",
            "never write files, logs, notes or ledgers",
            "never run git",
            "browser or desktop tools",
            // Acknowledge, restate, answer only from message/history.
            "acknowledge and briefly restate the request",
            "only when the answer is directly in this message or the conversation history",
            "deep is looking into it",
            // No completion claims or invented facts.
            "never say or imply that anything was done, sent, verified, fixed, scheduled or queued",
            "never promise a time",
            "do not state dates, numbers or statuses",
            // Bug reports are never user error.
            "do not call it a user error",
            "deep is investigating",
            // Attachments are opened, not ignored.
            "open each listed local file before answering",
            "image viewing tool",
            // Short, in the owner's language.
            "language of the owner's message",
            "at most three short sentences",
        ] {
            assert!(note.contains(required), "missing: {required}");
        }
        // The note must not invite long work or polling.
        assert!(note.contains("no long-running commands, waits or polling loops"));
        assert!(FAST_TURN_NOTE.starts_with('[') && FAST_TURN_NOTE.ends_with(']'));
        assert!(FAST_TURN_NOTE.len() < 2048);
    }

    #[test]
    fn fast_receives_the_exact_input_and_attachments_deep_receives() {
        let input = "[WhatsApp: synthetic-chat]\n\nthe colour field cannot be edited\n\n\
[WhatsApp attachments imported into this conversation's attachment store, manifest 00000000-0000-4000-8000-000000000001:\n\
- image.jpg (image/jpeg, 1024 bytes, reference 00000000-0000-4000-8000-000000000002, local file /synthetic/media/0000.jpg)\n\
Open the local file to see an attachment (for an image use your image viewing tool).]";
        let deep = turn_text(Role::Deep, input);
        let fast = turn_text(Role::Fast, input);
        assert_eq!(deep, input);
        assert_eq!(fast, format!("{FAST_TURN_NOTE}\n\n{input}"));
        // The whole input, including every attachment reference, follows the
        // note unchanged: Fast sees exactly what Deep sees.
        assert_eq!(
            fast.strip_prefix(FAST_TURN_NOTE).unwrap().trim_start(),
            deep
        );
        assert!(fast.contains("local file /synthetic/media/0000.jpg"));
        assert_eq!(turn_text(Role::Worker, input), input);
    }
}
