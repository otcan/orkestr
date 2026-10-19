//! Transfer one live owned child; no spawn, metadata replay or fresh authority.
use super::scope::{Shared, State};
use super::*;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

impl OwnedChild {
    /// The sealed turn owns a NEW Core capability and the matching StoreFence.
    /// The old local authority is retired in the same fenced enqueue operation,
    /// so a retained old Authority cannot signal the transferred process.
    pub(crate) fn reattach_turn<D: ConsumedTurn>(
        self,
        previous: &ExecutionScope,
        turn: D,
        fence: Arc<dyn DispatchFence>,
    ) -> Result<(Authority, Self), TurnFailure> {
        let result = (|| {
            let lineage = turn.broker_lineage();
            let (scope, frame) = turn.into_submission();
            if previous != &self.shared.scope
                || scope.namespace() != previous.namespace()
                || scope.incarnation_id() != previous.incarnation_id()
                || scope.owner() != previous.owner()
                || scope.session() != previous.session()
                || scope.run() == previous.run()
                || frame.len() > self.process.max_frame
            {
                return Err(Error::WrongScope);
            }
            let canonical = broker_frames::turn(&frame, lineage.as_ref(), &self.process)?;
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
            // Current durable NEW-run fence -> new authority -> old authority
            // -> owned process. No wait for provider acknowledgement occurs here.
            shared.dispatch(&scope, |execution| {
                let mut old = self.shared.state.lock().map_err(|_| Error::Revoked)?;
                self.shared.check(previous, &old)?;
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
                let mut live = self.process.live.lock().map_err(|_| Error::Revoked)?;
                let child = live.child.as_ref().ok_or(Error::PipeClosed)?;
                if sys::observe_exit(child.id())?.is_some()
                    || live.provider_writer.is_none()
                    || live.handoff.is_some()
                    || live.framing.broken
                    || !live.framing.queue.is_empty()
                {
                    return Err(Error::Revoked);
                }
                live.framing.enqueue(&canonical)?;
                execution.children.insert(1, Arc::downgrade(&self.process));
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
            // Includes uncertain outer COMMIT after enqueue: close the writer
            // and quarantine; never return the capability or replay the frame.
            self.quarantine();
        }
        result.map_err(|cause| TurnFailure { cause })
    }
}
