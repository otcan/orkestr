//! One bounded handoff to an already owned native turn. Core alone issues the
//! consumed capability; neither a browser locator nor this mailbox authorizes I/O.
use orkestr_v2_store_sqlite::{CodexSteeringAuthority, ConsumedSteering};
use std::sync::{Arc, Mutex};

pub(crate) struct Slot {
    authority: tokio::sync::Mutex<Option<CodexSteeringAuthority>>,
    state: Mutex<SlotState>,
}
struct SlotState {
    active: bool,
    ready: bool,
    submitted: u16,
    pending: Option<Box<ConsumedSteering>>,
}
pub(crate) struct RunSteering(pub(crate) Arc<Slot>);
pub(crate) struct SelectedSteering {
    pub(crate) slot: Arc<Slot>,
    pub(crate) scheduling: Arc<tokio::sync::Mutex<()>>,
}

impl Slot {
    pub(crate) fn new(authority: CodexSteeringAuthority) -> Arc<Self> {
        Arc::new(Self {
            authority: tokio::sync::Mutex::new(Some(authority)),
            state: Mutex::new(SlotState {
                active: true,
                ready: false,
                submitted: 0,
                pending: None,
            }),
        })
    }
    pub(crate) fn available(&self) -> bool {
        self.state
            .lock()
            .is_ok_and(|s| s.active && s.ready && s.pending.is_none() && s.submitted < 128)
    }
    pub(crate) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.active = false;
            state.ready = false;
            // Consumption is already durable. Dropping this exact one-use
            // value preserves DeliveryUnknown; it cannot restore queued input.
            state.pending = None;
        }
    }
}
impl RunSteering {
    pub(crate) async fn authority(
        &self,
    ) -> tokio::sync::MutexGuard<'_, Option<CodexSteeringAuthority>> {
        self.0.authority.lock().await
    }
    pub(crate) fn ready(&self, ready: bool) {
        if let Ok(mut state) = self.0.state.lock() {
            state.ready = state.active && ready;
        }
    }
    pub(crate) fn take(&self) -> Result<Option<Box<ConsumedSteering>>, &'static str> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| "steering handoff unavailable")?;
        Ok(state.pending.take())
    }
    pub(crate) fn retire(&self) {
        self.0.close();
    }
}
impl Drop for RunSteering {
    fn drop(&mut self) {
        self.retire();
    }
}
impl SelectedSteering {
    pub(crate) async fn serialize(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.scheduling.clone().lock_owned().await
    }
    /// Recheck after acquiring the same lock used by Stop and native polling.
    pub(crate) async fn authority(
        &self,
    ) -> Option<tokio::sync::MutexGuard<'_, Option<CodexSteeringAuthority>>> {
        if !self.slot.available() {
            return None;
        }
        Some(self.slot.authority.lock().await)
    }
    pub(crate) fn publish(
        &self,
        delivery: Box<ConsumedSteering>,
        authority: &CodexSteeringAuthority,
    ) -> Result<(), &'static str> {
        let mut state = self
            .slot
            .state
            .lock()
            .map_err(|_| "steering handoff unavailable")?;
        if !state.active
            || !state.ready
            || state.pending.is_some()
            || state.submitted >= 128
            || delivery.provider() != authority.provider()
        {
            return Err("steering handoff closed");
        }
        state.pending = Some(delivery);
        state.submitted += 1;
        state.ready = false;
        Ok(())
    }
}
