//! Parent-polled first-turn Deep scheduling using only ordinary Store authority.
//! No detached tasks, browser-selected native IDs, or replay redispatch.
use super::{LiveClaudeExecution, PreparingClaudeExecution};
use orkestr_runtime::{containment::ChildDirectories, ports::Blocker, supervisor};
use orkestr_v2_application::runtime::{
    AdmissionDisposition, AdmissionPurpose, DispatchClaimResult, ProviderKind, Role, RunState,
    RuntimeStore, RuntimeStoreError,
};
use orkestr_v2_contracts::{ConversationId, OwnerId, RunId};
use orkestr_v2_store_sqlite::{ExecutionConsumption, Store};
use std::{path::Path, time::Duration};

enum State {
    Preparing(Box<PreparingClaudeExecution>),
    Live(Box<LiveClaudeExecution>),
    Ready(Box<super::ReadyClaudeExecution>),
    Refused,
}
pub struct ClaudeSchedule {
    store: Store,
    owner: OwnerId,
    conversation: ConversationId,
    run: Option<RunId>,
    state: State,
}
impl ClaudeSchedule {
    /// Setup is for the exact ordinary Deep binding. Caller must configure the
    /// immutable launcher/account route; system/init does not prove auth.
    pub async fn open_retained(
        store: Store,
        owner: OwnerId,
        conversation: ConversationId,
        launcher: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
    ) -> Result<Self, supervisor::Error> {
        let binding = store
            .ensure_role_bindings(&owner, &conversation)
            .await
            .map_err(supervisor::Error::Store)?
            .deep;
        if binding.role != Role::Deep {
            return Err(supervisor::Error::Store(RuntimeStoreError::Fenced));
        }
        let grant = store
            .authorize_session_metadata(&binding)
            .await
            .map_err(supervisor::Error::Store)?;
        if grant.provider() != ProviderKind::Claude {
            return Err(supervisor::Error::Store(RuntimeStoreError::Fenced));
        }
        let preparing = PreparingClaudeExecution::open_retained(
            store.clone(),
            grant,
            launcher,
            directories,
            resources,
        )
        .map_err(|_| supervisor::Error::Provider(Blocker::Protocol))?;
        Ok(Self {
            store,
            owner,
            conversation,
            run: None,
            state: State::Preparing(Box::new(preparing)),
        })
    }
    pub fn run_id(&self) -> Option<&RunId> {
        self.run.as_ref()
    }
    /// One bounded setup/pump step, or one atomic claim/admit/reserve/consume
    /// sequence. A missing input keeps the ready owned child without inference.
    pub async fn tick(&mut self) -> Result<bool, supervisor::Error> {
        let state = std::mem::replace(&mut self.state, State::Refused);
        match state {
            State::Preparing(mut preparing) => {
                if !preparing
                    .poll_ready()
                    .map_err(|_| supervisor::Error::Provider(Blocker::Protocol))?
                {
                    self.state = State::Preparing(preparing);
                    return Ok(false);
                }
                // Confirmation consumes setup once. The ready state is retained
                // separately while waiting for a queued immutable owner message.
                let ready = (*preparing)
                    .confirm()
                    .await
                    .map_err(|_| supervisor::Error::Provider(Blocker::Protocol))?;
                self.start_ready(ready).await
            }
            State::Ready(ready) => self.start_ready(*ready).await,
            State::Live(mut live) => {
                let result = live.tick().await;
                // Busy/Unavailable keep the original pending input in the pump.
                self.state = State::Live(live);
                result
            }
            State::Refused => Err(supervisor::Error::Provider(Blocker::Protocol)),
        }
    }
    async fn start_ready(
        &mut self,
        ready: super::ReadyClaudeExecution,
    ) -> Result<bool, supervisor::Error> {
        let binding = self
            .store
            .ensure_role_bindings(&self.owner, &self.conversation)
            .await
            .map_err(supervisor::Error::Store)?
            .deep;
        let Some(claim) = self
            .store
            .claim_next(
                &self.owner,
                &self.conversation,
                &binding.session_id,
                Duration::from_secs(60),
            )
            .await
            .map_err(supervisor::Error::Store)?
        else {
            self.state = State::Ready(Box::new(ready));
            return Ok(false);
        };
        let request = format!("claude:{}", claim.event_id);
        let admitted = self
            .store
            .admit_run(&claim, &binding.session_id, binding.generation, &request)
            .await
            .map_err(supervisor::Error::Store)?;
        let run = &admitted.provider.run;
        if run.owner_id != self.owner
            || run.conversation_id != self.conversation
            || run.session_id != binding.session_id
            || run.role != Role::Deep
            || run.purpose != AdmissionPurpose::Execution
            || admitted.run_state != RunState::Starting
            || admitted.disposition != AdmissionDisposition::FreshCandidate
        {
            return Err(supervisor::Error::Provider(Blocker::DispatchUnconfirmed));
        }
        let DispatchClaimResult::Reserved(reservation) = self
            .store
            .claim_provider_dispatch(&admitted, &request)
            .await
            .map_err(supervisor::Error::Store)?
        else {
            return Err(supervisor::Error::Provider(Blocker::DispatchUnconfirmed));
        };
        let ExecutionConsumption::Dispatch(cap) = self
            .store
            .consume_execution(&reservation)
            .await
            .map_err(supervisor::Error::Store)?
        else {
            return Err(supervisor::Error::Provider(Blocker::DispatchUnconfirmed));
        };
        self.run = Some(cap.provider().run.run_id.clone());
        let live = ready
            .attach(cap)
            .map_err(|_| supervisor::Error::Provider(Blocker::Protocol))?;
        self.state = State::Live(Box::new(live));
        Ok(true)
    }
}
