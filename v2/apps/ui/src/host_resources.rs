//! Owner-scoped host aggregate sample cache, independent of component lifetime.
use orkestr_v2_contracts::{HostResourceHealth, ResourceAvailability};
use std::collections::BTreeSet;

#[derive(Clone, Default)]
pub struct HostResources {
    sample: Option<HostResourceHealth>,
    received_ms: Option<u64>,
    connected: bool,
    failed: bool,
    generation: u64,
    retired_instances: BTreeSet<String>,
}
impl HostResources {
    pub const STALE_MS: u64 = 15_000;
    pub fn begin_view(&mut self) -> u64 {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("view generation exhausted");
        self.connected = false;
        self.generation
    }
    pub fn is_current(&self, generation: u64) -> bool {
        self.generation == generation
    }
    pub fn clear_owner(&mut self) {
        let generation = self
            .generation
            .checked_add(1)
            .expect("owner generation exhausted");
        *self = Self {
            generation,
            ..Self::default()
        };
    }
    pub fn disconnected(&mut self, generation: u64) {
        if self.is_current(generation) {
            self.connected = false;
            self.failed = true;
        }
    }
    pub fn apply(
        &mut self,
        generation: u64,
        now_ms: u64,
        sample: HostResourceHealth,
    ) -> Result<(), &'static str> {
        if !self.is_current(generation)
            || !sample.is_valid()
            || self.received_ms.is_some_and(|received| now_ms < received)
            || self
                .retired_instances
                .contains(&sample.instance_id.to_string())
        {
            return Err("Invalid or obsolete host observation");
        }
        if let Some(old) = &self.sample {
            if old.instance_id == sample.instance_id {
                if sample.sample_sequence < old.sample_sequence
                    || (sample.sample_sequence == old.sample_sequence && sample != *old)
                {
                    return Err("Regressing or conflicting host observation");
                }
                if sample.sample_sequence == old.sample_sequence {
                    // A successful read restores connectivity, never the sampling clock.
                    self.connected = true;
                    self.failed = false;
                    return Ok(());
                }
            } else {
                if self.retired_instances.len() >= 64 {
                    return Err("Host restart history limit");
                }
                self.retired_instances.insert(old.instance_id.to_string());
            }
        }
        self.sample = Some(sample);
        self.received_ms = Some(now_ms);
        self.connected = true;
        self.failed = false;
        Ok(())
    }
    pub fn fresh(&self, now_ms: u64) -> bool {
        self.connected
            && self
                .received_ms
                .is_some_and(|received| now_ms >= received && now_ms - received <= Self::STALE_MS)
    }
    pub fn status(&self, now_ms: u64) -> &'static str {
        let Some(sample) = &self.sample else {
            return if self.failed {
                "Host resources unavailable. Retrying…"
            } else {
                "Loading host resources…"
            };
        };
        if !self.fresh(now_ms) {
            return "Host resources stale. Reconnecting…";
        }
        match sample.availability {
            ResourceAvailability::Ready => "Host resources current",
            ResourceAvailability::WarmingUp => "CPU sampling is warming up…",
            ResourceAvailability::Unavailable => "Host resources unavailable. Retrying…",
        }
    }
    pub fn cpu(&self, now_ms: u64) -> String {
        if !self.fresh(now_ms) {
            return "Unavailable".into();
        }
        self.sample
            .as_ref()
            .and_then(|sample| sample.cpu.as_ref())
            .map(|cpu| {
                format!(
                    "{}.{:01}% busy",
                    cpu.busy_permille / 10,
                    cpu.busy_permille % 10
                )
            })
            .unwrap_or_else(|| "Unavailable".into())
    }
    pub fn memory(&self, now_ms: u64) -> String {
        if !self.fresh(now_ms) {
            return "Unavailable".into();
        }
        self.sample
            .as_ref()
            .and_then(|sample| sample.memory.as_ref())
            .map(|memory| {
                format!(
                    "{} MiB used / {} MiB total · {} MiB available",
                    memory.used_bytes / 1_048_576,
                    memory.total_bytes / 1_048_576,
                    memory.available_bytes / 1_048_576
                )
            })
            .unwrap_or_else(|| "Unavailable".into())
    }
}
