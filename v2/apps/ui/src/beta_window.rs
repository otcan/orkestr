//! Explicit owner intent after durable intake; never activates execution locally.
use orkestr_v2_contracts::{ExecutionWindowAdmission, ExecutionWindowRequest};

#[derive(Default)]
pub struct WindowIntent {
    generation: u64,
    pending: Option<ExecutionWindowRequest>,
}
impl WindowIntent {
    pub fn generation(&self) -> u64 {
        self.generation
    }
    /// Owner/session or configured conversation changes invalidate every callback.
    pub fn clear_scope(&mut self) {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("scope generation exhausted");
        self.pending = None;
    }
    pub fn pending(&self) -> Option<&ExecutionWindowRequest> {
        self.pending.as_ref()
    }
    /// An uncertain request must be retried verbatim, even after edits or polling.
    pub fn prepare(&mut self, request: ExecutionWindowRequest) -> Option<ExecutionWindowRequest> {
        if let Some(original) = &self.pending {
            return Some(original.clone());
        }
        if !request.is_valid() {
            return None;
        }
        self.pending = Some(request.clone());
        Some(request)
    }
    /// A receipt is historical admission evidence, never current activation status.
    pub fn receipt_matches(&self, generation: u64, receipt: &ExecutionWindowAdmission) -> bool {
        generation == self.generation
            && self.pending.as_ref().is_some_and(|request| {
                (if request.window_id.is_some() {
                    Some(request.expected_generation)
                } else {
                    request.expected_generation.checked_add(1)
                }) == Some(receipt.status.generation)
                    && request.predecessor_window_id
                        == receipt
                            .status
                            .predecessor_window_id
                            .filter(|_| request.window_id.is_none())
                    && request.request_key == receipt.request_key
                    && request.input_message_id == receipt.input_message_id
                    && request.input_event_id == receipt.input_event_id
                    && request.input_request_key == receipt.input_request_key
                    && request
                        .window_id
                        .is_none_or(|id| id == receipt.status.window_id)
            })
    }
    /// A definitive refusal needs explicit owner review before creating a new tuple.
    pub fn review_refusal(&mut self, generation: u64) -> bool {
        if generation != self.generation {
            return false;
        }
        self.clear_scope();
        true
    }
}

/// Authenticated owner lifetime; selection never discards another route's uncertainty.
#[derive(Default)]
pub struct WindowIntents {
    epoch: u64,
    entries: std::collections::BTreeMap<String, WindowIntent>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentTicket {
    route: String,
    epoch: u64,
    generation: u64,
}
impl WindowIntents {
    pub fn clear_scope(&mut self) {
        self.epoch = self
            .epoch
            .checked_add(1)
            .expect("owner generation exhausted");
        self.entries.clear();
    }
    pub fn pending(&self, route: &str) -> Option<&ExecutionWindowRequest> {
        self.entries.get(route).and_then(WindowIntent::pending)
    }
    pub fn prepare(
        &mut self,
        route: &str,
        request: ExecutionWindowRequest,
    ) -> Option<ExecutionWindowRequest> {
        let id = serde_json::from_value::<orkestr_v2_contracts::ConversationId>(
            serde_json::Value::String(route.into()),
        )
        .ok()?;
        if id.0.is_nil() || (!self.entries.contains_key(route) && self.entries.len() >= 128) {
            return None;
        }
        self.entries
            .entry(route.into())
            .or_default()
            .prepare(request)
    }
    pub fn ticket(&self, route: &str) -> Option<IntentTicket> {
        let intent = self.entries.get(route)?;
        intent.pending()?;
        Some(IntentTicket {
            route: route.into(),
            epoch: self.epoch,
            generation: intent.generation(),
        })
    }
    pub fn current(&self, route: &str, ticket: &IntentTicket) -> bool {
        self.ticket(route).as_ref() == Some(ticket)
    }
    pub fn review_refusal(&mut self, route: &str, ticket: &IntentTicket) -> bool {
        if !self.current(route, ticket) {
            return false;
        }
        self.entries
            .get_mut(route)
            .is_some_and(|intent| intent.review_refusal(ticket.generation))
    }
    pub fn complete(
        &mut self,
        route: &str,
        ticket: &IntentTicket,
        receipt: &ExecutionWindowAdmission,
        saved: &mut crate::beta_inputs::SavedInputs,
    ) -> bool {
        if !self.current(route, ticket) || receipt.status.conversation_id.to_string() != route {
            return false;
        }
        let intent = self.entries.get(route).expect("current ticket owns entry");
        if !intent.receipt_matches(ticket.generation, receipt) {
            return false;
        }
        let request = intent
            .pending()
            .expect("current ticket owns request")
            .clone();
        saved.admitted_request(route, &request);
        self.review_refusal(route, ticket)
    }
}
