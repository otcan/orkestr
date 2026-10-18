//! Bounded live transport availability, not cancellation authority. HTTP must
//! authenticate again in Core after acquiring the exact registered run's lock.
use crate::control_dispatch::{self, ControlReceiver, ControlSender, HandoffError};
use orkestr_v2_application::runtime::CancelReceipt;
use orkestr_v2_contracts::{ConversationId, ExecutionControlRequest, OwnerId, RunId};
use orkestr_v2_store_sqlite::Store;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

const MAX_ACTIVE: usize = 16;
const MAX_RETIRED: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistryError {
    Capacity,
    Conflict,
    Closed,
    Unavailable,
    Handoff(HandoffError),
}

#[derive(Clone)]
pub struct ControlRegistry {
    owner: OwnerId,
    conversation: ConversationId,
    entries: Arc<Mutex<Entries>>,
}
#[derive(Default)]
struct Entries {
    runs: HashMap<RunId, Arc<Entry>>,
    active: usize,
    retired: VecDeque<RunId>,
}
struct Entry {
    state: Mutex<State>,
    scheduling: Arc<tokio::sync::Mutex<()>>,
}
struct State {
    active: bool,
    available: bool,
    replay: Option<ExecutionControlRequest>,
    sender: ControlSender,
}

/// Non-Clone lifetime owned by one actual child. Dropping it denies new intent
/// and retires its bounded replay entry; it never reports native termination.
pub struct RunControl {
    registry: ControlRegistry,
    run: RunId,
    entry: Arc<Entry>,
}

/// One immutable browser request selection, still requiring current Core auth.
/// No mutex is held across selection/authentication/await boundaries.
pub struct RequestedControl {
    input: ExecutionControlRequest,
    entry: Arc<Entry>,
}

impl ControlRegistry {
    pub fn new(owner: OwnerId, conversation: ConversationId) -> Self {
        Self {
            owner,
            conversation,
            entries: Arc::new(Mutex::new(Entries::default())),
        }
    }

    /// Trusted factory only, after exact owned native attachment. Active entries
    /// are never evicted; full capacity refuses rather than creating a queue.
    pub fn register(
        &self,
        store: Store,
        run: &RunId,
    ) -> Result<(RunControl, ControlReceiver), RegistryError> {
        let (sender, receiver) = control_dispatch::mailbox(
            store,
            self.owner.clone(),
            self.conversation.clone(),
            run.clone(),
        )
        .map_err(RegistryError::Handoff)?;
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| RegistryError::Unavailable)?;
        if entries.runs.contains_key(run) {
            return Err(RegistryError::Conflict);
        }
        if entries.active >= MAX_ACTIVE {
            return Err(RegistryError::Capacity);
        }
        let entry = Arc::new(Entry {
            state: Mutex::new(State {
                active: true,
                available: false,
                replay: None,
                sender,
            }),
            scheduling: Arc::new(tokio::sync::Mutex::new(())),
        });
        entries.active += 1;
        entries.runs.insert(run.clone(), Arc::clone(&entry));
        Ok((
            RunControl {
                registry: self.clone(),
                run: run.clone(),
                entry,
            },
            receiver,
        ))
    }

    fn entry(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        run: &RunId,
    ) -> Option<Arc<Entry>> {
        if owner != &self.owner || conversation != &self.conversation {
            return None;
        }
        self.entries.lock().ok()?.runs.get(run).cloned()
    }

    pub fn available(&self, owner: &OwnerId, conversation: &ConversationId, run: &RunId) -> bool {
        self.entry(owner, conversation, run).is_some_and(|entry| {
            entry
                .state
                .lock()
                .is_ok_and(|state| state.fresh_available())
        })
    }

    pub fn request(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &ExecutionControlRequest,
    ) -> Option<RequestedControl> {
        if !input.is_valid() {
            return None;
        }
        let request = RequestedControl {
            entry: self.entry(owner, conversation, &input.run_id)?,
            input: input.clone(),
        };
        request.is_permitted().then_some(request)
    }
}

impl State {
    fn fresh_available(&self) -> bool {
        self.active && self.available && self.replay.is_none() && self.sender.is_open()
    }
    fn permits(&self, input: &ExecutionControlRequest) -> bool {
        self.fresh_available()
            || self.replay.as_ref().is_some_and(|old| {
                old.run_id == input.run_id
                    && old.request_key == input.request_key
                    && old.expected_revision == input.expected_revision
                    && old.expected_control_revision == input.expected_control_revision
            })
    }
}

impl RunControl {
    /// Serialize one bounded pump step against HTTP commit plus receipt handoff.
    /// Parent composition acquires Deep then Worker, never the reverse order.
    pub async fn serialize(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.entry.scheduling.clone().lock_owned().await
    }
    pub fn set_available(&self, available: bool) {
        if let Ok(mut state) = self.entry.state.lock() {
            state.available = state.active && available && state.replay.is_none();
        }
    }
    pub fn disable(&self) {
        self.set_available(false);
    }
    /// Local shutdown/deadline uses the exact Core-issued receipt too. This does
    /// not invent a browser request tuple or grant subsequent fresh HTTP intent.
    pub fn publish(&self, receipt: CancelReceipt) -> Result<(), RegistryError> {
        let mut state = self
            .entry
            .state
            .lock()
            .map_err(|_| RegistryError::Unavailable)?;
        if !state.active {
            return Err(RegistryError::Closed);
        }
        state
            .sender
            .publish(receipt)
            .map_err(RegistryError::Handoff)?;
        state.available = false;
        Ok(())
    }
}

impl RequestedControl {
    pub async fn serialize(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.entry.scheduling.clone().lock_owned().await
    }
    /// Required after acquiring the lock: lifecycle cleanup may have happened
    /// while HTTP was waiting. Current authentication is still Core's job.
    pub fn is_permitted(&self) -> bool {
        self.entry
            .state
            .lock()
            .is_ok_and(|state| state.permits(&self.input))
    }
    /// Call only with Core's same-transaction committed cancellation receipt.
    /// Publication and remembering this exact request are one local operation.
    /// Receipt replay after closure never requeues an interrupt.
    pub fn publish(&self, receipt: CancelReceipt) -> Result<(), RegistryError> {
        let mut state = self
            .entry
            .state
            .lock()
            .map_err(|_| RegistryError::Unavailable)?;
        if !state.permits(&self.input) {
            return Err(RegistryError::Closed);
        }
        state
            .sender
            .publish(receipt)
            .map_err(RegistryError::Handoff)?;
        state.available = false;
        state.replay = Some(self.input.clone());
        Ok(())
    }
}

impl Drop for RunControl {
    fn drop(&mut self) {
        // Never hold entry and registry locks together. Selection takes the map
        // only long enough to clone an Arc, then checks entry state separately.
        if let Ok(mut state) = self.entry.state.lock() {
            state.active = false;
            state.available = false;
        }
        if let Ok(mut entries) = self.registry.entries.lock() {
            if entries
                .runs
                .get(&self.run)
                .is_some_and(|entry| Arc::ptr_eq(entry, &self.entry))
            {
                entries.active -= 1;
                entries.retired.push_back(self.run.clone());
                while entries.retired.len() > MAX_RETIRED {
                    if let Some(oldest) = entries.retired.pop_front() {
                        entries.runs.remove(&oldest);
                    }
                }
            }
        }
    }
}
