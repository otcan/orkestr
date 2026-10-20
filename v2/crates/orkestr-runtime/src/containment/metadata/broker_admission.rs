//! Sealed broker setup admission; never inference authority.
use super::*;
impl MetadataChild {
    pub(crate) fn enable_offline_python(&self) -> Result<(), Error> {
        let state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
        if self.shared.scope.binding.role != orkestr_v2_application::runtime::Role::Worker
            || self.shared.scope.provider != ProviderKind::Codex
            || state.phase != Phase::Setup
            || state.broker_open_attempted
            || !self.broker_launcher
            || self.process.workspace_exec.load(Ordering::Acquire)
        {
            return Err(Error::WrongScope);
        }
        self.process.offline_python.store(true, Ordering::Release);
        Ok(())
    }

    pub(crate) fn enable_workspace_exec(&self) -> Result<(), Error> {
        let state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
        if self.shared.scope.binding.role != orkestr_v2_application::runtime::Role::Worker
            || self.shared.scope.provider != ProviderKind::Codex
            || state.phase != Phase::Setup
            || state.broker_open_attempted
            || !self.broker_launcher
            || self.process.offline_python.load(Ordering::Acquire)
        {
            return Err(Error::WrongScope);
        }
        self.process.workspace_exec.store(true, Ordering::Release);
        Ok(())
    }

    /// Accept only Runtime codec's sealed by-value setup operation. Its lineage
    /// is local process identity, never a reusable Core execution capability.
    pub(crate) fn enqueue_broker_metadata(
        &self,
        request: crate::broker::channel::BrokerMetadataRequest,
    ) -> Result<(), Error> {
        let (lineage, frame) = request.into_submission();
        let result = (|| {
            let mut state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
            let outcome = (|| {
                if !self.broker_launcher
                    || state.phase != Phase::Setup
                    || !state.broker_open_attempted
                    || !Arc::ptr_eq(&lineage, &self.process.broker_lineage)
                {
                    return Err(Error::WrongScope);
                }
                if frame.len() > self.process.max_frame {
                    return Err(Error::FrameTooLarge);
                }
                let canonical = if self.process.offline_python.load(Ordering::Acquire) {
                    super::super::broker_frames::offline::metadata(&frame, &self.process.workspace)?
                } else if self.process.workspace_exec.load(Ordering::Acquire) {
                    super::super::broker_frames::workspace::metadata(
                        &frame,
                        &self.process.workspace,
                    )?
                } else {
                    super::super::broker_frames::metadata(&frame, &self.process.workspace)?
                };
                let grant = state.grant.as_ref().ok_or(Error::Revoked)?;
                self.shared
                    .store
                    .with_metadata_fence(grant, || {
                        self.process
                            .live
                            .lock()
                            .map_err(|_| Error::Revoked)?
                            .framing
                            .enqueue(&canonical)
                    })
                    .map_err(|_| Error::Revoked)?
            })();
            if outcome.is_err() {
                state.phase = Phase::Revoked;
            }
            outcome
        })();
        if result.is_err() {
            self.shared.quarantine(&self.process);
        }
        result
    }
}
