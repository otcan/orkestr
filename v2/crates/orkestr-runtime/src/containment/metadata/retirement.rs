//! Original setup-child EOF/wait evidence, with no fabricated execution scope.
use super::*;

pub struct RetiringMetadata {
    child: MetadataChild,
    completed: bool,
}

/// Non-Clone negative evidence only. No setup, inference or recovery authority.
pub struct ReapedMetadata {
    scope: MetadataScope,
}
impl ReapedMetadata {
    pub fn binding(&self) -> &Binding {
        &self.scope.binding
    }
    pub fn namespace(&self) -> &str {
        &self.scope.namespace
    }
    pub fn incarnation_id(&self) -> &str {
        &self.scope.incarnation
    }
}

impl MetadataChild {
    pub(crate) fn retire_broker(self) -> Result<RetiringMetadata, Error> {
        if !self.broker_launcher || !self.process.broker_launcher.load(Ordering::Acquire) {
            return Err(Error::AuthorityProtocol);
        }
        let mut state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
        if !matches!(state.phase, Phase::Setup | Phase::Ready) {
            return Err(Error::Revoked);
        }
        let original = state
            .process
            .as_ref()
            .and_then(Weak::upgrade)
            .ok_or(Error::Revoked)?;
        if !Arc::ptr_eq(&original, &self.process) {
            return Err(Error::WrongScope);
        }
        let mut live = self.process.live.lock().map_err(|_| Error::Revoked)?;
        if live.child.is_none() {
            return Err(Error::PipeClosed);
        }
        // Remove metadata authority's stop membership before its Drop. The
        // exact original child stays owned here until trusted EOF cleanup ends.
        state.phase = Phase::Revoked;
        state.process = None;
        state.grant = None;
        live.framing.close();
        live.handoff = None;
        live.provider_writer = None;
        drop(live);
        drop(state);
        Ok(RetiringMetadata {
            child: self,
            completed: false,
        })
    }
}

impl ReadyMetadataChild {
    pub(crate) fn retire_broker(self) -> Result<RetiringMetadata, Error> {
        self.child.retire_broker()
    }
}

impl RetiringMetadata {
    pub fn poll_reaped(&mut self) -> Result<Option<ReapedMetadata>, Error> {
        if self.completed {
            return Err(Error::Revoked);
        }
        let mut live = self.child.process.live.lock().map_err(|_| Error::Revoked)?;
        let original = live.child.as_ref().ok_or(Error::PipeClosed)?;
        let Some(exit) = sys::observe_exit(original.id())? else {
            return Ok(None);
        };
        let mut original = live.child.take().ok_or(Error::PipeClosed)?;
        if original.wait().is_err() {
            live.child = Some(original);
            return Err(Error::Io);
        }
        self.child.shared.active.fetch_sub(1, Ordering::AcqRel);
        self.completed = true;
        if exit.code != Some(73) || exit.signal.is_some() {
            return Err(Error::AuthorityProtocol);
        }
        Ok(Some(ReapedMetadata {
            scope: self.child.shared.scope.clone(),
        }))
    }
}
