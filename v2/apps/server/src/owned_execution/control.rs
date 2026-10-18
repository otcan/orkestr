//! Live transport availability only. Core authenticates and issues every control.
use crate::control_dispatch::{self, ControlReceiver, ControlSender};
use orkestr_v2_contracts::{ConversationId, ExecutionControlRequest, OwnerId, RunId};
use orkestr_v2_store_sqlite::Store;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(crate) struct ControlGate {
    owner: OwnerId,
    conversation: ConversationId,
    state: Arc<Mutex<State>>,
    scheduling: Arc<tokio::sync::Mutex<()>>,
}
#[derive(Default)]
struct State {
    run: Option<RunId>,
    available: bool,
    replay: Option<ExecutionControlRequest>,
    sender: Option<ControlSender>,
}
pub(super) struct Lifetime(ControlGate);
impl Drop for Lifetime {
    fn drop(&mut self) {
        self.0.disable();
    }
}
impl ControlGate {
    pub(super) fn new(owner: OwnerId, conversation: ConversationId) -> Self {
        Self {
            owner,
            conversation,
            state: Arc::new(Mutex::new(State::default())),
            scheduling: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
    /// Serialize a bounded observation step with authenticated Stop commit and
    /// receipt handoff. Otherwise a normal read could race cancellation and
    /// poison the owned pump before the issued control reaches its receiver.
    /// Never hold this guard while awaiting provider output or owner acceptance.
    pub(crate) async fn serialize(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.scheduling.clone().lock_owned().await
    }
    pub(super) fn lifetime(&self) -> Lifetime {
        Lifetime(self.clone())
    }
    pub(super) fn register(
        &self,
        store: Store,
        run: &RunId,
    ) -> Result<(ControlSender, ControlReceiver), &'static str> {
        let (sender, receiver) = control_dispatch::mailbox(
            store,
            self.owner.clone(),
            self.conversation.clone(),
            run.clone(),
        )
        .map_err(|_| "execution control registration refused")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "execution control registration unavailable")?;
        state.run = Some(run.clone());
        state.available = false;
        state.replay = None;
        state.sender = Some(sender.clone());
        Ok((sender, receiver))
    }
    pub(super) fn set_available(&self, run: &RunId, available: bool) {
        if let Ok(mut state) = self.state.lock() {
            state.available =
                state.run.as_ref() == Some(run) && available && state.replay.is_none();
        }
    }
    pub(super) fn disable(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.available = false;
        }
    }
    pub(crate) fn available(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        run: &RunId,
    ) -> bool {
        *owner == self.owner
            && *conversation == self.conversation
            && self.state.lock().is_ok_and(|state| {
                state.available
                    && state.run.as_ref() == Some(run)
                    && state.sender.as_ref().is_some_and(ControlSender::is_open)
            })
    }
    pub(crate) fn sender(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &ExecutionControlRequest,
    ) -> Option<ControlSender> {
        if *owner != self.owner || *conversation != self.conversation {
            return None;
        }
        let state = self.state.lock().ok()?;
        let permitted = (state.available
            && state.run.as_ref() == Some(&input.run_id)
            && state.sender.as_ref().is_some_and(ControlSender::is_open))
            || state.replay.as_ref().is_some_and(|old| {
                old.run_id == input.run_id
                    && old.request_key == input.request_key
                    && old.expected_revision == input.expected_revision
            });
        permitted.then(|| state.sender.clone()).flatten()
    }
    /// Called only after Core committed this exact authenticated request. The
    /// remembered tuple permits receipt replay after cleanup, never fresh intent.
    pub(crate) fn committed(&self, input: &ExecutionControlRequest) {
        if let Ok(mut state) = self.state.lock() {
            if state.run.as_ref() == Some(&input.run_id) {
                state.available = false;
                state.replay = Some(input.clone());
            }
        }
    }
}
