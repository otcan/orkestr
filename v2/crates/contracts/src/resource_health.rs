//! Host aggregate observations, separate from per-execution resource usage.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceAvailability {
    Ready,
    WarmingUp,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceScope {
    Host,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostCpuUsage {
    /// Fraction of aggregate CPU time busy, 0..=1000. Not process CPU or quota.
    pub busy_permille: u16,
    pub interval_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostMemoryUsage {
    pub total_bytes: u64,
    /// Linux MemAvailable estimate; includes reclaimable memory.
    pub available_bytes: u64,
    /// Total minus available, not the sum of process resident sets.
    pub used_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostResourceHealth {
    pub schema_version: u32,
    pub scope: ResourceScope,
    /// Changes on server restart. Neither an owner ID nor an authority token.
    pub instance_id: uuid::Uuid,
    /// Increases on sampling attempts, never merely on HTTP reads.
    pub sample_sequence: u64,
    /// Actual sampling time; repeated cached responses retain this timestamp.
    pub observed_at_ms: Option<i64>,
    pub availability: ResourceAvailability,
    pub cpu: Option<HostCpuUsage>,
    pub memory: Option<HostMemoryUsage>,
}

impl HostResourceHealth {
    pub fn is_valid(&self) -> bool {
        self.schema_version == 1
            && !self.instance_id.is_nil()
            && self.sample_sequence > 0
            && self.observed_at_ms.is_none_or(|time| time > 0)
            && self.cpu.as_ref().is_none_or(|cpu| {
                cpu.busy_permille <= 1000 && (1000..=10_000).contains(&cpu.interval_ms)
            })
            && self.memory.as_ref().is_none_or(|memory| {
                memory.total_bytes > 0
                    && memory.available_bytes <= memory.total_bytes
                    && memory.used_bytes == memory.total_bytes - memory.available_bytes
            })
            && match self.availability {
                ResourceAvailability::Ready => {
                    self.observed_at_ms.is_some() && self.cpu.is_some() && self.memory.is_some()
                }
                ResourceAvailability::WarmingUp => {
                    self.observed_at_ms.is_some() && self.cpu.is_none() && self.memory.is_some()
                }
                ResourceAvailability::Unavailable => self.cpu.is_none() && self.memory.is_none(),
            }
    }
}
