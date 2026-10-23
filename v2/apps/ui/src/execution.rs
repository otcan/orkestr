//! Presentation state, not a wire DTO. Only a reviewed API adapter may supply samples.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Queued,
    Starting,
    AwaitingAcceptance,
    Blocked,
    Running,
    CancellationRequested,
    Cancelled,
    Completed,
    Failed,
}
impl Phase {
    pub fn label(self) -> &'static str {
        match self {
            Self::Queued => "Queued",
            Self::Starting => "Starting",
            Self::Running => "Running",
            Self::CancellationRequested => "Stop requested",
            Self::Cancelled => "Cancelled",
            Self::AwaitingAcceptance => "Awaiting review",
            Self::Completed => "Completed",
            Self::Failed => "Failed",
            Self::Blocked => "Blocked",
        }
    }
}
#[derive(Clone, Debug)]
pub struct Sample {
    pub conversation: String,
    pub run: String,
    pub revision: u64,
    pub observed_ms: u64,
    pub phase: Phase,
    pub queue_age_ms: Option<u64>,
    pub progress: Option<(u64, u64)>,
    pub cpu_capacity_permille: Option<u16>,
    pub progress_reference: Option<String>,
    pub resource_age_ms: Option<u64>,
    pub ram_bytes: Option<u64>,
    pub stop_supported: bool,
    pub steering_supported: bool,
}
#[derive(Clone, Default)]
pub struct Execution {
    pub stops: crate::stop::Stops,
    pub acceptances: crate::acceptance::Acceptances,
    sample: Option<Sample>,
    connected: bool,
    generation: u64,
    scope: Option<(String, String)>,
    exact_run: Option<String>,
    received_ms: Option<u64>,
    authorized: bool,
    control_error: Option<String>,
    canonical_received: std::collections::BTreeMap<String, u64>,
    canonical: std::collections::BTreeMap<String, orkestr_v2_contracts::ExecutionStatus>,
    failure: Option<&'static str>,
}

mod presentation;
pub use presentation::{failure_label, failure_notice, model_label};

