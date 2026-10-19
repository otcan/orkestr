//! Trusted local scheduling bounds. This policy grants no provider authority.
use serde::Deserialize;
use std::time::{Duration, Instant};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExecutionBudget {
    pub max_run_ms: u64,
    #[serde(default)]
    pub max_idle_ms: Option<u64>,
}

impl Default for ExecutionBudget {
    fn default() -> Self {
        Self {
            max_run_ms: 45_000,
            max_idle_ms: None,
        }
    }
}

impl ExecutionBudget {
    pub(super) fn validate(&self) -> Result<(), &'static str> {
        if !(1_000..=86_400_000).contains(&self.max_run_ms)
            || self
                .max_idle_ms
                .is_some_and(|idle| !(1_000..=self.max_run_ms).contains(&idle))
        {
            return Err("execution budget must have finite bounded durations");
        }
        Ok(())
    }

    pub(super) fn start(&self, now: Instant) -> RunBudget {
        RunBudget {
            started: now,
            last_observation: now,
            maximum: Duration::from_millis(self.max_run_ms),
            idle: self.max_idle_ms.map(Duration::from_millis),
        }
    }
}

/// Only committed provider observations reset the optional inactivity budget.
/// Empty polls, local timers and lease refreshes do not count as progress.
pub(super) struct RunBudget {
    started: Instant,
    last_observation: Instant,
    maximum: Duration,
    idle: Option<Duration>,
}

impl RunBudget {
    pub(super) fn observed(&mut self, now: Instant) {
        self.last_observation = now;
    }

    pub(super) fn cancellation_key(&self, now: Instant) -> Option<&'static str> {
        if now.saturating_duration_since(self.started) >= self.maximum {
            Some("execution-run-budget-expired")
        } else if self
            .idle
            .is_some_and(|idle| now.saturating_duration_since(self.last_observation) >= idle)
        {
            Some("execution-idle-budget-expired")
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_preserves_acceptance_bound_without_a_silence_timeout() {
        let start = Instant::now();
        let budget = ExecutionBudget::default().start(start);
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(44)),
            None
        );
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(45)),
            Some("execution-run-budget-expired")
        );
    }

    #[test]
    fn progress_resets_idle_budget_without_extending_absolute_budget() {
        let start = Instant::now();
        let mut budget = ExecutionBudget {
            max_run_ms: 10_000,
            max_idle_ms: Some(3_000),
        }
        .start(start);
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(3)),
            Some("execution-idle-budget-expired")
        );
        budget.observed(start + Duration::from_secs(2));
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(4)),
            None
        );
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(5)),
            Some("execution-idle-budget-expired")
        );
        budget.observed(start + Duration::from_secs(9));
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(10)),
            Some("execution-run-budget-expired")
        );
    }

    #[test]
    fn quiet_work_can_use_an_explicit_long_budget_without_idle_inference() {
        let start = Instant::now();
        let policy = ExecutionBudget {
            max_run_ms: 3_600_000,
            max_idle_ms: None,
        };
        policy.validate().unwrap();
        let budget = policy.start(start);
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(3599)),
            None
        );
        assert!(budget
            .cancellation_key(start + Duration::from_secs(3600))
            .is_some());
    }
}
