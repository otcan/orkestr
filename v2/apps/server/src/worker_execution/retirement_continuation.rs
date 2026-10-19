//! A stopped parent spends original cleanup evidence once, without final freeze.
use super::*;
use orkestr_v2_application::runtime::SessionState;

/// Owns an uncertain reservation until its typed Core result is retained. A
/// cancelled future cannot reopen this ledger or discard historical evidence.
struct Continuation {
    ledger: WorkerReaps,
    run: String,
    binding: Binding,
    completed: bool,
}

impl WorkerReaps {
    /// Trusted factory only. This method retains the original parent proof and
    /// every prior Worker proof through Core's current-auth metadata reservation.
    /// It issues no inference and never resets or freezes the cumulative ledger.
    pub async fn stopped_metadata(
        &self,
        store: &Store,
        credential: &str,
        run: &RunId,
        parent: ReapedBroker,
        binding: &Binding,
    ) -> Result<BoundSessionMetadata, &'static str> {
        let pending = self.continuation(run, parent, binding)?;
        let metadata = store
            .authorize_stopped_session_metadata(credential, run, binding)
            .await
            .map_err(|_| "Worker stopped metadata reservation refused")?;
        pending.complete(metadata)
    }

    fn continuation(
        &self,
        run: &RunId,
        parent: ReapedBroker,
        binding: &Binding,
    ) -> Result<Continuation, &'static str> {
        let mut ledger = self
            .0
            .lock()
            .map_err(|_| "Worker reap ledger unavailable")?;
        if parent.scope().run() != run.to_string() {
            return Err("Worker stopped parent locator changed");
        }
        ledger.can_continue(parent.scope(), binding)?;
        let key = parent.scope().run().to_owned();
        // No mutation precedes the complete refusal checks, including capacity.
        ledger
            .parents
            .get_mut(&key)
            .ok_or("Worker stopped parent missing")?
            .continuation_attempted = true;
        ledger.continuing = Some(key.clone());
        ledger.reaped_parents.insert(key.clone(), parent);
        Ok(Continuation {
            ledger: self.clone(),
            run: key,
            binding: binding.clone(),
            completed: false,
        })
    }
}

impl Ledger {
    fn can_continue(&self, parent: &ExecutionScope, binding: &Binding) -> Result<(), &'static str> {
        let prior = self
            .parents
            .get(parent.run())
            .ok_or("Worker stopped parent unregistered")?;
        if self.frozen
            || self.poisoned
            || self.continuing.is_some()
            || self.current_parent.as_deref() != Some(parent.run())
            || prior.scope != *parent
            || prior.continuation_attempted
            || self.reaped_parents.contains_key(parent.run())
            // Retain this parent plus room for its replacement's final proof.
            || self.proof_count() >= MAX_WITNESSES
            || self.launches.values().any(|entry| entry.proof.is_none())
            || binding.role != SessionRole::Deep
            || binding.state != SessionState::Ready
            || binding.owner_id != self.owner
            || binding.conversation_id != self.conversation
            || binding.session_id.to_string() != parent.session()
            || binding.parent_session_id.is_some()
            || binding.native_session_id.is_none()
            || Some(binding.generation) != prior.binding_generation.checked_add(1)
        {
            return Err("Worker stopped continuation evidence refused");
        }
        Ok(())
    }
}

impl Continuation {
    fn complete(
        mut self,
        metadata: BoundSessionMetadata,
    ) -> Result<BoundSessionMetadata, &'static str> {
        {
            let mut ledger = self
                .ledger
                .0
                .lock()
                .map_err(|_| "Worker reap ledger unavailable")?;
            if ledger.frozen
                || ledger.poisoned
                || ledger.continuing.as_deref() != Some(&self.run)
                || ledger.current_parent.as_deref() != Some(&self.run)
                || !ledger.reaped_parents.contains_key(&self.run)
                || metadata.binding() != &self.binding
                || metadata.namespace() != ledger.namespace
                || Some(metadata.incarnation_id()) != ledger.incarnation.as_deref()
            {
                return Err("Worker stopped metadata handoff changed");
            }
            // The immutable attempted marker and original parent/Worker proofs
            // remain. Only the pending handoff ends; final freeze stays separate.
            ledger.continuing = None;
            self.completed = true;
        }
        Ok(metadata)
    }
}

impl Drop for Continuation {
    fn drop(&mut self) {
        if !self.completed {
            if let Ok(mut ledger) = self.ledger.0.lock() {
                ledger.poisoned = true;
                // Keep the in-flight marker: even cancellation after a durable
                // reservation must never permit another attempt or final freeze.
            }
        }
    }
}

#[cfg(test)]
#[path = "retirement_continuation_tests.rs"]
mod tests;
