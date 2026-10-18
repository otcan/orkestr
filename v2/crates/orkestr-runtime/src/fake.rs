//! Controllable FAKE provider. Explicit fixture mode, bounded queues, no timers,
//! threads, inference, persistence or implicit fallback to synthetic results.
use crate::ports::{Blocker, InterruptControl, Provider, ProviderAdmission, ProviderEvent};
use orkestr_v2_application::runtime::MAX_PROVIDER_PROGRESS_BYTES;
use orkestr_v2_contracts::SessionId;
use std::collections::{HashMap, VecDeque};

pub const LABEL: &str = "FAKE — synthetic test provider; no model inference";
const MAX_EVENTS: usize = 32;
const MAX_SESSIONS: usize = 64;

#[derive(Debug)]
struct Turn {
    admission: ProviderAdmission,
    events: VecDeque<ProviderEvent>,
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
        admission: &ProviderAdmission,
        event: ProviderEvent,
    ) -> Result<(), Blocker> {
        if matches!(event, ProviderEvent::Completed { synthetic: false }) {
            return Err(Blocker::FixtureOnly);
        }
        if matches!(&event, ProviderEvent::Progress(text) if text.len() > MAX_PROVIDER_PROGRESS_BYTES)
        {
            return Err(Blocker::QueueFull);
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
            ProviderEvent::Completed { .. }
                | ProviderEvent::Failed
                | ProviderEvent::Stopped
                | ProviderEvent::Lost
        );
        turn.events.push_back(event);
        Ok(())
    }
    fn checked(&mut self, admission: &ProviderAdmission) -> Result<&mut Turn, Blocker> {
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
    fn start(&mut self, admission: &ProviderAdmission) -> Result<(), Blocker> {
        if self.turns.contains_key(&admission.session_id) {
            return Err(Blocker::Busy);
        }
        if self
            .turns
            .values()
            .any(|turn| turn.admission.native_session_ref == admission.native_session_ref)
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
                events: VecDeque::from([ProviderEvent::Started]),
                terminal: false,
            },
        );
        Ok(())
    }
    fn poll(&mut self, admission: &ProviderAdmission) -> Result<Option<ProviderEvent>, Blocker> {
        let turn = self.checked(admission)?;
        let event = turn.events.pop_front();
        if turn.terminal && turn.events.is_empty() {
            self.turns.remove(&admission.session_id);
        }
        Ok(event)
    }
    fn interrupt(&mut self, control: &InterruptControl) -> Result<(), Blocker> {
        let admission = &control.original;
        let turn = self.checked(admission)?;
        if control.fence_generation < admission.fence_generation {
            return Err(Blocker::StaleLease);
        }
        if turn.terminal {
            return Err(Blocker::Busy);
        }
        // Keep original execution identity. The new fence is control-only.
        turn.events.clear();
        turn.events.push_back(ProviderEvent::Stopped);
        turn.terminal = true;
        Ok(())
    }
}
