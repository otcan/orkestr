//! Client presentation only. Accepted input is not model completion.
pub mod acceptance;
pub mod accepted_results;
pub mod archived_history;
pub mod payload;
use orkestr_v2_contracts::{ConversationEvent, ConversationSnapshot, Message, MessageInput, Scope};
use std::collections::BTreeMap;

pub mod chat_settings;
pub mod execution;
pub mod host_resources;
pub mod provider_handoff;
mod reconcile;
pub mod session_scope;
pub mod stop;
pub mod v1_input;
pub mod v1_manage;
pub mod v1_workers;
pub mod whatsapp_chat;
pub mod workers;
pub use reconcile::reconcile;

pub const WINDOW: usize = 100;

#[derive(Clone, Default)]
pub struct Draft {
    pub text: String,
    pub revision: u64,
    pub pending: Option<Submission>,
    /// The message this draft replies to (web UI reply), sent with it.
    pub quote: Option<orkestr_v2_contracts::ReplyTo>,
}

#[derive(Clone)]
pub struct Submission {
    pub input: MessageInput,
    pub revision: u64,
}

impl Draft {
    pub fn edit(&mut self, text: String) {
        self.text = text;
        self.revision += 1;
    }

    pub fn prepare(&mut self, key: String) -> Result<MessageInput, &'static str> {
        if let Some(pending) = &self.pending {
            return Ok(pending.input.clone());
        }
        if self.text.trim().is_empty() || self.text.len() > 32768 {
            return Err("Message must contain 1–32768 UTF-8 bytes.");
        }
        let input = MessageInput {
            client_message_id: key,
            text: self.text.clone(),
        };
        self.pending = Some(Submission {
            input: input.clone(),
            revision: self.revision,
        });
        Ok(input)
    }

    pub fn accepted(&mut self) {
        if let Some(pending) = self.pending.take() {
            if pending.revision == self.revision {
                self.text.clear();
                self.revision += 1;
            }
        }
    }
}

#[derive(Clone, Default)]
pub struct Projection {
    pub messages: BTreeMap<i64, Message>,
    pub watermark: i64,
    pub scope: Option<Scope>,
    pub conversation_id: Option<String>,
}

impl Projection {
    pub fn page(&mut self, page: ConversationSnapshot) -> Result<(), &'static str> {
        if self
            .scope
            .as_ref()
            .is_some_and(|scope| scope != &page.scope)
            || self
                .conversation_id
                .as_ref()
                .is_some_and(|id| id != &page.conversation_id.to_string())
        {
            return Err("Snapshot scope mismatch");
        }
        if page.last_sequence < 0 {
            return Err("Invalid snapshot watermark");
        }
        let mut incoming = BTreeMap::new();
        for message in &page.messages {
            if message.sequence <= 0 || message.sequence > page.last_sequence {
                return Err("Invalid message sequence");
            }
            let old = incoming
                .insert(message.sequence, message)
                .or_else(|| self.messages.get(&message.sequence));
            if let Some(old) = old {
                if old.message_id != message.message_id
                    || old.text != message.text
                    || old.actor_kind != message.actor_kind
                {
                    return Err("Conflicting snapshot; reconnect required");
                }
            }
        }
        self.scope = Some(page.scope);
        self.conversation_id = Some(page.conversation_id.to_string());
        for message in page.messages {
            self.messages.insert(message.sequence, message);
            while self.messages.len() > WINDOW {
                self.messages.pop_first();
            }
        }
        self.watermark = self.watermark.max(page.last_sequence);
        Ok(())
    }
}

/// Validate metadata without interpreting it as text or provider readiness.
pub fn replay_sequence(
    view: &Projection,
    name: &str,
    id: Option<&str>,
    event: &ConversationEvent,
) -> Result<i64, &'static str> {
    let (conversation, scope, schema) = match event {
        ConversationEvent::ExecutionAccepted(e) => {
            (e.aggregate_id.to_string(), &e.scope, e.is_valid())
        }
        ConversationEvent::ProviderObserved(e) => {
            (e.aggregate_id.to_string(), &e.scope, e.is_valid())
        }
        ConversationEvent::CancellationRequested(e) => {
            (e.aggregate_id.to_string(), &e.scope, e.is_valid())
        }
        ConversationEvent::ProviderStopped(e) => {
            (e.aggregate_id.to_string(), &e.scope, e.is_valid())
        }
        ConversationEvent::MessageAccepted(e) => (
            e.aggregate_id.to_string(),
            &e.scope,
            e.schema_version == 1 && e.payload_ref_or_safe_payload.kind == "message_accepted",
        ),
        ConversationEvent::FixtureCancellationRequested(e) => {
            (e.aggregate_id.to_string(), &e.scope, e.schema_version == 3)
        }
        ConversationEvent::FixtureProviderStopped(e) => (
            e.aggregate_id.to_string(),
            &e.scope,
            e.schema_version == 4 && e.payload_ref_or_safe_payload.run_sequence > 0,
        ),
        ConversationEvent::FixtureProviderObserved(e) => (
            e.aggregate_id.to_string(),
            &e.scope,
            e.schema_version == 2 && e.payload_ref_or_safe_payload.run_sequence > 0,
        ),
    };
    let sequence = event.sequence();
    if !schema
        || name != event.sse_name()
        || sequence <= 0
        || id != Some(sequence.to_string().as_str())
        || view.conversation_id.as_ref() != Some(&conversation)
        || view.scope.as_ref() != Some(scope)
    {
        return Err("Unexpected event contract; history resync required");
    }
    Ok(sequence)
}

