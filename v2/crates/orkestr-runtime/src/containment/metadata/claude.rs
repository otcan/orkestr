//! Process initialization reserves a UUID; it never confirms native observation.
use super::*;
use orkestr_v2_store_sqlite::ClaudeProcessInitialization;

impl MetadataChild {
    pub(crate) async fn initialize_claude(
        self,
        evidence: ClaudeProcessInitialization,
    ) -> Result<ReadyMetadataChild, Error> {
        let grant = {
            let mut state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
            if state.phase != Phase::Setup {
                return Err(Error::Revoked);
            }
            let live = self.process.live.lock().map_err(|_| Error::Revoked)?;
            if !live.framing.queue.is_empty() {
                return Err(Error::Backpressure);
            }
            state.phase = Phase::Confirming;
            state.grant.take().ok_or(Error::Revoked)?
        };
        let result = self
            .shared
            .store
            .initialize_claude_session(grant, evidence)
            .await;
        match result {
            Ok(transition) => {
                let mut state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
                if state.phase != Phase::Confirming {
                    drop(state);
                    self.shared.quarantine(&self.process);
                    return Err(Error::Revoked);
                }
                state.phase = Phase::Ready;
                drop(state);
                Ok(ReadyMetadataChild {
                    child: self,
                    transition: Some(transition),
                })
            }
            Err(_) => {
                self.shared.quarantine(&self.process);
                Err(Error::Revoked)
            }
        }
    }
}
