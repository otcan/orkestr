//! Scheduler availability only. Every actual operation still checks Core auth.
use orkestr_v2_application::runtime::{RunAdmission, SessionRole};
use orkestr_v2_contracts::{ConversationId, OwnerId, RunId};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub struct WorkerTaskAccess {
    owner: OwnerId,
    conversation: ConversationId,
    parents: Arc<Mutex<HashSet<RunId>>>,
}
pub(crate) struct Registration {
    access: WorkerTaskAccess,
    run: RunId,
}
impl WorkerTaskAccess {
    /// Fixed trusted bootstrap scope, never deserialized browser/provider data.
    pub fn new(owner: OwnerId, conversation: ConversationId) -> Self {
        Self {
            owner,
            conversation,
            parents: Arc::new(Mutex::new(HashSet::new())),
        }
    }
    pub fn available(&self, owner: &OwnerId, conversation: &ConversationId, run: &RunId) -> bool {
        owner == &self.owner
            && conversation == &self.conversation
            && self
                .parents
                .lock()
                .is_ok_and(|parents| parents.contains(run))
    }
    pub(crate) fn register(&self, parent: &RunAdmission) -> Result<Registration, &'static str> {
        if parent.role != SessionRole::Deep
            || parent.owner_id != self.owner
            || parent.conversation_id != self.conversation
            || parent.run_id.0.is_nil()
        {
            return Err("Worker task scheduler scope refused");
        }
        let mut parents = self
            .parents
            .lock()
            .map_err(|_| "Worker task registry unavailable")?;
        if parents.len() >= 16 || !parents.insert(parent.run_id.clone()) {
            return Err("Worker task scheduler already owned or capacity exhausted");
        }
        Ok(Registration {
            access: self.clone(),
            run: parent.run_id.clone(),
        })
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut parents) = self.access.parents.lock() {
            parents.remove(&self.run);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parent() -> RunAdmission {
        RunAdmission {
            owner_id: OwnerId(uuid::Uuid::from_u128(1)),
            conversation_id: ConversationId(uuid::Uuid::from_u128(2)),
            run_id: RunId(uuid::Uuid::from_u128(3)),
            session_id: orkestr_v2_contracts::SessionId(uuid::Uuid::from_u128(4)),
            role: SessionRole::Deep,
            native_session_id: Some("synthetic-parent".into()),
            lease_generation: 1,
            dispatch_fence: 1,
            attempt: 1,
            lease_deadline_ms: 1,
            purpose: orkestr_v2_application::runtime::AdmissionPurpose::Execution,
        }
    }
    #[test]
    fn live_availability_is_exact_scope_and_cannot_be_duplicated() {
        let parent = parent();
        let (owner, conversation, run) = (
            parent.owner_id.clone(),
            parent.conversation_id.clone(),
            parent.run_id.clone(),
        );
        let access = WorkerTaskAccess::new(owner.clone(), conversation.clone());
        assert!(!access.available(&owner, &conversation, &run));
        let guard = access.register(&parent).unwrap();
        assert!(access.register(&parent).is_err());
        assert!(access.available(&owner, &conversation, &run));
        assert!(!access.available(&OwnerId(uuid::Uuid::from_u128(4)), &conversation, &run));
        assert!(!access.available(&owner, &ConversationId(uuid::Uuid::from_u128(5)), &run));
        assert!(!access.available(&owner, &conversation, &RunId(uuid::Uuid::from_u128(6))));
        drop(guard);
        assert!(!access.available(&owner, &conversation, &run));
    }

    #[test]
    fn admission_cache_is_bounded_and_rejects_foreign_role_scope() {
        let mut parent = parent();
        let access = WorkerTaskAccess::new(parent.owner_id.clone(), parent.conversation_id.clone());
        parent.role = SessionRole::Worker;
        assert!(access.register(&parent).is_err());
        parent.role = SessionRole::Deep;
        parent.owner_id = OwnerId(uuid::Uuid::from_u128(99));
        assert!(access.register(&parent).is_err());
        parent.owner_id = OwnerId(uuid::Uuid::from_u128(1));
        let mut registrations = Vec::new();
        for id in 10..26 {
            parent.run_id = RunId(uuid::Uuid::from_u128(id));
            registrations.push(access.register(&parent).unwrap());
        }
        parent.run_id = RunId(uuid::Uuid::from_u128(26));
        assert!(access.register(&parent).is_err());
        drop(registrations.pop());
        assert!(access.register(&parent).is_ok());
    }
}
