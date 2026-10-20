//! Local handle selection only. Durable Core fences remain the authority for effects.
use crate::execution_registry::ExecutionScope;
use orkestr_v2_contracts::{ConversationId, OwnerId};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct Generation {
    pub window: Uuid,
    pub number: u64,
}

struct Installed {
    generation: Generation,
    scope: ExecutionScope,
    fast: Option<ExecutionScope>,
}

/// One configured conversation for the entire API process lifetime. Removing a
/// handle never proves cleanup, closes a durable window or issues a replacement.
#[derive(Clone)]
pub(crate) struct Handles {
    owner: OwnerId,
    conversation: ConversationId,
    inner: Arc<Mutex<State>>,
}
#[derive(Default)]
struct State {
    last_generation: u64,
    installed: Option<Installed>,
    poisoned: bool,
}

impl Handles {
    pub(crate) fn new(owner: OwnerId, conversation: ConversationId) -> Result<Self, &'static str> {
        if owner.0.is_nil() || conversation.0.is_nil() {
            return Err("window handles require exact configured scope");
        }
        Ok(Self {
            owner,
            conversation,
            inner: Arc::new(Mutex::new(State::default())),
        })
    }

    pub(crate) fn matches(&self, owner: &OwnerId, conversation: &ConversationId) -> bool {
        owner == &self.owner && conversation == &self.conversation
    }

    /// Called only after exact Core activation. `scope` came from the trusted
    /// configured factory, never from a serialized manager or browser message.
    #[cfg(test)]
    pub(crate) fn install(
        &self,
        generation: Generation,
        scope: ExecutionScope,
    ) -> Result<(), &'static str> {
        self.install_roles(generation, scope, None)
    }

    pub(crate) fn install_roles(
        &self,
        generation: Generation,
        scope: ExecutionScope,
        fast: Option<ExecutionScope>,
    ) -> Result<(), &'static str> {
        if generation.window.is_nil()
            || generation.number == 0
            || scope
                .tasks
                .as_ref()
                .is_some_and(|tasks| !tasks.matches_scope(&self.owner, &self.conversation))
            || scope
                .control
                .as_ref()
                .is_none_or(|c| !c.matches_scope(&self.owner, &self.conversation))
            || fast.as_ref().is_some_and(|scope| {
                scope.tasks.is_some()
                    || scope.control.as_ref().is_none_or(|control| {
                        !control.matches_scope(&self.owner, &self.conversation)
                    })
            })
        {
            return Err("invalid window handle scope");
        }
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "window handle lock poisoned")?;
        if state.poisoned || state.installed.is_some() || generation.number <= state.last_generation
        {
            return Err("window handle replacement refused");
        }
        state.last_generation = generation.number;
        state.installed = Some(Installed {
            generation,
            scope,
            fast,
        });
        Ok(())
    }

    pub(crate) fn snapshot(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Option<ExecutionScope> {
        if !self.matches(owner, conversation) {
            return None;
        }
        let state = self.inner.lock().ok()?;
        if state.poisoned {
            return None;
        }
        state.installed.as_ref().map(|entry| entry.scope.clone())
    }

    pub(crate) fn fast_snapshot(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Option<ExecutionScope> {
        if !self.matches(owner, conversation) {
            return None;
        }
        let state = self.inner.lock().ok()?;
        if state.poisoned {
            return None;
        }
        state.installed.as_ref()?.fast.clone()
    }

    /// Core retirement and the original typed reap must already have succeeded.
    /// An obsolete task cannot remove a newer generation's live handle.
    pub(crate) fn remove(&self, generation: Generation) -> Result<(), &'static str> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "window handle lock poisoned")?;
        if state.poisoned
            || state
                .installed
                .as_ref()
                .is_none_or(|entry| entry.generation != generation)
        {
            return Err("window handle retirement mismatch");
        }
        state.installed = None;
        Ok(())
    }

    /// Uncertain startup, task loss or cleanup is permanent for this process.
    /// Retaining the generation prevents a local restart from minting capacity.
    pub(crate) fn poison(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.poisoned = true;
            state.installed = None;
        }
    }
}

#[cfg(test)]
#[path = "handle_tests.rs"]
mod tests;
