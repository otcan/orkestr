//! Presentation state, not a wire DTO. Only a reviewed API adapter may supply samples.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Queued,
    Running,
    CancellationRequested,
    Cancelled,
    Completed,
    Failed,
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
    pub cpu_percent: Option<u8>,
    pub ram_bytes: Option<u64>,
    pub stop_supported: bool,
    pub steering_supported: bool,
}
#[derive(Clone, Default)]
pub struct Execution {
    sample: Option<Sample>,
    connected: bool,
    generation: u64,
    scope: Option<(String, String)>,
    received_ms: Option<u64>,
    authorized: bool,
    control_error: Option<String>,
}
impl Execution {
    pub const STALE_MS: u64 = 15_000;
    /// Select explicitly, even when returning to the same run. Late responses retain old generation.
    pub fn select(&mut self, conversation: &str, run: &str) -> u64 {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("selection generation exhausted");
        self.scope = Some((conversation.into(), run.into()));
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
            || sample.run.is_empty()
            || self.received_ms.is_some_and(|last| now_ms < last)
            || sample
                .progress
                .is_some_and(|(done, total)| total == 0 || done > total)
            || sample.cpu_percent.is_some_and(|cpu| cpu > 100)
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
    pub fn disconnected(&mut self) {
        self.connected = false;
    }
    pub fn authorization_lost(&mut self) {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("selection generation exhausted");
        self.authorized = false;
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
                s.stop_supported && matches!(s.phase, Phase::Queued | Phase::Running)
            })
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
                "Status stale; last confirmed {:?}. Reconnecting does not confirm completion.",
                s.phase
            ),
            Some(s) => format!(
                "{:?} · queue age {} · progress {}",
                s.phase,
                s.queue_age_ms
                    .map(|v| format!("{}s", v / 1000))
                    .unwrap_or_else(|| "unavailable".into()),
                s.progress
                    .map(|(done, total)| format!("{done}/{total}"))
                    .unwrap_or_else(|| "unavailable".into())
            ),
        }
    }
    pub fn resources(&self, now_ms: u64) -> String {
        match self.sample.as_ref().filter(|_| self.fresh(now_ms)) {
            Some(s) => format!(
                "CPU {} · RAM {}",
                s.cpu_percent
                    .map(|v| format!("{v}%"))
                    .unwrap_or_else(|| "unavailable".into()),
                s.ram_bytes
                    .map(|v| format!("{} MiB", v / 1_048_576))
                    .unwrap_or_else(|| "unavailable".into())
            ),
            None => "CPU unavailable · RAM unavailable".into(),
        }
    }
}
