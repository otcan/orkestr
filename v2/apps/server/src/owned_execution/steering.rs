//! Only Runtime's consuming same-child transition may refresh the retained issuer.
//! Unsupported periods retain ordinary queued input; no authority is inferred.
use super::liveness::RunningLease;
use crate::{control_registry::RunControl, steering_registry::RunSteering};
use orkestr_runtime::{
    containment::Authority,
    execution::{CodexPump, SteeringProgress},
};
use orkestr_v2_store_sqlite::{CodexSteeringAuthority, Store};
use std::time::{Duration, Instant};

pub(super) struct RunningSteering {
    handle: RunSteering,
    bound: bool,
    disabled: bool,
    pending_until: Option<Instant>,
}
impl RunningSteering {
    pub(super) fn register(
        control: &RunControl,
        authority: CodexSteeringAuthority,
    ) -> Result<Self, &'static str> {
        Ok(Self {
            handle: control.register_steering(authority)?,
            bound: false,
            disabled: false,
            pending_until: None,
        })
    }
    pub(super) fn retire(&mut self) {
        self.disabled = true;
        self.handle.retire();
    }
    /// Caller holds the run scheduling lock. Taking the issuer does not clone
    /// authority or require queued HTTP selections to relinquish their handles.
    pub(super) async fn renew(
        &mut self,
        store: Store,
        pump: CodexPump,
        liveness: &mut RunningLease,
    ) -> Result<(Authority, CodexPump), &'static str> {
        if self.disabled || !self.bound || self.pending_until.is_some() {
            return Err("steering renewal unavailable");
        }
        self.handle.ready(false);
        let previous = self
            .handle
            .authority()
            .await
            .take()
            .ok_or("steering issuer unavailable")?;
        let (authority, pump, issuer) = liveness.refresh(store, pump, previous).await?;
        let mut slot = self.handle.authority().await;
        if slot.is_some() {
            return Err("steering issuer transfer conflicted");
        }
        *slot = Some(issuer);
        self.handle.ready(pump.steering_readiness().ready);
        Ok((authority, pump))
    }
    pub(super) async fn tick(
        &mut self,
        store: &Store,
        pump: &mut CodexPump,
        running: bool,
    ) -> Result<(), &'static str> {
        if self.disabled {
            return Ok(());
        }
        if !running {
            self.handle.ready(false);
            return Ok(());
        }
        if pump.pending().is_some() {
            self.handle.ready(false);
            return Ok(());
        }
        if !self.bound {
            let issuer = self.handle.authority().await;
            pump.bind_steering_turn(store, issuer.as_ref().ok_or("steering issuer unavailable")?)
                .await
                .map_err(|_| "native steering turn binding refused")?;
            self.bound = true;
        }
        if let Some(delivery) = self.handle.take()? {
            pump.begin_steering(delivery)
                .map_err(|_| "native steering handoff uncertain")?;
            self.pending_until = Some(Instant::now() + Duration::from_secs(2));
        }
        if let Some(deadline) = self.pending_until {
            if Instant::now() >= deadline {
                self.retire();
                return Err("native steering acknowledgement remains unknown");
            }
            if pump
                .poll_steering(store)
                .await
                .map_err(|_| "native steering delivery uncertain")?
                == SteeringProgress::Acknowledged
            {
                self.pending_until = None;
            }
        }
        self.handle
            .ready(self.pending_until.is_none() && pump.steering_readiness().ready);
        Ok(())
    }
}
