//! Durable FIFO intake. A browser message never supplies provider authority.
use super::*;
use orkestr_v2_application::runtime::{
    AdmissionDisposition, DispatchClaimResult, RuntimeStore, SessionState,
};
use orkestr_v2_store_sqlite::{ConsumedProviderDispatch, ExecutionConsumption};
use std::time::Instant;

impl ConfiguredExecution {
    /// Read-only wakeup after native retirement. A held pre-Stop input must not
    /// spend a one-use setup grant or start an idle replacement process.
    pub(super) async fn wait_eligible(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<bool, &'static str> {
        loop {
            // An execution window accepts follow-up turns until its work
            // deadline; afterwards its owner retires it and a successor resumes.
            if *shutdown.borrow() || self.window.as_ref().is_some_and(|window| window.work_due()) {
                return Ok(false);
            }
            self.maintain(heartbeat).await?;
            let page = self
                .store
                .held_owner_inputs_authenticated(&self.token, &self.config.conversation_id, 0, 1)
                .await
                .map_err(|_| "execution input eligibility unavailable")?;
            if !page.is_valid() || page.conversation_id != self.config.conversation_id {
                return Err("execution input eligibility invalid");
            }
            if page.eligible_input_available {
                return Ok(true);
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                _ = shutdown.changed() => return Ok(false),
            }
        }
    }

    pub(super) async fn maintain(&self, heartbeat: &mut Instant) -> Result<(), &'static str> {
        self.current().await?;
        if heartbeat_due(*heartbeat, Instant::now()) {
            self.store.heartbeat_supervisor().await.map_err(|error| {
                eprintln!("owned execution heartbeat refused: {error:?}");
                "execution supervisor heartbeat refused"
            })?;
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
        self.next_with_liveness(shutdown, heartbeat, || Ok(()))
            .await
    }

    /// A retained child must remain live before claiming the next input. This
    /// callback can only refuse admission; it supplies no provider authority.
    pub(super) async fn next_with_liveness(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
        mut live: impl FnMut() -> Result<(), &'static str>,
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
            if *shutdown.borrow() || self.window.as_ref().is_some_and(|window| window.work_due()) {
                return Ok(None);
            }
            self.maintain(heartbeat).await?;
            live()?;
            if let Some(claim) = self
                .store
                .claim_next(
                    &self.owner,
                    conversation,
                    &binding.session_id,
                    Duration::from_secs(60),
                )
                .await
                .map_err(|error| {
                    eprintln!("owned execution inbox claim refused: {error:?}");
                    "execution inbox claim refused"
                })?
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

fn heartbeat_due(previous: Instant, now: Instant) -> bool {
    now.saturating_duration_since(previous) >= Duration::from_secs(10)
}

#[cfg(test)]
mod metadata_heartbeat_tests {
    use super::*;

    #[test]
    fn metadata_heartbeat_keeps_original_cadence_past_work_and_cleanup_deadlines() {
        let start = Instant::now();
        let mut heartbeat = start + Duration::from_secs(870);
        // No work/cleanup deadline resets or disables the metadata lease cadence.
        for seconds in 871..=1000 {
            let now = start + Duration::from_secs(seconds);
            let due = heartbeat_due(heartbeat, now);
            assert_eq!(due, seconds % 10 == 0);
            if due {
                heartbeat = now;
            }
        }
    }
}
