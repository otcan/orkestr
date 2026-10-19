//! Original native-tree witnesses survive every parent turn in one factory.
//! Registry state can only refuse retirement; it cannot manufacture a witness.
use super::*;
use orkestr_runtime::containment::{ExecutionScope, ReapedBroker, RetiringBroker};
use orkestr_v2_contracts::{ConversationId, OwnerId};
use orkestr_v2_store_sqlite::BoundSessionMetadata;
use std::{collections::BTreeMap, sync::Mutex};

const MAX_WITNESSES: usize = 2048;

/// Trusted factory state. Share the same instance across parent continuations.
#[derive(Clone)]
pub struct WorkerReaps(Arc<Mutex<Ledger>>);
struct Ledger {
    owner: OwnerId,
    conversation: ConversationId,
    namespace: String,
    incarnation: Option<String>,
    parents: BTreeMap<String, Parent>,
    current_parent: Option<String>,
    reaped_parents: BTreeMap<String, ReapedBroker>,
    continuing: Option<String>,
    launches: BTreeMap<u64, Launch>,
    frozen: bool,
    poisoned: bool,
}
struct Parent {
    scope: ExecutionScope,
    binding_generation: u64,
    continuation_attempted: bool,
}
struct Launch {
    session: String,
    expected: Option<ExecutionScope>,
    proof: Option<ReapedBroker>,
}

/// One-use retained original parent and descendant proofs, never serializable.
/// Keep this value alive across Core's final retirement transaction.
pub struct WorkerReapProofs {
    _parent: ReapedBroker,
    _prior_parents: Vec<ReapedBroker>,
    _workers: Vec<ReapedBroker>,
}

/// Created before an attempted spawn. Every uncertain exit poisons the ledger.
pub(super) struct LaunchWitness {
    ledger: WorkerReaps,
    id: u64,
    satisfied: bool,
}

impl WorkerReaps {
    pub fn new(owner: OwnerId, conversation: ConversationId, namespace: String) -> Self {
        Self(Arc::new(Mutex::new(Ledger {
            owner,
            conversation,
            namespace,
            incarnation: None,
            parents: BTreeMap::new(),
            current_parent: None,
            reaped_parents: BTreeMap::new(),
            continuing: None,
            launches: BTreeMap::new(),
            frozen: false,
            poisoned: false,
        })))
    }

    pub(super) fn parent(&self, dispatch: &ConsumedProviderDispatch) -> Result<(), &'static str> {
        let run = &dispatch.provider().run;
        let mut ledger = self
            .0
            .lock()
            .map_err(|_| "Worker reap ledger unavailable")?;
        if ledger.frozen
            || ledger.continuing.is_some()
            || ledger.parents.len() >= MAX_WITNESSES
            || run.role != SessionRole::Deep
            || run.owner_id != ledger.owner
            || run.conversation_id != ledger.conversation
            || dispatch.namespace() != ledger.namespace
            || ledger
                .incarnation
                .as_ref()
                .is_some_and(|prior| prior != dispatch.incarnation_id())
        {
            return Err("Worker reap parent scope refused");
        }
        let scope = scope(dispatch)?;
        if ledger.parents.contains_key(scope.run()) {
            return Err("Worker reap parent already registered");
        }
        ledger.incarnation = Some(dispatch.incarnation_id().into());
        ledger.current_parent = Some(scope.run().into());
        ledger.parents.insert(
            scope.run().into(),
            Parent {
                scope,
                binding_generation: dispatch.provider().binding.generation,
                continuation_attempted: false,
            },
        );
        Ok(())
    }

    pub(super) fn launch(
        &self,
        metadata: &BoundSessionMetadata,
        parent: &RunAdmission,
    ) -> Result<LaunchWitness, &'static str> {
        let mut ledger = self
            .0
            .lock()
            .map_err(|_| "Worker reap ledger unavailable")?;
        let binding = metadata.binding();
        if ledger.frozen
            || ledger.continuing.is_some()
            || binding.role != SessionRole::Worker
            || binding.owner_id != ledger.owner
            || binding.conversation_id != ledger.conversation
            || binding.parent_session_id.as_ref() != Some(&parent.session_id)
            || !ledger.parents.contains_key(&parent.run_id.to_string())
            || ledger.current_parent.as_deref() != Some(&parent.run_id.to_string())
            || ledger
                .reaped_parents
                .contains_key(&parent.run_id.to_string())
            || metadata.namespace() != ledger.namespace
            || ledger.incarnation.as_deref() != Some(metadata.incarnation_id())
        {
            return Err("Worker reap launch scope refused");
        }
        let id = ledger.reserve(binding.session_id.to_string())?;
        Ok(LaunchWitness {
            ledger: self.clone(),
            id,
            satisfied: false,
        })
    }

    /// Final context retirement only. Freezes even on refusal; never use this
    /// between accepted parent turns. No future native launch can enter the set.
    pub fn finish(&self, parent: ReapedBroker) -> Result<WorkerReapProofs, &'static str> {
        let mut ledger = self
            .0
            .lock()
            .map_err(|_| "Worker reap ledger unavailable")?;
        let (prior_parents, workers) = ledger.finish(parent.scope())?;
        Ok(WorkerReapProofs {
            _parent: parent,
            _prior_parents: prior_parents,
            _workers: workers,
        })
    }
}

