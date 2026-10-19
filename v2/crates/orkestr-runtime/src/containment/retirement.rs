//! Negative authority only: trusted broker EOF cleanup followed by owned wait.
//! Exit 73 is reserved by the reviewed subreaper broker for descendant ECHILD.
use super::{Error, ExecutionScope, OwnedChild};
use std::sync::{atomic::Ordering, Arc};

/// Owns the original child while trusted broker cleanup runs. Dropping early
/// quarantines through the existing reaper, without granting replacement proof.
pub struct RetiringBroker {
    child: OwnedChild,
    completed: bool,
}

/// Non-Clone, non-serializable evidence tied to the original transport scope.
/// This grants no metadata, dispatch, recovery, or native-session authority.
pub struct ReapedBroker {
    scope: ExecutionScope,
}
impl ReapedBroker {
    pub fn scope(&self) -> &ExecutionScope {
        &self.scope
    }
}
impl OwnedChild {
    /// Consume this exact broker lineage. No caller PID or asserted exit status.
    /// The issuer must independently validate terminal/recovery eligibility.
    pub fn retire_broker(self) -> Result<RetiringBroker, Error> {
        if !self.process.broker_launcher.load(Ordering::Acquire) {
            return Err(Error::AuthorityProtocol);
        }
        let mut state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
        let mut live = self.process.live.lock().map_err(|_| Error::Revoked)?;
        if live.child.is_none() {
            return Err(Error::PipeClosed);
        }
        // Transfer cleanup ownership before old Authority::drop can group-kill
        // the broker. No writes or inference remain possible after this point.
        state.revoked = true;
        state.children.retain(|_, weak| {
            weak.upgrade()
                .is_some_and(|p| !Arc::ptr_eq(&p, &self.process))
        });
        live.framing.close();
        live.handoff = None;
        live.provider_writer = None;
        drop(live);
        drop(state);
        Ok(RetiringBroker {
            child: self,
            completed: false,
        })
    }
}
impl RetiringBroker {
    /// Nonblocking owned observation + wait. Pending includes cleanup of adopted
    /// descendants. Any signal/non-proof exit refuses replacement evidence.
    pub fn poll_reaped(&mut self) -> Result<Option<ReapedBroker>, Error> {
        if self.completed {
            return Err(Error::Revoked);
        }
        let mut live = self.child.process.live.lock().map_err(|_| Error::Revoked)?;
        let child = live.child.as_ref().ok_or(Error::PipeClosed)?;
        let Some(exit) = super::sys::observe_exit(child.id())? else {
            return Ok(None);
        };
        let mut child = live.child.take().ok_or(Error::PipeClosed)?;
        // WNOWAIT above keeps identity owned until this exact Child is waited.
        if child.wait().is_err() {
            live.child = Some(child);
            return Err(Error::Io);
        }
        self.child.shared.active.fetch_sub(1, Ordering::AcqRel);
        self.completed = true;
        if exit.code != Some(73) || exit.signal.is_some() {
            return Err(Error::AuthorityProtocol);
        }
        Ok(Some(ReapedBroker {
            scope: self.child.shared.scope.clone(),
        }))
    }
}
