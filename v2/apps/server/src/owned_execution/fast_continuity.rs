//! Keep original terminal custody until replacement dispatch or proved abort.
use super::*;
use orkestr_runtime::containment::{
    metadata::{ReapedMetadata, RetiringMetadata},
    ReapedBroker,
};
use orkestr_v2_contracts::RunId;
use std::{sync::Arc, time::Instant};

pub(super) struct PendingFastRetirement {
    companion: Option<Arc<window_roles::Companion>>,
    prior: Option<(RunId, ReapedBroker)>,
}
impl PendingFastRetirement {
    pub(super) fn new(companion: Option<Arc<window_roles::Companion>>) -> Self {
        Self {
            companion,
            prior: None,
        }
    }
    pub(super) fn keep(&mut self, run: RunId, proof: ReapedBroker) {
        self.prior = Some((run, proof));
    }
    pub(super) fn take(&mut self) -> Option<(RunId, ReapedBroker)> {
        self.prior.take()
    }
    pub(super) fn dispatched(&mut self) {
        self.prior = None;
    }
}
impl Drop for PendingFastRetirement {
    fn drop(&mut self) {
        // Error paths keep the original proof on the surviving companion. A
        // protocol/setup failure remains failed; this does not prove cleanup of
        // the new child, which retains its own original quarantine/reaper path.
        if let (Some(companion), Some((_, proof))) = (&self.companion, self.prior.take()) {
            companion.retire();
            if companion.retain(proof).is_err() {
                companion.fail();
            }
        }
    }
}

impl ConfiguredExecution {
    pub(super) async fn reap_fast_setup(
        &self,
        mut retiring: RetiringMetadata,
        heartbeat: &mut Instant,
    ) -> Result<(), &'static str> {
        let deadline = Instant::now() + Duration::from_secs(3);
        let proof: ReapedMetadata = loop {
            self.maintain(heartbeat).await?;
            if let Some(proof) = retiring
                .poll_reaped()
                .map_err(|_| "Fast setup native cleanup remains uncertain")?
            {
                break proof;
            }
            if Instant::now() >= deadline {
                return Err("Fast setup native cleanup timed out");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        if proof.binding().owner_id != self.owner
            || proof.binding().conversation_id != self.config.conversation_id
            || proof.binding().role != orkestr_v2_application::runtime::Role::Fast
            || proof.namespace() != self.config.namespace
            || Some(proof.incarnation_id()) != self.store.supervisor_incarnation()
        {
            return Err("Fast setup retirement scope mismatch");
        }
        let binding = proof.binding().clone();
        if let Some(companion) = &self.companion {
            companion.retain_setup(proof)?;
        }
        if self.window.is_some() {
            self.store
                .retire_bounded_fast_setup(&self.token, &binding)
                .await
                .map_err(|_| "Fast unused setup retirement refused")?;
        }
        Ok(())
    }
}
