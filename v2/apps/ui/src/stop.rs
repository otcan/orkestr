//! Durable Stop request identity. Receipts never imply live process interruption.
use orkestr_v2_contracts::{
    ConversationId, ExecutionControlRequest, ExecutionStatus, ExecutionStopOutcome,
    ExecutionStopReceipt,
};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone)]
pub struct PendingStop {
    pub conversation: ConversationId,
    pub request: ExecutionControlRequest,
    pub generation: u64,
}
#[derive(Clone, Default)]
pub struct Stops {
    generation: u64,
    pending: BTreeMap<String, PendingStop>,
    receipts: BTreeMap<String, ExecutionStopReceipt>,
    conflicts: BTreeSet<String>,
    errors: BTreeMap<String, &'static str>,
}
fn identity(conversation: &ConversationId, run: &orkestr_v2_contracts::RunId) -> String {
    format!("{conversation}/{run}")
}
impl Stops {
    pub fn clear_owner(&mut self) {
        let generation = self
            .generation
            .checked_add(1)
            .expect("owner generation exhausted");
        *self = Self {
            generation,
            ..Self::default()
        };
    }
    pub fn accepted(&self, status: &ExecutionStatus) -> bool {
        self.receipts
            .get(
                &status
                    .run_id
                    .as_ref()
                    .map(|run| identity(&status.conversation_id, run))
                    .unwrap_or_default(),
            )
            .is_some_and(|r| Some(&r.run_id) == status.run_id.as_ref())
    }
    pub fn needs_review(&self, status: &ExecutionStatus) -> bool {
        status.run_id.as_ref().is_some_and(|run| {
            self.conflicts
                .contains(&identity(&status.conversation_id, run))
        })
    }
    pub fn can_review(&self, status: &ExecutionStatus) -> bool {
        status.is_valid()
            && status.capabilities.stop
            && self.needs_review(status)
            && matches!(
                status.phase,
                orkestr_v2_contracts::ExecutionPhase::Queued
                    | orkestr_v2_contracts::ExecutionPhase::Starting
                    | orkestr_v2_contracts::ExecutionPhase::Running
            )
            && status
                .run_id
                .as_ref()
                .and_then(|run| self.pending.get(&identity(&status.conversation_id, run)))
                .is_some_and(|pending| match pending.request.expected_control_revision {
                    Some(old) => status.control_revision.is_some_and(|current| current > old),
                    None => status.revision > pending.request.expected_revision,
                })
    }
    /// Explicit owner review after a definitive refusal; never used for uncertain failures.
    pub fn review(&mut self, status: &ExecutionStatus) -> Result<(), &'static str> {
        if !self.can_review(status) {
            return Err("Refresh execution status before reviewing Stop.");
        }
        let id = identity(&status.conversation_id, status.run_id.as_ref().unwrap());
        self.pending.remove(&id);
        self.conflicts.remove(&id);
        self.errors.remove(&id);
        Ok(())
    }
    pub fn retryable(&self, status: &ExecutionStatus) -> bool {
        if self.needs_review(status) {
            return false;
        }
        self.pending
            .get(
                &status
                    .run_id
                    .as_ref()
                    .map(|run| identity(&status.conversation_id, run))
                    .unwrap_or_default(),
            )
            .is_some_and(|p| Some(&p.request.run_id) == status.run_id.as_ref())
    }
    pub fn prepare(
        &mut self,
        status: &ExecutionStatus,
        key: String,
    ) -> Result<PendingStop, &'static str> {
        if !status.is_valid() {
            return Err("Execution unavailable");
        }
        if self.needs_review(status) {
            return Err("Review updated Stop before retrying.");
        }
        if self.accepted(status) {
            return Err("Stop already requested. Refresh execution status.");
        }
        let id = status
            .run_id
            .as_ref()
            .map(|run| identity(&status.conversation_id, run))
            .ok_or("No execution to stop")?;
        let run = status.run_id.as_ref().ok_or("No execution to stop")?;
        if let Some(old) = self.pending.get(&id) {
            return if &old.request.run_id == run {
                Ok(old.clone())
            } else {
                Err("Earlier stop is unconfirmed. Refresh execution status.")
            };
        }
        if !status.capabilities.stop
            || !matches!(
                status.phase,
                orkestr_v2_contracts::ExecutionPhase::Queued
                    | orkestr_v2_contracts::ExecutionPhase::Starting
                    | orkestr_v2_contracts::ExecutionPhase::Running
            )
        {
            return Err("Stop unavailable");
        }
        let request = ExecutionControlRequest {
            run_id: run.clone(),
            expected_revision: status.revision,
            expected_control_revision: status.control_revision,
            request_key: key,
        };
        if !request.is_valid() {
            return Err("Invalid stop request");
        }
        let pending = PendingStop {
            conversation: status.conversation_id.clone(),
            request,
            generation: self.generation,
        };
        self.receipts.remove(&id);
        self.errors.remove(&id);
        self.pending.insert(id, pending.clone());
        Ok(pending)
    }
    fn current(&self, pending: &PendingStop) -> bool {
        self.generation == pending.generation
            && self
                .pending
                .get(&identity(&pending.conversation, &pending.request.run_id))
                .is_some_and(|p| {
                    p.request.run_id == pending.request.run_id
                        && p.request.expected_revision == pending.request.expected_revision
                        && p.request.expected_control_revision
                            == pending.request.expected_control_revision
                        && p.request.request_key == pending.request.request_key
                })
    }
    pub fn receipt(
        &mut self,
        pending: &PendingStop,
        receipt: ExecutionStopReceipt,
    ) -> Result<(), &'static str> {
        if !self.current(pending)
            || !receipt.is_valid()
            || receipt.conversation_id != pending.conversation
            || receipt.run_id != pending.request.run_id
            || receipt.request_key != pending.request.request_key
            || receipt.requested_revision != pending.request.expected_revision
        {
            return Err("Stop receipt identity mismatch");
        }
        let id = identity(&pending.conversation, &pending.request.run_id);
        self.pending.remove(&id);
        self.conflicts.remove(&id);
        self.errors.remove(&id);
        self.receipts.insert(id, receipt);
        Ok(())
    }
    pub fn failed(&mut self, pending: &PendingStop, status: u16) {
        if self.current(pending) {
            if status == 409 {
                self.conflicts
                    .insert(identity(&pending.conversation, &pending.request.run_id));
            }
            self.errors.insert(
                identity(&pending.conversation, &pending.request.run_id),
                match status {
                    409 => "Stop not confirmed. Refresh execution status before retrying.",
                    503 => "Stop unavailable. Request retained for retry.",
                    _ => "Stop not confirmed. Check connection and retry.",
                },
            );
        }
    }
    pub fn notice(&self, status: &ExecutionStatus) -> Option<&'static str> {
        let id = status
            .run_id
            .as_ref()
            .map(|run| identity(&status.conversation_id, run))?;
        if let Some(error) = self.errors.get(&id) {
            return Some(error);
        }
        if let Some(receipt) = self.receipts.get(&id) {
            return Some(match receipt.outcome {
                ExecutionStopOutcome::NotDispatched => "Cancelled before provider delivery.",
                ExecutionStopOutcome::RequestedUnknown => {
                    "Stop requested; provider interruption is unconfirmed."
                }
            });
        }
        self.pending
            .contains_key(&id)
            .then_some("Stop confirmation pending.")
    }
}
