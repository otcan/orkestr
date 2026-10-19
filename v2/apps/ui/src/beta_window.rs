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
        self.pending = None;
        true
    }
}
