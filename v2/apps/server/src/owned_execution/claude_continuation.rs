//! Accepted Claude turns resume only after the exact prior native tree is gone.
use super::*;
use orkestr_v2_application::runtime::RuntimeStore;
use std::time::Instant;

impl ConfiguredExecution {
    pub(super) async fn run_claude(
        mut self,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<(), &'static str> {
        let mut heartbeat = Instant::now();
        self.maintain(&mut heartbeat).await?;
        let mut grant = if let Some(grant) = self.initial_grant.take() {
            // Restart authority is already sealed to the accepted predecessor.
            // Accepted history by itself must not start another native process.
            if !self.wait_eligible(&mut shutdown, &mut heartbeat).await? {
                return Ok(());
            }
            grant
        } else {
            let binding = self
                .store
                .ensure_role_bindings(&self.owner, &self.config.conversation_id)
                .await
                .map_err(|_| "Claude binding unavailable")?
                .deep;
            self.store
                .authorize_session_metadata(&binding)
                .await
                .map_err(|_| "Claude setup authority refused")?
        };
        loop {
            let Some(ready) = self
                .prepare_claude(grant, &mut shutdown, &mut heartbeat)
                .await?
            else {
                return Ok(());
            };
            let Some((run, proof)) = self
                .drive_claude(ready, &mut shutdown, &mut heartbeat)
                .await?
            else {
                return Ok(());
            };
            // Old queued input remains ordinary durable FIFO input. Held input
            // is never made eligible by acceptance, reap, or a process restart.
            if !self.wait_eligible(&mut shutdown, &mut heartbeat).await? {
                self.retire_accepted(&run, proof).await?;
                return Ok(());
            }
            self.current().await?;
            let binding = self
                .store
                .ensure_role_bindings(&self.owner, &self.config.conversation_id)
                .await
                .map_err(|_| "Claude continuation binding unavailable")?
                .deep;
            grant = self
                .store
                .authorize_accepted_session_metadata(&self.token, &run, &binding)
                .await
                .map_err(|_| "Claude accepted-session continuation refused")?;
            // The owned tree proof is consumed locally, never reconstructed from
            // a PID or serialized into browser/provider input.
            drop(proof);
        }
    }
}
