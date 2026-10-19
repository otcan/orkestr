//! Negative local authority only; an exited Ready child cannot admit a turn.
use super::{sys, Error, Phase, ReadyMetadataChild};

impl ReadyMetadataChild {
    pub(crate) fn check_broker_liveness(&self) -> Result<(), Error> {
        let mut state = self.child.shared.state.lock().map_err(|_| Error::Revoked)?;
        if state.phase != Phase::Ready {
            // In particular, never clean up a child transferred to execution.
            return Err(Error::Revoked);
        }
        let observed = {
            let live = self.child.process.live.lock().map_err(|_| Error::Revoked)?;
            sys::observe_exit(live.child.as_ref().ok_or(Error::PipeClosed)?.id())
        };
        match observed {
            Ok(None) => Ok(()),
            ended => {
                state.phase = Phase::Revoked;
                // WNOWAIT keeps the exact group leader pinned until stop hands
                // its original Child to the existing retained-resource reaper.
                // No cleanup witness or Core transition is issued here.
                self.child.process.stop()?;
                Err(ended.err().unwrap_or(Error::PipeClosed))
            }
        }
    }
}
