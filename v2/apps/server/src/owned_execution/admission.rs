//! Durable FIFO intake. A browser message never supplies provider authority.
use super::*;
use orkestr_v2_application::runtime::{
    AdmissionDisposition, DispatchClaimResult, RuntimeStore, SessionState,
};
use orkestr_v2_store_sqlite::{ConsumedProviderDispatch, ExecutionConsumption};
use std::time::Instant;

impl ConfiguredExecution {
    pub(super) async fn maintain(&self, heartbeat: &mut Instant) -> Result<(), &'static str> {
        self.current().await?;
        if heartbeat.elapsed() >= Duration::from_secs(10) {
            self.store
                .heartbeat_supervisor()
                .await
                .map_err(|_| "execution supervisor heartbeat refused")?;
            *heartbeat = Instant::now();
        }
        Ok(())
    }

    /// Called only after setup or committed owner acceptance. Core owns the
    /// earliest unconsumed scope sequence; active input is never claimed early.
    pub(super) async fn next(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<Box<ConsumedProviderDispatch>>, &'static str> {
        let conversation = &self.config.conversation_id;
        let binding = self
            .store
            .ensure_role_bindings(&self.owner, conversation)
            .await
            .map_err(|_| "execution ready binding unavailable")?
            .deep;
        if binding.state != SessionState::Ready {
            return Err("execution binding is not ready for another run");
        }
        let claim = loop {
            if *shutdown.borrow() {
                return Ok(None);
            }
            self.maintain(heartbeat).await?;
            if let Some(claim) = self
                .store
                .claim_next(
                    &self.owner,
                    conversation,
                    &binding.session_id,
                    Duration::from_secs(60),
                )
                .await
                .map_err(|_| "execution inbox claim refused")?
            {
                break claim;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                _ = shutdown.changed() => return Ok(None),
            }
        };
        self.current().await?;
        self.store
            .heartbeat_supervisor()
            .await
            .map_err(|_| "execution supervisor heartbeat refused")?;
        *heartbeat = Instant::now();
        let key = format!("http:{}", claim.message_id);
        let admitted = self
            .store
            .admit_run(&claim, &binding.session_id, binding.generation, &key)
            .await
            .map_err(|_| "execution admission refused")?;
        if admitted.disposition != AdmissionDisposition::FreshCandidate {
            return Err("execution admission requires reconciliation");
        }
        let DispatchClaimResult::Reserved(reservation) = self
            .store
            .claim_provider_dispatch(&admitted, &key)
            .await
            .map_err(|_| "execution reservation refused")?
        else {
            return Err("execution reservation requires reconciliation");
        };
        self.current().await?;
        // Core authenticates inside consumption and every transport fence. This
        // preliminary current-session check is never the authority for a write.
        let ExecutionConsumption::Dispatch(capability) = self
            .store
            .consume_execution(&reservation)
            .await
            .map_err(|_| "execution consumption refused")?
        else {
            return Err("execution delivery is uncertain; automatic replay refused");
        };
        Ok(Some(capability))
    }
}
