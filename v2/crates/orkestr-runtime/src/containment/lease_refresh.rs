//! Same-run freshness transfer; this cannot submit a frame or start a process.
use super::scope::{Shared, State};
use super::*;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

impl OwnedChild {
    // The caller must obtain the new fence from Core's sealed lease transition.
    // Lease generation changes independently of the immutable dispatch scope.
    #[allow(
        dead_code,
        reason = "sealed Core renewal adapter is integrated separately"
    )]
    pub(crate) fn refresh_lease_fence(
        self,
        scope: &ExecutionScope,
        fence: Arc<dyn DispatchFence>,
    ) -> Result<(Authority, Self), Error> {
        let result = (|| {
            if scope != &self.shared.scope {
                return Err(Error::WrongScope);
            }
            let shared = Arc::new(Shared {
                scope: scope.clone(),
                fence,
                state: Mutex::new(State {
                    revoked: false,
                    children: BTreeMap::new(),
                    next: 2,
                }),
                active: self.shared.active.clone(),
                maximum: 1,
                reaper: self.shared.reaper.clone(),
            });
            // New durable fence -> new local state -> old local state -> child.
            // Never invoke the expired old durable fence during transfer.
            shared.dispatch(scope, |current| {
                let mut old = self.shared.state.lock().map_err(|_| Error::Revoked)?;
                self.shared.check(scope, &old)?;
                if old.children.len() != 1
                    || !old
                        .children
                        .values()
                        .next()
                        .and_then(std::sync::Weak::upgrade)
                        .is_some_and(|child| Arc::ptr_eq(&child, &self.process))
                {
                    return Err(Error::WrongScope);
                }
                let live = self.process.live.lock().map_err(|_| Error::Revoked)?;
                let child = live.child.as_ref().ok_or(Error::PipeClosed)?;
                if sys::observe_exit(child.id())?.is_some()
                    || live.provider_writer.is_none()
                    || live.handoff.is_some()
                    || live.framing.broken
                    || !live.framing.queue.is_empty()
                {
                    return Err(Error::Revoked);
                }
                current.children.insert(1, Arc::downgrade(&self.process));
                old.children.clear();
                old.revoked = true;
                Ok(())
            })?;
            Ok((
                Authority {
                    shared: shared.clone(),
                },
                Self {
                    shared,
                    process: self.process.clone(),
                },
            ))
        })();
        if result.is_err() {
            // Includes an outer COMMIT error after local transfer. No old or
            // new handle is returned, and the actual writer is closed.
            self.quarantine();
        }
        result
    }
}
