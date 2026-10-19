//! Native-tree cleanup is separate from durable terminal truth and setup authority.
use super::*;
use orkestr_runtime::containment::{ReapedBroker, RetiringBroker};
use orkestr_v2_contracts::RunId;
use std::time::Instant;

impl ConfiguredExecution {
    pub(super) async fn reaped(
        &self,
        mut retiring: RetiringBroker,
        run: &RunId,
        heartbeat: &mut Instant,
    ) -> Result<ReapedBroker, &'static str> {
        let deadline = Instant::now() + Duration::from_secs(3);
        let proof = loop {
            self.maintain(heartbeat).await?;
            if let Some(proof) = retiring
                .poll_reaped()
                .map_err(|_| "execution native-tree retirement is unconfirmed")?
            {
                break proof;
            }
            if Instant::now() >= deadline {
                return Err("execution native-tree retirement timed out");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        if proof.scope().owner() != self.owner.to_string()
            || proof.scope().run() != run.to_string()
            || proof.scope().namespace() != self.config.namespace
        {
            return Err("execution retirement scope mismatch");
        }
        drop(retiring);
        // ChildSet retains scratch/capacity through actual broker wait. It is a
        // resource barrier, never a substitute for the native-tree witness above.
        if !self.children.wait_empty(Duration::from_secs(2)).await {
            return Err("execution retained child resources remain active");
        }
        Ok(proof)
    }

    pub(super) async fn retire_terminal(
        &self,
        run: &RunId,
        proof: ReapedBroker,
    ) -> Result<(), &'static str> {
        if proof.scope().owner() != self.owner.to_string()
            || proof.scope().run() != run.to_string()
            || proof.scope().namespace() != self.config.namespace
        {
            return Err("execution retirement scope mismatch");
        }
        // Freezing consumes the original parent witness and every retained
        // Worker witness. A missing or poisoned launch refuses replacement.
        let proofs = self.finish_worker_reaps(proof)?;
        self.current().await?;
        self.store
            .retire_terminal_supervisor(&self.token, run)
            .await
            .map_err(|_| "execution graceful supervisor retirement refused")?;
        // Retain the original native-tree witness through the durable decision.
        drop(proofs);
        Ok(())
    }
}
