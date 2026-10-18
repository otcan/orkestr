//! Drive only the exact authenticated handoff for this factory's owned child.
use super::*;
use crate::{control_dispatch::ControlReceiver, stop_execution::StopProgress};
use orkestr_runtime::{containment::Authority, execution::CodexPump};
use std::time::Instant;

impl ConfiguredExecution {
    pub(super) async fn stop_owned(
        &self,
        controls: &mut ControlReceiver,
        authority: Authority,
        pump: CodexPump,
        heartbeat: &mut Instant,
    ) -> Result<(), &'static str> {
        self.control.disable();
        // The durable cancellation may become visible immediately before the
        // HTTP caller publishes its exact receipt. Await that bounded handoff;
        // a lost caller/process never reconstructs authority from the status.
        let deadline = Instant::now() + Duration::from_secs(2);
        let pending = loop {
            self.maintain(heartbeat).await?;
            if let Some(pending) = controls
                .take()
                .map_err(|_| "execution control handoff refused")?
            {
                break pending;
            }
            if Instant::now() >= deadline {
                return Err("execution cancellation requires reconciliation");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        let mut active = pending
            .dispatch(authority, pump)
            .map_err(|_| "execution interruption requires reconciliation")?;
        loop {
            self.maintain(heartbeat).await?;
            match active.tick().await {
                StopProgress::Stopped => return Ok(()),
                StopProgress::ReconciliationRequired => {
                    return Err("execution Stop remains unconfirmed")
                }
                StopProgress::Pending | StopProgress::InterruptAcknowledged => {}
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