impl Ledger {
    // Include the current parent, even before it is reaped. Historical accepted
    // turns share that native child; stopped continuations add another proof.
    fn proof_count(&self) -> usize {
        1 + self.launches.len() + self.reaped_parents.len()
    }

    fn reserve(&mut self, session: String) -> Result<u64, &'static str> {
        if self.frozen || self.continuing.is_some() || self.proof_count() >= MAX_WITNESSES {
            return Err("Worker reap launch budget unavailable");
        }
        if self.launches.values().any(|entry| entry.session == session) {
            return Err("Worker reap launch identity already registered");
        }
        let id = self.launches.len() as u64;
        self.launches.insert(
            id,
            Launch {
                session,
                expected: None,
                proof: None,
            },
        );
        Ok(id)
    }

    fn finish(
        &mut self,
        parent: &ExecutionScope,
    ) -> Result<(Vec<ReapedBroker>, Vec<ReapedBroker>), &'static str> {
        if std::mem::replace(&mut self.frozen, true)
            || self.poisoned
            || self.continuing.is_some()
            || self.current_parent.as_deref() != Some(parent.run())
            || !self
                .parents
                .get(parent.run())
                .is_some_and(|entry| entry.scope == *parent && !entry.continuation_attempted)
            || self.launches.values().any(|entry| entry.proof.is_none())
        {
            return Err("Worker original native reap evidence is incomplete");
        }
        let workers = std::mem::take(&mut self.launches)
            .into_values()
            .filter_map(|entry| entry.proof)
            .collect();
        Ok((
            std::mem::take(&mut self.reaped_parents)
                .into_values()
                .collect(),
            workers,
        ))
    }
}

#[path = "retirement_continuation.rs"]
mod continuation;

impl LaunchWitness {
    pub(super) fn bind(&mut self, dispatch: &ConsumedProviderDispatch) -> Result<(), &'static str> {
        let run = &dispatch.provider().run;
        let mut ledger = self
            .ledger
            .0
            .lock()
            .map_err(|_| "Worker reap ledger unavailable")?;
        if ledger.frozen
            || run.role != SessionRole::Worker
            || run.owner_id != ledger.owner
            || run.conversation_id != ledger.conversation
            || dispatch.namespace() != ledger.namespace
            || ledger.incarnation.as_deref() != Some(dispatch.incarnation_id())
        {
            return Err("Worker reap execution scope refused");
        }
        let launch = ledger
            .launches
            .get_mut(&self.id)
            .ok_or("Worker reap launch missing")?;
        if launch.expected.is_some() || launch.session != run.session_id.to_string() {
            return Err("Worker reap binding identity changed");
        }
        launch.expected = Some(scope(dispatch)?);
        Ok(())
    }

    fn satisfy(mut self, proof: ReapedBroker) -> Result<(), &'static str> {
        let mut ledger = self
            .ledger
            .0
            .lock()
            .map_err(|_| "Worker reap ledger unavailable")?;
        if ledger.frozen {
            return Err("Worker reap evidence cannot be retained");
        }
        let launch = ledger
            .launches
            .get_mut(&self.id)
            .ok_or("Worker reap launch missing")?;
        if launch.expected.as_ref() != Some(proof.scope()) || launch.proof.is_some() {
            return Err("Worker reap witness identity changed");
        }
        launch.proof = Some(proof);
        self.satisfied = true;
        Ok(())
    }
}
impl Drop for LaunchWitness {
    fn drop(&mut self) {
        if !self.satisfied {
            if let Ok(mut ledger) = self.ledger.0.lock() {
                ledger.poisoned = true;
            }
        }
    }
}

fn scope(dispatch: &ConsumedProviderDispatch) -> Result<ExecutionScope, &'static str> {
    let run = &dispatch.provider().run;
    ExecutionScope::new(
        dispatch.namespace(),
        dispatch.incarnation_id(),
        &run.owner_id.to_string(),
        &run.session_id.to_string(),
        &run.run_id.to_string(),
        run.dispatch_fence,
    )
    .map_err(|_| "Worker reap execution identity invalid")
}

pub(super) struct Retiring {
    broker: RetiringBroker,
    deadline: Instant,
    progress: WorkerProgress,
}
impl Retiring {
    pub(super) fn new(broker: RetiringBroker, progress: WorkerProgress) -> Self {
        Self {
            broker,
            deadline: Instant::now() + Duration::from_secs(3),
            progress,
        }
    }
}
impl WorkerSchedule {
    pub(super) fn retire(
        &mut self,
        mut state: Retiring,
    ) -> Result<(Phase, WorkerProgress), &'static str> {
        if let Some(proof) = state
            .broker
            .poll_reaped()
            .map_err(|_| "Worker native reap unconfirmed")?
        {
            self.launch
                .take()
                .ok_or("Worker launch witness missing")?
                .satisfy(proof)?;
            return Ok((Phase::Closed(state.progress), state.progress));
        }
        if Instant::now() >= state.deadline {
            return Err("Worker native reap deadline exceeded");
        }
        Ok((Phase::Retiring(Box::new(state)), WorkerProgress::Running))
    }
}

#[cfg(test)]
#[path = "retirement_tests.rs"]
mod tests;
