//! Controllable FAKE provider. Explicit fixture mode, bounded queues, no timers,
//! threads, inference, persistence or implicit fallback to synthetic results.
use crate::ports::{Blocker, InterruptControl, ObservationKind, Provider, RunAdmission};
use orkestr_v2_application::runtime::AdmissionPurpose;
use orkestr_v2_contracts::SessionId;
use std::collections::{HashMap, VecDeque};

pub const LABEL: &str = "FAKE — synthetic test provider; no model inference";
const MAX_EVENTS: usize = 32;
const MAX_SESSIONS: usize = 64;

#[derive(Debug)]
struct Turn {
    admission: RunAdmission,
    events: VecDeque<ObservationKind>,
    terminal: bool,
}

pub struct FakeProvider {
    turns: HashMap<SessionId, Turn>,
}
impl FakeProvider {
    pub fn fixture_only(explicit_fixture_mode: bool) -> Result<Self, Blocker> {
        if !explicit_fixture_mode {
            return Err(Blocker::FixtureOnly);
        }
        Ok(Self {
            turns: HashMap::new(),
        })
    }
    /// Empty queue means busy indefinitely: deterministic tests control progress.
    pub fn emit(
        &mut self,
        admission: &RunAdmission,
        event: ObservationKind,
    ) -> Result<(), Blocker> {
        if matches!(
            event,
            ObservationKind::CompletedProposal { synthetic: false }
        ) {
            return Err(Blocker::FixtureOnly);
        }
        let turn = self.checked(admission)?;
        if turn.terminal {
            return Err(Blocker::Busy);
        }
        if turn.events.len() >= MAX_EVENTS {
            return Err(Blocker::QueueFull);
        }
        turn.terminal = matches!(
            event,
            ObservationKind::CompletedProposal { .. }
                | ObservationKind::Failed
                | ObservationKind::Stopped
                | ObservationKind::Lost
        );
        turn.events.push_back(event);
        Ok(())
    }
    fn checked(&mut self, admission: &RunAdmission) -> Result<&mut Turn, Blocker> {
        let turn = self
            .turns
            .get_mut(&admission.session_id)
            .ok_or(Blocker::UnknownSession)?;
        if &turn.admission != admission {
            return Err(Blocker::StaleLease);
        }
        Ok(turn)
    }
}
impl Provider for FakeProvider {
    fn start(&mut self, admission: &RunAdmission) -> Result<(), Blocker> {
        if admission.purpose != AdmissionPurpose::Execution {
            return Err(Blocker::StaleLease);
        }
        if admission
            .native_session_id
            .as_deref()
            .is_none_or(str::is_empty)
        {
            return Err(Blocker::UnknownSession);
        }
        if self.turns.contains_key(&admission.session_id) {
            return Err(Blocker::Busy);
        }
        if self
            .turns
            .values()
            .any(|turn| turn.admission.native_session_id == admission.native_session_id)
        {
            return Err(Blocker::Busy);
        }
        if self.turns.len() >= MAX_SESSIONS {
            return Err(Blocker::QueueFull);
        }
        self.turns.insert(
            admission.session_id.clone(),
            Turn {
                admission: admission.clone(),
                events: VecDeque::from([ObservationKind::Started]),
                terminal: false,
            },
        );
        Ok(())
    }
    fn poll(&mut self, admission: &RunAdmission) -> Result<Option<ObservationKind>, Blocker> {
        let turn = self.checked(admission)?;
        let event = turn.events.pop_front();
        if turn.terminal && turn.events.is_empty() {
            self.turns.remove(&admission.session_id);
        }
        Ok(event)
    }
    fn interrupt(&mut self, control: &InterruptControl) -> Result<(), Blocker> {
        let original = &control.original;
        let cancelled = &control.cancellation;
        if cancelled.purpose != AdmissionPurpose::CancellationAcknowledgement
            || cancelled.owner_id != original.owner_id
            || cancelled.conversation_id != original.conversation_id
            || cancelled.run_id != original.run_id
            || cancelled.session_id != original.session_id
            || cancelled.native_session_id != original.native_session_id
            || cancelled.role != original.role
            || cancelled.attempt != original.attempt
            || cancelled.lease_generation <= original.lease_generation
            || cancelled.dispatch_fence <= original.dispatch_fence
        {
            return Err(Blocker::StaleLease);
        }
        let turn = self.checked(original)?;
        if turn.terminal {
            return Err(Blocker::Busy);
        }
        // Only a confirmed control dispatch can bind cancellation acknowledgement.
        turn.admission = cancelled.clone();
        turn.events.clear();
        turn.events.push_back(ObservationKind::Stopped);
        turn.terminal = true;
        Ok(())
    }
}
