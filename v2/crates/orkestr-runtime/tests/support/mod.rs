#![allow(dead_code)]
//! Ready-future spies only. Unimplemented methods explicitly return Unavailable.
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::*;
use std::{
    future::Future,
    sync::Mutex,
    task::{Context, Poll, Waker},
    time::Duration,
};
macro_rules! id {
    ($ty:ty, $n:expr) => {
        serde_json::from_str::<$ty>(&format!("\"00000000-0000-4000-8000-{:012x}\"", $n)).unwrap()
    };
}
pub fn owner() -> OwnerId {
    id!(OwnerId, 1)
}
pub fn admission(role: Role, n: u64) -> RunAdmission {
    RunAdmission {
        owner_id: owner(),
        conversation_id: id!(ConversationId, 3),
        run_id: id!(RunId, n),
        session_id: id!(SessionId, n),
        role,
        native_session_id: Some(format!("FAKE-{n}")),
        lease_generation: 1,
        dispatch_fence: 1,
        attempt: 1,
        lease_deadline_ms: 1000,
        purpose: AdmissionPurpose::Execution,
    }
}
// Fixture-only envelope; this does not establish durable binding or readiness.
pub fn provider_admission(a: &RunAdmission) -> ProviderAdmission {
    ProviderAdmission {
        run: a.clone(),
        binding: Binding {
            owner_id: a.owner_id.clone(),
            conversation_id: a.conversation_id.clone(),
            session_id: a.session_id.clone(),
            role: a.role,
            provider_kind: ProviderKind::ExplicitFixture,
            native_session_id: a.native_session_id.clone(),
            parent_session_id: None,
            generation: 1,
            state: SessionState::Busy,
        },
    }
}
pub fn claim(a: &RunAdmission) -> InboxClaim {
    InboxClaim {
        owner_id: a.owner_id.clone(),
        conversation_id: a.conversation_id.clone(),
        message_id: id!(MessageId, 4),
        event_id: id!(EventId, 5),
        consumer_session_id: a.session_id.clone(),
        scope_sequence: 1,
        claim_generation: 1,
        lease_deadline_ms: 1000,
    }
}
pub fn control(a: &RunAdmission) -> orkestr_runtime::ports::InterruptControl {
    let mut token = a.clone();
    token.lease_generation += 1;
    token.dispatch_fence += 1;
    token.purpose = AdmissionPurpose::CancellationAcknowledgement;
    orkestr_runtime::ports::InterruptControl {
        original: a.clone(),
        cancellation: token,
    }
}
#[derive(Default)]
pub struct State {
    pub calls: Vec<&'static str>,
    pub admission_replay: bool,
    pub disposition: Option<AdmissionDisposition>,
    pub run_state: Option<RunState>,
    pub faulty_binding: bool,
    pub fail_once: bool,
    pub lose_ack_once: bool,
    pub refusal: Option<RuntimeStoreError>,
    pub attempts: Vec<ProviderEventInput>,
    pub accepted: Vec<ProviderEventInput>,
}
pub struct Spy {
    pub a: RunAdmission,
    pub state: Mutex<State>,
}
impl Spy {
    pub fn new(a: RunAdmission) -> Self {
        Self {
            a,
            state: Mutex::new(State::default()),
        }
    }
}
#[orkestr_v2_application::runtime::async_trait]
impl RuntimeStore for Spy {
    async fn claim_next(
        &self,
        _: &OwnerId,
        _: &ConversationId,
        _: &SessionId,
        _: Duration,
    ) -> Result<Option<InboxClaim>> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn ensure_role_bindings(&self, _: &OwnerId, _: &ConversationId) -> Result<RoleBindings> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn create_worker_binding(
        &self,
        _: &OwnerId,
        _: &ConversationId,
        _: Option<&SessionId>,
        _: &str,
    ) -> Result<Binding> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn admit_run(
        &self,
        _: &InboxClaim,
        _: &SessionId,
        _: u64,
        _: &str,
    ) -> Result<RunAdmissionResult> {
        let mut state = self.state.lock().unwrap();
        state.calls.push("admitted");
        let disposition = state.disposition.unwrap_or(if state.admission_replay {
            AdmissionDisposition::Replay
        } else {
            AdmissionDisposition::FreshCandidate
        });
        state.admission_replay = true;
        let mut provider = provider_admission(&self.a);
        if state.faulty_binding {
            provider.binding.role = Role::Worker;
        }
        Ok(RunAdmissionResult {
            provider,
            run_state: state.run_state.unwrap_or(RunState::Starting),
            disposition,
            candidate_key: (disposition == AdmissionDisposition::FreshCandidate)
                .then(|| "FAKE-candidate-only".into()),
        })
    }
    async fn bind_native_session(
        &self,
        _: &RunAdmission,
        _: &str,
        _: &str,
    ) -> Result<RunAdmission> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn renew_lease(&self, _: &RunAdmission, _: u64) -> Result<RunAdmission> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn append_provider_event(
        &self,
        owner: &OwnerId,
        admission: &ProviderAdmission,
        input: &ProviderEventInput,
    ) -> Result<ProviderEventReceipt> {
        let a = &admission.run;
        if owner != &a.owner_id || a.run_id != input.run_id || a.session_id != input.session_id {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let mut s = self.state.lock().unwrap();
        s.calls.push("record");
        s.attempts.push(input.clone());
        let previous = s.accepted.iter().position(|i| i.sequence == input.sequence);
        if let Some(index) = previous {
            if s.accepted[index] != *input {
                return Err(RuntimeStoreError::Conflict);
            }
        } else {
            if let Some(error) = s.refusal {
                return Err(error);
            }
            if input.lease_generation != a.lease_generation
                || input.dispatch_fence != a.dispatch_fence
            {
                return Err(RuntimeStoreError::Fenced);
            }
            if !input.is_bounded() || input.sequence != s.accepted.len() as u64 + 1 {
                return Err(RuntimeStoreError::InvalidInput);
            }
            if std::mem::take(&mut s.fail_once) {
                return Err(RuntimeStoreError::Unavailable);
            }
            if matches!(input.event, ProviderEvent::Progress(_)) {
                return Err(RuntimeStoreError::Unavailable);
            }
            s.accepted.push(input.clone());
            if std::mem::take(&mut s.lose_ack_once) {
                return Err(RuntimeStoreError::Unavailable);
            }
        }
        Ok(ProviderEventReceipt {
            event_id: id!(EventId, 5),
            scope_sequence: previous.map_or(s.accepted.len() as i64, |i| i as i64 + 1),
            sequence: input.sequence,
            state: if matches!(input.event, ProviderEvent::CompletedProposal { .. }) {
                RunState::AwaitingAcceptance
            } else {
                RunState::Running
            },
            duplicate: previous.is_some(),
        })
    }
    async fn request_cancel(&self, _: &OwnerId, _: &RunId, _: &str) -> Result<CancelReceipt> {
        self.state.lock().unwrap().calls.push("fenced");
        Ok(CancelReceipt {
            new_fenced_admission: control(&self.a).cancellation,
            state: RunState::CancelRequested,
            inflight_status: InflightStatus::Unknown,
        })
    }
    async fn acknowledge_inbox(&self, _: &InboxClaim, _: &RunAdmission) -> Result<()> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn recover_runtime(
        &self,
        _: &OwnerId,
        _: &str,
        _: i64,
        _: Option<&str>,
        _: u32,
    ) -> Result<RecoveryPage> {
        Err(RuntimeStoreError::Unavailable)
    }
}
pub fn ready<F: Future>(future: F) -> F::Output {
    let waker = Waker::noop();
    let mut cx = Context::from_waker(waker);
    match std::pin::pin!(future).as_mut().poll(&mut cx) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("spy unexpectedly pending"),
    }
}