impl Execution {
    pub const STALE_MS: u64 = 15_000;
    pub fn selection_generation(&self) -> u64 {
        self.generation
    }
    /// Select explicitly, even when returning to the same run. Late responses retain old generation.
    pub fn select(&mut self, conversation: &str, run: &str) -> u64 {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("selection generation exhausted");
        self.scope = Some((conversation.into(), run.into()));
        self.exact_run = (!run.is_empty()).then(|| run.to_string());
        self.sample = None;
        self.received_ms = None;
        self.connected = false;
        self.authorized = false;
        self.control_error = None;
        self.generation
    }
    /// now_ms is client-monotonic elapsed time, never a wall-clock/server timestamp.
    pub fn apply(
        &mut self,
        generation: u64,
        now_ms: u64,
        sample: Sample,
    ) -> Result<(), &'static str> {
        if generation != self.generation
            || self.scope.as_ref() != Some(&(sample.conversation.clone(), sample.run.clone()))
            || (sample.run.is_empty() && sample.phase != Phase::Queued)
            || self.received_ms.is_some_and(|last| now_ms < last)
            || sample
                .progress
                .is_some_and(|(done, total)| total == 0 || done > total)
            || sample.cpu_capacity_permille.is_some_and(|cpu| cpu > 1000)
            || self
                .sample
                .as_ref()
                .is_some_and(|old| sample.revision <= old.revision)
        {
            return Err("Invalid or regressing execution observation");
        }
        self.sample = Some(sample);
        self.connected = true;
        self.received_ms = Some(now_ms);
        self.authorized = true;
        Ok(())
    }
    /// Authenticated read adapter. Canonical revisions are per conversation, including run changes.
    /// Server timestamps are used only for relative sample age, never browser-clock comparisons.
    pub fn apply_status(
        &mut self,
        generation: u64,
        mut received_ms: u64,
        mut status: orkestr_v2_contracts::ExecutionStatus,
    ) -> Result<(), &'static str> {
        use orkestr_v2_contracts::ExecutionPhase as Wire;
        let conversation = status.conversation_id.to_string();
        let cache_key = self.cache_key(&conversation);
        if self.exact_run.as_ref().is_some_and(|run| {
            status
                .run_id
                .as_ref()
                .is_none_or(|id| id.to_string() != *run)
        }) || !status.is_valid()
            || generation != self.generation
            || self
                .scope
                .as_ref()
                .is_none_or(|(id, _)| id != &conversation)
            || self.received_ms.is_some_and(|last| received_ms < last)
            || self.canonical.get(&cache_key).is_some_and(|old| {
                status.revision < old.revision
                    || (status.revision == old.revision
                        && status.observed_at_ms >= old.observed_at_ms
                        && {
                            // Registry availability is sampled after the durable read.
                            // Normalize only that overlay; every durable field still matches.
                            let mut durable = old.clone();
                            durable.capabilities.stop = status.capabilities.stop;
                            !status.same_revision_state(&durable)
                        })
            })
        {
            return Err("Invalid or regressing execution status");
        }
        // Rehydrating a remounted selection must retain the original observation anchor.
        if let Some(old) = self.canonical.get(&cache_key) {
            if status.revision == old.revision && status.observed_at_ms <= old.observed_at_ms {
                if status.observed_at_ms < old.observed_at_ms && self.sample.is_some() {
                    return Ok(());
                }
                let capabilities = if status.observed_at_ms == old.observed_at_ms {
                    status.capabilities.clone()
                } else {
                    old.capabilities.clone()
                };
                status = old.clone();
                status.capabilities = capabilities;
                received_ms = *self
                    .canonical_received
                    .get(&cache_key)
                    .expect("canonical receipt");
            }
        }
        let run = status
            .run_id
            .as_ref()
            .map(|id| id.to_string())
            .unwrap_or_default();
        let phase = match status.phase {
            Wire::Queued => Phase::Queued,
            Wire::Starting => Phase::Starting,
            Wire::Running => Phase::Running,
            Wire::CancelRequested => Phase::CancellationRequested,
            Wire::Cancelled => Phase::Cancelled,
            Wire::AwaitingAcceptance => Phase::AwaitingAcceptance,
            Wire::Completed => Phase::Completed,
            Wire::Failed => Phase::Failed,
            Wire::Blocked => Phase::Blocked,
        };
        let sample = Sample {
            conversation: conversation.clone(),
            run: run.clone(),
            revision: status.revision as u64,
            observed_ms: status.observed_at_ms as u64,
            phase,
            queue_age_ms: status.queue_age_ms,
            progress: None,
            progress_reference: status.progress.as_ref().map(|p| p.payload_id.to_string()),
            cpu_capacity_permille: status.resources.as_ref().map(|s| s.cpu_capacity_permille),
            resource_age_ms: status
                .resources
                .as_ref()
                .map(|s| (status.observed_at_ms - s.observed_at_ms) as u64),
            ram_bytes: status.resources.as_ref().map(|s| s.resident_bytes),
            stop_supported: status.capabilities.stop && !run.is_empty(),
            steering_supported: status.capabilities.steer && !run.is_empty(),
        };
        // All checks precede this atomic replacement. A new canonical run resets local sample revision.
        self.scope = Some((conversation.clone(), run));
        self.failure = status.failure.as_ref().map(|f| failure_label(f.class));
        self.sample = Some(sample);
        self.received_ms = Some(received_ms);
        self.connected = true;
        self.authorized = true;
        self.canonical_received
            .insert(cache_key.clone(), received_ms);
        self.acceptances.observe_status(&status);
        self.canonical.insert(cache_key, status);
        Ok(())
    }
    /// An authenticated 204 removes displayed authority without erasing revision history.
    pub fn absent(&mut self, generation: u64) -> bool {
        if generation != self.generation {
            return false;
        }
        self.sample = None;
        self.authorized = false;
        self.connected = true;
        self.received_ms = None;
        self.control_error = None;
        true
    }
    pub fn disconnected(&mut self) {
        self.connected = false;
    }
    pub fn authorization_lost(&mut self) {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("selection generation exhausted");
        self.authorized = false;
        self.sample = None;
        self.stops.clear_owner();
        self.acceptances.clear_owner();
        self.canonical.clear();
        self.canonical_received.clear();
        self.scope = None;
        self.exact_run = None;
        self.received_ms = None;
        self.connected = false;
        self.control_error = None;
    }
    /// A failed request is visible and retryable, never a successful stop.
    pub fn control_failed(&mut self) {
        self.control_error = Some("Stop not confirmed. Check connection and retry.".into());
    }
    pub fn control_error(&self) -> Option<&str> {
        self.control_error.as_deref()
    }
    pub fn fresh(&self, now_ms: u64) -> bool {
        self.connected
            && self
                .received_ms
                .is_some_and(|received| now_ms >= received && now_ms - received <= Self::STALE_MS)
    }
    pub fn can_stop(&self, _now_ms: u64) -> bool {
        self.authorized
            && self.sample.as_ref().is_some_and(|s| {
                !s.run.is_empty()
                    && s.stop_supported
                    && matches!(s.phase, Phase::Queued | Phase::Starting | Phase::Running)
            })
    }
    fn cache_key(&self, conversation: &str) -> String {
        match &self.exact_run {
            Some(run) => format!("{conversation}/{run}"),
            None => conversation.to_string(),
        }
    }
    /// Selection/authentication-bound canonical identity, independent of telemetry age.
    pub fn control_status(&self) -> Option<orkestr_v2_contracts::ExecutionStatus> {
        if !self.authorized {
            return None;
        }
        let sample = self.sample.as_ref()?;
        self.canonical
            .get(&self.cache_key(&sample.conversation))
            .filter(|status| {
                status
                    .run_id
                    .as_ref()
                    .is_some_and(|run| run.to_string() == sample.run)
                    && status.revision as u64 == sample.revision
            })
            .cloned()
    }
    pub fn can_steer(&self, now_ms: u64) -> bool {
        self.authorized
            && self.fresh(now_ms)
            && self
                .sample
                .as_ref()
                .is_some_and(|s| s.steering_supported && s.phase == Phase::Running)
    }
    pub fn summary(&self, now_ms: u64) -> String {
        match &self.sample {
            None => "Execution unavailable. Connect a provider to get started.".into(),
            Some(s) if !self.fresh(now_ms) => format!(
                "Status stale; last confirmed {}. Reconnecting does not confirm completion.",
                s.phase.label()
            ),
            Some(s) => format!(
                "{} · queue age {} · progress {}",
                match (s.phase, self.failure) {
                    (Phase::Failed, Some(cause)) => format!("Failed: {cause}"),
                    _ => s.phase.label().to_string(),
                },
                s.queue_age_ms
                    .map(|v| format!("{}s", v / 1000))
                    .unwrap_or_else(|| "unavailable".into()),
                s.progress
                    .map(|(done, total)| format!("{done}/{total}"))
                    .unwrap_or_else(|| if s.progress_reference.is_some() {
                        "Update available".into()
                    } else {
                        "unavailable".into()
                    })
            ),
        }
    }
    pub fn resources(&self, now_ms: u64) -> String {
        match self.sample.as_ref().filter(|s| {
            self.fresh(now_ms)
                && s.resource_age_ms.is_some_and(|age| {
                    age.saturating_add(now_ms.saturating_sub(self.received_ms.unwrap_or(now_ms)))
                        <= Self::STALE_MS
                })
        }) {
            Some(s) => format!(
                "CPU {} · RAM {}",
                s.cpu_capacity_permille
                    .map(|v| format!("{}.{:01}%", v / 10, v % 10))
                    .unwrap_or_else(|| "unavailable".into()),
                s.ram_bytes
                    .map(|v| format!("{} MiB", v / 1_048_576))
                    .unwrap_or_else(|| "unavailable".into())
            ),
            None => "CPU unavailable · RAM unavailable".into(),
        }
    }
}
