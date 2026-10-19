//! Volatile, explicit owner consent. No transport or provider authority.
use orkestr_v2_contracts::{
    MemoryConsentAction, MemoryOperation, MemoryOwnerDecision, MemoryProposal, MemorySettings,
    ProjectId,
};
use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct DecisionRequest {
    pub proposal: MemoryProposal,
    pub decision: MemoryOwnerDecision,
}
#[derive(Default)]
pub struct MemoryState {
    generation: u64,
    settings: Option<MemorySettings>,
    project: Option<ProjectId>,
    reviewed: Option<MemoryProposal>,
    pending: Option<DecisionRequest>,
    pub refresh_required: bool,
}
impl MemoryState {
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn enabled(&self) -> Option<bool> {
        self.settings.as_ref().map(|s| s.enabled)
    }
    /// Auth transitions erase all consent state, including pending uncertain writes.
    pub fn retire(&mut self) {
        self.generation += 1;
        self.settings = None;
        self.project = None;
        self.reviewed = None;
        self.pending = None;
        self.refresh_required = false;
    }
    pub fn settings(&mut self, generation: u64, value: MemorySettings) -> bool {
        if generation != self.generation {
            return false;
        }
        if self
            .settings
            .as_ref()
            .is_some_and(|s| s.owner_id != value.owner_id)
        {
            self.retire();
            return false;
        }
        if !value.enabled {
            // Retain the observed disable while fencing every pre-disable callback.
            if self.enabled() == Some(true) {
                self.generation += 1;
            }
            self.reviewed = None;
            self.pending = None;
        }
        self.settings = Some(value);
        true
    }
    pub fn select(&mut self, project: Option<ProjectId>) {
        if self.project != project {
            self.generation += 1;
            self.project = project;
            self.reviewed = None;
            self.pending = None;
        }
    }
    /// Editing never mutates an uncertain request. It requires explicit resolution.
    pub fn edit(&mut self) -> Result<(), &'static str> {
        if self.pending.is_some() {
            return Err("Resolve the pending save before editing.");
        }
        self.generation += 1;
        self.reviewed = None;
        Ok(())
    }
    pub fn review(&mut self, generation: u64, proposal: MemoryProposal) -> bool {
        if generation != self.generation
            || self.enabled() != Some(true)
            || self.pending.is_some()
            || proposal.schema_version != 1
            || proposal.digest.len() != 64
            || !proposal
                .digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return false;
        }
        let scope = match &proposal.operation {
            MemoryOperation::Create { candidate } | MemoryOperation::Correct { candidate, .. } => {
                Some(&candidate.scope)
            }
            MemoryOperation::Forget { .. } => None,
        };
        if let Some(orkestr_v2_contracts::MemoryScope::Project { project_id }) = scope {
            if self.project.as_ref() != Some(project_id) {
                return false;
            }
        }
        self.reviewed = Some(proposal);
        true
    }
    pub fn confirm(
        &mut self,
        action: MemoryConsentAction,
    ) -> Result<DecisionRequest, &'static str> {
        if let Some(pending) = &self.pending {
            return Ok(pending.clone());
        }
        if self.enabled() != Some(true) {
            return Err("Enable Memory before saving.");
        }
        let proposal = self
            .reviewed
            .as_ref()
            .ok_or("Review the memory before saving.")?;
        let valid = match &proposal.operation {
            MemoryOperation::Create { candidate } => match action {
                MemoryConsentAction::Remember => self.settings.as_ref().is_some_and(|s| {
                    candidate.source.kind == orkestr_v2_contracts::MemorySourceKind::Owner
                        && candidate.source.actor_id == s.owner_id.to_string()
                }),
                MemoryConsentAction::Approve => true,
                _ => false,
            },
            MemoryOperation::Correct { .. } => action == MemoryConsentAction::Correct,
            MemoryOperation::Forget { .. } => action == MemoryConsentAction::Forget,
        };
        if !valid {
            return Err("Choose the matching memory action.");
        }
        let request = DecisionRequest {
            proposal: proposal.clone(),
            decision: MemoryOwnerDecision {
                action,
                digest: proposal.digest.clone(),
            },
        };
        self.pending = Some(request.clone());
        Ok(request)
    }
    /// A receipt is historical: discard reviewed content and demand current reads.
    pub fn resolved(&mut self, generation: u64) -> bool {
        if generation != self.generation {
            return false;
        }
        self.pending = None;
        self.reviewed = None;
        self.refresh_required = true;
        true
    }
}
