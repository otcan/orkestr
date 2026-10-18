//! Authenticated, cached host health. Sampling never waits for a CPU interval.
mod linux;
#[cfg(test)]
mod tests;

use super::{owner, AppState, Error};
use axum::{extract::State, http::HeaderMap, Json};
use linux::{CpuCounters, Reading};
use orkestr_v2_application::StoreError;
use orkestr_v2_contracts::{HostCpuUsage, HostResourceHealth, ResourceAvailability, ResourceScope};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const MIN_INTERVAL: Duration = Duration::from_secs(1);
const MAX_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub(crate) struct ResourceSampler(Arc<Mutex<SamplerState>>);

struct SamplerState {
    last_attempt: Option<Instant>,
    previous: Option<(Instant, CpuCounters)>,
    snapshot: HostResourceHealth,
}

impl ResourceSampler {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(SamplerState {
            last_attempt: None,
            previous: None,
            snapshot: HostResourceHealth {
                schema_version: 1,
                scope: ResourceScope::Host,
                instance_id: Uuid::new_v4(),
                sample_sequence: 0,
                observed_at_ms: None,
                availability: ResourceAvailability::Unavailable,
                cpu: None,
                memory: None,
            },
        })))
    }

    async fn snapshot(&self) -> Result<HostResourceHealth, Error> {
        let shared = self.0.clone();
        // Kernel reads and the short cache lock stay off asynchronous workers.
        tokio::task::spawn_blocking(move || -> Result<HostResourceHealth, StoreError> {
            let mut state = shared.lock().map_err(|_| StoreError::Unavailable)?;
            let now = Instant::now();
            if let Some(snapshot) = state.cached(now) {
                return Ok(snapshot);
            }
            let reading = linux::read();
            let observed_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()
                .and_then(|time| i64::try_from(time.as_millis()).ok())
                .filter(|time| *time > 0);
            state.update(now, observed_at, reading)?;
            Ok(state.snapshot.clone())
        })
        .await
        .map_err(|_| Error::from(StoreError::Unavailable))?
        .map_err(Error::from)
    }
}

impl SamplerState {
    fn cached(&self, now: Instant) -> Option<HostResourceHealth> {
        self.last_attempt
            .filter(|last| now.duration_since(*last) < MIN_INTERVAL)
            .map(|_| self.snapshot.clone())
    }

    fn update(
        &mut self,
        now: Instant,
        observed_at: Option<i64>,
        reading: Option<Reading>,
    ) -> Result<(), StoreError> {
        self.snapshot.sample_sequence = self
            .snapshot
            .sample_sequence
            .checked_add(1)
            .ok_or(StoreError::Unavailable)?;
        self.last_attempt = Some(now);
        self.snapshot.observed_at_ms = observed_at;
        self.snapshot.cpu = None;
        self.snapshot.memory = None;
        self.snapshot.availability = ResourceAvailability::Unavailable;
        let Some(reading) = reading.filter(|_| observed_at.is_some()) else {
            self.previous = None;
            return Ok(());
        };
        if let Some((at, counters)) = self.previous {
            let interval = now.duration_since(at);
            if (MIN_INTERVAL..=MAX_INTERVAL).contains(&interval) {
                self.snapshot.cpu =
                    reading
                        .cpu
                        .busy_since(counters)
                        .map(|busy_permille| HostCpuUsage {
                            busy_permille,
                            interval_ms: interval.as_millis() as u64,
                        });
            }
        }
        self.previous = Some((now, reading.cpu));
        self.snapshot.memory = Some(reading.memory);
        self.snapshot.availability = if self.snapshot.cpu.is_some() {
            ResourceAvailability::Ready
        } else {
            ResourceAvailability::WarmingUp
        };
        Ok(())
    }
}

pub(crate) async fn resources(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HostResourceHealth>, Error> {
    // Current setup creates one administrator. Any future multi-tenant server
    // must retain an operator-only capability for this host-wide aggregate.
    owner(&state, &headers).await?;
    Ok(Json(state.resources.snapshot().await?))
}
