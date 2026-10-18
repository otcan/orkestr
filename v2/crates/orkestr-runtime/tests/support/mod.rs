#![allow(dead_code)]
//! Ready-future spy only, never a durable store or restart acceptance.
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::{runtime::*, *};
use std::{
    future::Future,
    sync::{Arc, Mutex},
    task::{Context, Poll, Wake, Waker},
};
macro_rules! id {
    ($ty:ty, $n:expr) => {
        serde_json::from_str::<$ty>(&format!("\"00000000-0000-4000-8000-{:012x}\"", $n)).unwrap()
    };
}
pub fn owner() -> OwnerId {
    id!(OwnerId, 1)
}
pub fn admission(role: SessionRole, n: u64) -> ProviderAdmission {
    ProviderAdmission {
        run_id: id!(RunId, n),
        session_id: id!(SessionId, n),
        native_session_ref: format!("FAKE-{n}"),
        lease_generation: 1,
        fence_generation: 1,
        role,
    }
}
pub fn run(a: &ProviderAdmission) -> RunRecord {
    RunRecord {
        run_id: a.run_id.clone(),
        task_id: id!(TaskId, 2),
        conversation_id: id!(ConversationId, 3),
        session_id: a.session_id.clone(),
        state: RunState::Starting,
        version: 1,
        lease_generation: a.lease_generation,
        fence_generation: a.fence_generation,
    }
}
pub fn input(a: &ProviderAdmission) -> RunAdmission {
    let lease = Lease {
        owner_id: owner(),
        session_id: a.session_id.clone(),
        generation: a.lease_generation,
        expires_at_ms: 1000,
    };
    RunAdmission {
        request_key: "fixture-request".into(),
        task_id: id!(TaskId, 2),
        claim: InboxClaim {
            conversation_id: id!(ConversationId, 3),
            message_id: id!(MessageId, 4),
            event_id: id!(EventId, 5),
            sequence: 1,
            text: "fixture".into(),
            lease: lease.clone(),
        },
        execution_lease: lease,
        supervisor: SupervisorAdmission {
            session_id: a.session_id.clone(),
            provider_kind: ProviderKind::ExplicitFixture,
            native_session_ref: a.native_session_ref.clone(),
            protocol_version: "fixture-only".into(),
            supervisor_receipt_ref: "fixture".into(),
        },
    }
}
#[derive(Default)]
pub struct State {
    pub calls: Vec<&'static str>,
    pub fail_once: bool,
    pub refusal: Option<RuntimeStoreError>,
    pub attempts: Vec<ProviderEventInput>,
    pub accepted: Vec<ProviderEventInput>,
}
pub struct Spy {
    pub a: ProviderAdmission,
    pub state: Mutex<State>,
}
impl Spy {
    pub fn new(a: ProviderAdmission) -> Self {
        Self {
            a,
            state: Mutex::new(State::default()),
        }
    }
}
impl RuntimeStore for Spy {
    async fn ensure_role_bindings(&self, _: &OwnerId, _: &ConversationId) -> Result<RoleBindings> {
        Err(RuntimeStoreError::Unsupported)
    }
    async fn confirm_session(
        &self,
        _: &OwnerId,
        _: i64,
        _: &SupervisorAdmission,
    ) -> Result<SessionBinding> {
        Err(RuntimeStoreError::Unsupported)
    }
    async fn allocate_worker(
        &self,
        _: &OwnerId,
        _: &ConversationId,
        _: &str,
    ) -> Result<SessionBinding> {
        Err(RuntimeStoreError::Unsupported)
    }
    async fn lease_session(&self, _: &OwnerId, _: &SessionId, _: i64, _: u32) -> Result<Lease> {
        Err(RuntimeStoreError::Unsupported)
    }
    async fn claim_inbox(&self, _: &Lease, _: &ConversationId) -> Result<Option<InboxClaim>> {
        Err(RuntimeStoreError::Unsupported)
    }
    async fn admit_run(&self, _: &OwnerId, _: &RunAdmission) -> Result<RunRecord> {
        self.state.lock().unwrap().calls.push("admitted");
        Ok(run(&self.a))
    }
    async fn renew_lease(&self, _: &Lease, _: u32) -> Result<Lease> {
        Err(RuntimeStoreError::Unsupported)
    }
    async fn append_provider_event(
        &self,
        _: &OwnerId,
        input: &ProviderEventInput,
    ) -> Result<ProviderEventReceipt> {
        let mut s = self.state.lock().unwrap();
        s.calls.push("record");
        s.attempts.push(input.clone());
        if let Some(error) = s.refusal {
            return Err(error);
        }
        if std::mem::take(&mut s.fail_once) {
            return Err(RuntimeStoreError::Unavailable);
        }
        s.accepted.push(input.clone());
        Ok(ProviderEventReceipt {
            event_id: id!(EventId, 5),
            run: run(&self.a),
        })
    }
    async fn request_cancel(&self, _: &OwnerId, _: &RunId, _: i64) -> Result<CancelReceipt> {
        self.state.lock().unwrap().calls.push("fenced");
        let mut r = run(&self.a);
        r.fence_generation += 1;
        r.state = RunState::CancelRequested;
        Ok(CancelReceipt {
            run: r,
            in_flight_effects_unknown: true,
        })
    }
    async fn check_run_fence(&self, _: &OwnerId, _: &RunId, _: i64, _: i64) -> Result<RunRecord> {
        Err(RuntimeStoreError::Unsupported)
    }
    async fn recover_expired(&self, _: &OwnerId, _: u32) -> Result<Vec<RecoveryRecord>> {
        Err(RuntimeStoreError::Unsupported)
    }
}
struct NoWake;
impl Wake for NoWake {
    fn wake(self: Arc<Self>) {}
}
/// These spies are immediately ready; a pending future is a test failure.
pub fn ready<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(NoWake));
    let mut cx = Context::from_waker(&waker);
    match std::pin::pin!(future).as_mut().poll(&mut cx) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("spy unexpectedly pending"),
    }
}
