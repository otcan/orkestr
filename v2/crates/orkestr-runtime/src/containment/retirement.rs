//! Negative authority only: trusted broker EOF cleanup followed by owned wait.
//! Exit 73 is reserved by the reviewed subreaper broker for descendant ECHILD.
use super::{Error, ExecutionScope, OwnedChild};
use std::sync::{atomic::Ordering, Arc};

/// Owns the original child while trusted broker cleanup runs. Dropping early
/// quarantines through the existing reaper, without granting replacement proof.
pub struct RetiringBroker {
    child: OwnedChild,
    completed: bool,
    /// Claimed through `retire_ended_broker`: the broker had already exited
    /// with a native-ended-and-reaped status before this retirement.
    ended: bool,
}

/// Broker exits 218..=223: the native ended on its own (the low part is the
/// broker's diagnostic native state) and the broker, as subreaper, then
/// reaped its whole owned tree to ECHILD. Like exit 73 it proves cleanup;
/// unlike 73 it was not requested, so only an idle caller may claim it.
pub const NATIVE_ENDED_REAPED: std::ops::RangeInclusive<i32> = 218..=223;

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
            ended: false,
        })
    }

    /// The broker already exited on its own (idle native death: OOM, a
    /// resource-monitor kill). Accept only the broker's own native-ended
    /// ECHILD status; a signal, 0 or any failure class stays unproven.
    pub fn retire_ended_broker(self) -> Result<RetiringBroker, Error> {
        {
            let live = self.process.live.lock().map_err(|_| Error::Revoked)?;
            let child = live.child.as_ref().ok_or(Error::PipeClosed)?;
            let exit = super::sys::observe_exit(child.id())?.ok_or(Error::AuthorityProtocol)?;
            if exit.signal.is_some()
                || !exit
                    .code
                    .is_some_and(|code| NATIVE_ENDED_REAPED.contains(&code))
            {
                return Err(Error::AuthorityProtocol);
            }
        }
        let mut retiring = self.retire_broker()?;
        retiring.ended = true;
        Ok(retiring)
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
        let proven = exit.code == Some(73)
            || (self.ended
                && exit
                    .code
                    .is_some_and(|code| NATIVE_ENDED_REAPED.contains(&code)));
        if !proven || exit.signal.is_some() {
            // Exit status only (a broker failure class 80..217, 0 or a signal):
            // the one diagnostic for an unconfirmed native-tree retirement.
            eprintln!(
                "broker retirement not proven: exit code {:?} signal {:?}",
                exit.code, exit.signal
            );
            return Err(Error::AuthorityProtocol);
        }
        Ok(Some(ReapedBroker {
            scope: self.child.shared.scope.clone(),
        }))
    }
}