/// Browser bridge wrapper; canonical event variants remain core-owned.
#[derive(serde::Deserialize)]
pub struct StreamItem {
    pub status: u16,
    pub event: String,
    pub id: Option<String>,
    pub body: Option<ConversationEvent>,
}
pub fn decode_stream(raw: serde_json::Value) -> StreamItem {
    serde_json::from_value(raw).unwrap_or(StreamItem {
        status: 200,
        event: "resync_required".into(),
        id: None,
        body: None,
    })
}

/// Status records observations only, never verified completion or control success.
pub fn replay_notice(event: &ConversationEvent) -> &'static str {
    use orkestr_v2_contracts::FixtureCancellationOutcome;
    match event {
        ConversationEvent::ExecutionAccepted(_) => "Completion accepted by owner.",
        ConversationEvent::CancellationRequested(e) => match e.payload_ref_or_safe_payload.outcome {
            orkestr_v2_contracts::CancellationOutcome::Unknown => "Stop requested; confirmation pending.",
            orkestr_v2_contracts::CancellationOutcome::NotDispatched => "Cancelled before provider delivery.",
        },
        ConversationEvent::ProviderStopped(_) => "Cancelled; provider stop confirmed.",
        ConversationEvent::ProviderObserved(e) => match e.payload_ref_or_safe_payload.observation {
            orkestr_v2_contracts::ProductionObservationKind::Started => "Provider started.",
            orkestr_v2_contracts::ProductionObservationKind::ProgressRef { .. } => "Provider progress available.",
            orkestr_v2_contracts::ProductionObservationKind::ApprovalRequested => "Review requested.",
            orkestr_v2_contracts::ProductionObservationKind::CompletedProposal => "Provider finished; awaiting review.",
            orkestr_v2_contracts::ProductionObservationKind::Failed => "Provider reported a failure.",
            orkestr_v2_contracts::ProductionObservationKind::Lost => "Provider connection lost.",
        },
        ConversationEvent::FixtureProviderStopped(_) => "Fixture stop acknowledgement recorded: receipt cancelled. Ordinary runtime and Stop remain unavailable.",
        ConversationEvent::FixtureCancellationRequested(e) => match e.payload_ref_or_safe_payload.outcome {
            FixtureCancellationOutcome::Unknown => "Fixture cancellation requested: outcome unconfirmed. Execution and Stop remain unavailable.",
            FixtureCancellationOutcome::NotDispatched => "Fixture cancellation requested: no provider delivery. Execution and Stop remain unavailable.",
        },
        _ => "Journal synchronized. Runtime metadata is synthetic; execution and Stop remain unavailable.",
    }
}

/// Route all canonical decoded journal variants through the same atomic reconciliation.
pub fn is_replay_item(item: &StreamItem) -> bool {
    item.body
        .as_ref()
        .is_some_and(|event| item.event == event.sse_name())
}

pub mod held_inputs;
pub mod live_stream;

pub mod timer_labels;
pub mod timer_rules;
pub mod timers;
pub mod worker_tasks;

pub mod build_identity;

pub mod task_draft_lifetime;

pub mod steering;

pub mod worker_time_limit;

pub mod memory_client;
pub mod memory_state;

pub mod beta_window;

pub mod beta_inputs;
pub mod page_memory;

pub mod chat_timeline;
pub mod composer_attachments;
pub mod conversation_directory;
pub mod conversation_status;
pub mod host_metrics;
pub mod intelligence;
pub mod live_map;
pub mod message_time;
pub mod outbox;
pub mod rich_text;
pub mod route;
pub mod send_intent;
pub mod sidebar;
