//! Explicit steering admission and delivery evidence; never completion authority.
use orkestr_v2_contracts::*;
#[derive(Clone, Default)]
pub struct Steering {
    pub text: String,
    pub pending: Option<ExecutionSteeringRequest>,
    pub conversation: Option<ConversationId>,
    pub receipt: Option<ExecutionSteeringReceipt>,
    pub conflict: bool,
    pub notice: &'static str,
}
impl Steering {
    pub fn prepare(
        &mut self,
        status: &ExecutionStatus,
        key: String,
    ) -> Result<ExecutionSteeringRequest, &'static str> {
        if self.conflict {
            return Err("Review the current run before trying again.");
        }
        if let Some(p) = &self.pending {
            if self.conversation.as_ref() != Some(&status.conversation_id)
                || status.run_id.as_ref() != Some(&p.control.run_id)
            {
                return Err("Select the original run to retry.");
            }
            return Ok(p.clone());
        }
        if !status.is_valid()
            || status.phase != ExecutionPhase::Running
            || !status.capabilities.steer
        {
            return Err("Steering is unavailable. Send a message to queue work instead.");
        }
        let request = ExecutionSteeringRequest {
            control: ExecutionControlRequest {
                run_id: status.run_id.clone().ok_or("Run unavailable")?,
                expected_revision: status.revision,
                expected_control_revision: status.control_revision,
                request_key: key,
            },
            text: self.text.clone(),
        };
        if !request.is_valid() {
            return Err("Enter instructions of up to 16384 bytes.");
        }
        self.conversation = Some(status.conversation_id.clone());
        self.pending = Some(request.clone());
        Ok(request)
    }
    pub fn failed(&mut self, code: u16) {
        self.conflict = matches!(code, 400 | 404 | 409);
        self.notice = if self.conflict {
            "Request refused. Review the current run before a new request."
        } else {
            "Steering not confirmed. Retry keeps the original instructions and request."
        };
    }
    pub fn receipt(
        &mut self,
        conversation: &ConversationId,
        receipt: ExecutionSteeringReceipt,
    ) -> bool {
        let Some(p) = &self.pending else {
            return false;
        };
        if &receipt.conversation_id != conversation
            || receipt.run_id != p.control.run_id
            || receipt.request_key != p.control.request_key
            || receipt.message_id.0.is_nil()
            || receipt.event_id.0.is_nil()
            || receipt.scope_sequence <= 0
        {
            return false;
        }
        self.notice = match receipt.disposition {
            SteeringDisposition::Reserved => "Steering reserved; delivery is not confirmed.",
            SteeringDisposition::QueuedUnsupported => {
                "Steering is unsupported. Instructions are queued as ordinary work."
            }
            SteeringDisposition::QueuedOrdered => {
                "Instructions are queued in order; not delivered to the running work."
            }
        };
        self.receipt = Some(receipt);
        true
    }
    pub fn delivery(&mut self, status: ExecutionSteeringStatus) -> bool {
        if self.receipt.as_ref() != Some(&status.receipt) {
            return false;
        }
        self.notice = match status.state {
            SteeringDeliveryState::Queued => "Instructions are queued; delivery is not confirmed.",
            SteeringDeliveryState::Reserved => "Steering reserved; delivery is not confirmed.",
            SteeringDeliveryState::DeliveryUnknown => {
                "Delivery is unknown. Do not assume the instructions were received."
            }
            SteeringDeliveryState::Acknowledged => {
                "Instructions acknowledged. This does not confirm completion."
            }
            SteeringDeliveryState::Rejected => {
                "Instructions rejected; work completion is unchanged."
            }
        };
        true
    }
}
