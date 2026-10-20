//! Page-lifetime durable intake receipts retained while a Send action awaits execution admission.
use orkestr_v2_contracts::{ConversationId, Receipt};

#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SavedInput {
    pub conversation: ConversationId,
    pub input_request_key: String,
    pub receipt: Receipt,
}
#[derive(Default)]
pub struct SavedInputs {
    inputs: Vec<SavedInput>,
}
impl SavedInputs {
    pub const LIMIT: usize = 128;
    pub fn is_full(&self) -> bool {
        self.inputs.len() >= Self::LIMIT
    }
    pub fn first(&self, conversation: &str) -> Option<SavedInput> {
        self.inputs
            .iter()
            .find(|input| input.conversation.to_string() == conversation)
            .cloned()
    }
    pub fn request(&self, conversation: &str, request_key: &str) -> Option<SavedInput> {
        self.inputs
            .iter()
            .find(|input| {
                input.conversation.to_string() == conversation
                    && input.input_request_key == request_key
            })
            .cloned()
    }
    pub fn retain_receipt(&mut self, input: SavedInput) -> bool {
        if let Some(existing) = self
            .inputs
            .iter()
            .find(|old| old.receipt.message_id == input.receipt.message_id)
        {
            return existing == &input;
        }
        if input.conversation.0.is_nil()
            || self.is_full()
            || input.receipt.message_id.0.is_nil()
            || input.receipt.event_id.0.is_nil()
            || input.receipt.sequence <= 0
            || input.input_request_key.is_empty()
        {
            return false;
        }
        self.inputs.push(input);
        true
    }
    pub fn admitted(&mut self, input: &SavedInput) {
        self.inputs.retain(|saved| saved != input);
    }
    pub fn admitted_request(
        &mut self,
        conversation: &str,
        request: &orkestr_v2_contracts::ExecutionWindowRequest,
    ) {
        self.inputs.retain(|saved| {
            !(saved.conversation.to_string() == conversation
                && saved.input_request_key == request.input_request_key
                && saved.receipt.message_id == request.input_message_id
                && saved.receipt.event_id == request.input_event_id)
        });
    }
    pub fn clear_owner(&mut self) {
        self.inputs.clear();
    }
    /// Retained receipts in arrival order, for page-reload recovery.
    pub fn all(&self) -> &[SavedInput] {
        &self.inputs
    }
}
