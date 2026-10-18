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
}
impl Execution {
    pub const STALE_MS: u64 = 15_000;
    pub fn apply(
        &mut self,
        conversation: &str,
        now_ms: u64,
        sample: Sample,
    ) -> Result<(), &'static str> {
        if sample.conversation != conversation
            || sample.run.is_empty()
            || sample.observed_ms > now_ms
            || sample
                .progress
                .is_some_and(|(done, total)| total == 0 || done > total)
            || sample.cpu_percent.is_some_and(|cpu| cpu > 100)
            || self.sample.as_ref().is_some_and(|old| {
                sample.revision <= old.revision || sample.observed_ms < old.observed_ms
            })
        {
            return Err("Invalid or regressing execution observation");
        }
        self.sample = Some(sample);
        self.connected = true;
        Ok(())
    }
    pub fn disconnected(&mut self) {
        self.connected = false;
    }
    pub fn fresh(&self, now_ms: u64) -> bool {
        self.connected
            && self.sample.as_ref().is_some_and(|s| {
                now_ms >= s.observed_ms && now_ms - s.observed_ms <= Self::STALE_MS
            })
    }
    pub fn can_stop(&self, now_ms: u64) -> bool {
        self.fresh(now_ms)
            && self.sample.as_ref().is_some_and(|s| {
                s.stop_supported && matches!(s.phase, Phase::Queued | Phase::Running)
            })
    }
    pub fn can_steer(&self, now_ms: u64) -> bool {
        self.fresh(now_ms)
            && self
                .sample
                .as_ref()
                .is_some_and(|s| s.steering_supported && s.phase == Phase::Running)
    }
    pub fn summary(&self, now_ms: u64) -> String {
        match &self.sample {
            None => "Execution status unavailable: awaiting server contract.".into(),
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
            None => "CPU unavailable · RAM unavailable (no current server sample)".into(),
        }
    }
}
