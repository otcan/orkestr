//! Explicit owner decision bound to validated completion replay and current status.
use orkestr_v2_contracts::*;
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone)]
pub struct PendingAcceptance {
    pub conversation: ConversationId,
    pub request: ExecutionAcceptanceRequest,
    generation: u64,
}
#[derive(Clone)]
struct Proposal {
    run: RunId,
    event: EventId,
    sequence: i64,
}
#[derive(Clone, Default)]
pub struct Acceptances {
    generation: u64,
    proposals: BTreeMap<String, Proposal>,
    pending: BTreeMap<String, PendingAcceptance>,
    receipts: BTreeMap<String, ExecutionAcceptanceReceipt>,
    errors: BTreeMap<String, &'static str>,
    conflicts: BTreeSet<String>,
}
fn identity(conversation: &ConversationId, run: &RunId, event: &EventId) -> String {
    format!("{conversation}/{run}/{event}")
}
impl Acceptances {
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
    /// Caller has already validated replay scope and committed its atomic reconciliation.
    pub fn observe(&mut self, event: &ConversationEvent) {
        if let ConversationEvent::ProviderObserved(e) = event {
            if !e.is_valid()
                || e.event_id.0.is_nil()
                || e.aggregate_id.0.is_nil()
                || e.payload_ref_or_safe_payload.run_id.0.is_nil()
                || !matches!(
                    e.payload_ref_or_safe_payload.observation,
                    ProductionObservationKind::CompletedProposal
                )
            {
                return;
            }
            let key = e.aggregate_id.to_string();
            if self
                .proposals
                .get(&key)
                .is_some_and(|p| p.sequence >= e.sequence)
            {
                return;
            }
            self.proposals.insert(
                key,
                Proposal {
                    run: e.payload_ref_or_safe_payload.run_id.clone(),
                    event: e.event_id.clone(),
                    sequence: e.sequence,
                },
            );
        }
    }
    /// Called only after the owner/selection/revision adapter validates the whole status.
    pub fn observe_status(&mut self, status: &ExecutionStatus) {
        if !status.is_valid() {
            return;
        }
        if let Some(candidate) = status.acceptance_candidate.as_ref() {
            self.proposals.insert(
                status.conversation_id.to_string(),
                Proposal {
                    run: candidate.run_id.clone(),
                    event: candidate.completion_event_id.clone(),
                    sequence: status.revision,
                },
            );
        }
    }
    fn target(&self, status: &ExecutionStatus) -> Option<(&Proposal, String)> {
        if !status.is_valid() {
            return None;
        }
        let proposal = self.proposals.get(&status.conversation_id.to_string())?;
        if status.run_id.as_ref() != Some(&proposal.run) || status.revision < proposal.sequence {
            return None;
        }
        Some((
            proposal,
            identity(&status.conversation_id, &proposal.run, &proposal.event),
        ))
    }
    pub fn available(&self, status: &ExecutionStatus) -> bool {
        self.target(status).is_some_and(|(_, key)| {
            !self.receipts.contains_key(&key)
                && (status.phase == ExecutionPhase::AwaitingAcceptance
                    || self.pending.contains_key(&key))
        })
    }
    pub fn retryable(&self, status: &ExecutionStatus) -> bool {
        self.target(status)
            .is_some_and(|(_, key)| self.pending.contains_key(&key))
    }
    pub fn prepare(
        &mut self,
        status: &ExecutionStatus,
        key: String,
    ) -> Result<PendingAcceptance, &'static str> {
        let (proposal, id) = self
            .target(status)
            .ok_or("Refresh the completion before accepting.")?;
        if self.receipts.contains_key(&id) {
            return Err("Completion already accepted.");
        }
        if let Some(pending) = self.pending.get(&id) {
            return Ok(pending.clone());
        }
        if status.phase != ExecutionPhase::AwaitingAcceptance {
            return Err("Refresh the completion before accepting.");
        }
        let request = ExecutionAcceptanceRequest {
            run_id: proposal.run.clone(),
            completion_event_id: proposal.event.clone(),
            expected_revision: status.revision,
            request_key: key,
        };
        if !request.is_valid() {
            return Err("Acceptance unavailable.");
        }
        let pending = PendingAcceptance {
            conversation: status.conversation_id.clone(),
            request,
            generation: self.generation,
        };
        self.pending.insert(id, pending.clone());
        Ok(pending)
    }
    fn current(&self, pending: &PendingAcceptance) -> bool {
        self.generation == pending.generation
            && self
                .pending
                .get(&identity(
                    &pending.conversation,
                    &pending.request.run_id,
                    &pending.request.completion_event_id,
                ))
                .is_some_and(|p| p.request == pending.request)
    }
    pub fn receipt(
        &mut self,
        pending: &PendingAcceptance,
        receipt: ExecutionAcceptanceReceipt,
    ) -> Result<(), &'static str> {
        if !self.current(pending)
            || !receipt.is_valid()
            || receipt.conversation_id != pending.conversation
            || receipt.run_id != pending.request.run_id
            || receipt.completion_event_id != pending.request.completion_event_id
            || receipt.requested_revision != pending.request.expected_revision
            || receipt.request_key != pending.request.request_key
        {
            return Err("Acceptance was not confirmed.");
        }
        let key = identity(
            &pending.conversation,
            &pending.request.run_id,
            &pending.request.completion_event_id,
        );
        self.pending.remove(&key);
        self.errors.remove(&key);
        self.receipts.insert(key, receipt);
        Ok(())
    }
    pub fn failed(&mut self, pending: &PendingAcceptance, status: u16) {
        if self.current(pending) {
            if status == 409 {
                self.conflicts.insert(identity(
                    &pending.conversation,
                    &pending.request.run_id,
                    &pending.request.completion_event_id,
                ));
            }
            self.errors.insert(identity(&pending.conversation, &pending.request.run_id, &pending.request.completion_event_id), match status { 409 => "Completion changed. Refresh before reviewing again. Original request retained.", 503 => "Acceptance unavailable. Original request retained for retry.", _ => "Acceptance not confirmed. Retry keeps your original decision request." });
        }
    }
    pub fn can_review_updated(&self, status: &ExecutionStatus) -> bool {
        self.target(status).is_some_and(|(_, key)| {
            status.phase == ExecutionPhase::AwaitingAcceptance
                && self.conflicts.contains(&key)
                && self
                    .pending
                    .get(&key)
                    .is_some_and(|p| status.revision > p.request.expected_revision)
        })
    }
    /// Explicitly review a newer revision after a definitive conflict; never silently re-key.
    pub fn review_updated(&mut self, status: &ExecutionStatus) -> Result<(), &'static str> {
        if !self.can_review_updated(status) {
            return Err("Refresh the completion before reviewing again.");
        }
        let (_, key) = self.target(status).ok_or("Completion unavailable.")?;
        self.pending.remove(&key);
        self.errors.remove(&key);
        self.conflicts.remove(&key);
        Ok(())
    }
    pub fn notice(&self, status: &ExecutionStatus) -> Option<&'static str> {
        let (_, key) = self.target(status)?;
        self.errors
            .get(&key)
            .copied()
            .or_else(|| {
                self.receipts
                    .contains_key(&key)
                    .then_some("Completion accepted.")
            })
            .or_else(|| {
                self.pending
                    .contains_key(&key)
                    .then_some("Acceptance confirmation pending.")
            })
    }
}
