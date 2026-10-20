//! Private scheduling limits. Only Core can issue or renew execution authority.
use serde::Deserialize;
use std::time::{Duration, Instant};

pub(super) const MAX_RUN_MS: u32 = 3_600_000;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WorkerBudget {
    pub(super) max_run_ms: u32,
    #[serde(default)]
    max_idle_ms: Option<u32>,
}

impl WorkerBudget {
    /// No host command effects: only the owner's explicit budget (and Core's
    /// parent, window and supervisor deadlines) bound renewal.
    pub(super) fn owner_tasks() -> Self {
        Self {
            max_run_ms: MAX_RUN_MS,
            max_idle_ms: None,
        }
    }

    pub(super) fn workspace_commands() -> Self {
        Self {
            max_run_ms: 300_000,
            max_idle_ms: None,
        }
    }

    /// Validation still bounds this by `MAX_RUN_MS`; owners can only narrow it.
    pub(super) fn trusted_workspace_commands(max_run_ms: u32) -> Self {
        Self {
            max_run_ms,
            max_idle_ms: None,
        }
    }

    pub(super) fn validate(&self) -> Result<(), &'static str> {
        if !(30_000..=MAX_RUN_MS).contains(&self.max_run_ms)
            || self
                .max_idle_ms
                .is_some_and(|idle| !(1_000..=self.max_run_ms).contains(&idle))
        {
            return Err("Worker execution budget must have finite bounded durations");
        }
        Ok(())
    }

    /// The owner's explicit hard budget can only narrow private host policy.
    /// Core independently clips every lease to its durable absolute deadline.
    pub(super) fn start(&self, now: Instant, owner_max_run_ms: u32) -> RunBudget {
        let maximum = self.max_run_ms.min(owner_max_run_ms);
        RunBudget {
            started: now,
            last_observation: now,
            maximum: Duration::from_millis(maximum.into()),
            idle: self
                .max_idle_ms
                .map(|idle| Duration::from_millis(idle.min(maximum).into())),
        }
    }
}

pub(super) struct RunBudget {
    started: Instant,
    last_observation: Instant,
    maximum: Duration,
    idle: Option<Duration>,
}

impl RunBudget {
    /// Only a committed native observation counts. Polls and lease renewal do not.
    pub(super) fn observed(&mut self, now: Instant) {
        self.last_observation = now;
    }

    pub(super) fn expired(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.started) >= self.maximum
    }

    pub(super) fn cancellation_key(&self, now: Instant) -> Option<&'static str> {
        if self.expired(now) {
            Some("worker-run-budget-expired")
        } else if self
            .idle
            .is_some_and(|idle| now.saturating_duration_since(self.last_observation) >= idle)
        {
            Some("worker-idle-budget-expired")
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::WorkerPolicy;
    use super::*;
    use serde_json::json;

    #[test]
    fn private_policy_requires_bounded_owner_task_opt_in() {
        let legacy = json!({"mode":"owner-tasks-v1", "lifetime_ms":30000});
        let policy: WorkerPolicy = serde_json::from_value(legacy.clone()).unwrap();
        assert!(policy.validate().is_ok() && policy.execution_budget().is_none());
        for max_run_ms in [30_000, MAX_RUN_MS] {
            let mut value = legacy.clone();
            value["execution_budget"] = json!({"max_run_ms":max_run_ms});
            let policy: WorkerPolicy = serde_json::from_value(value).unwrap();
            assert!(policy.validate().is_ok() && policy.execution_budget().is_some());
        }
        for budget in [
            json!({"max_run_ms":29_999}),
            json!({"max_run_ms":MAX_RUN_MS + 1}),
            json!({"max_run_ms":60_000, "max_idle_ms":999}),
            json!({"max_run_ms":60_000, "max_idle_ms":60_001}),
        ] {
            let mut value = legacy.clone();
            value["execution_budget"] = budget;
            assert!(serde_json::from_value::<WorkerPolicy>(value)
                .unwrap()
                .validate()
                .is_err());
        }
        let mut value = legacy.clone();
        value["execution_budget"] = json!({"max_run_ms":60_000, "lease_generation":2});
        assert!(serde_json::from_value::<WorkerPolicy>(value).is_err());
        let mut value = legacy;
        value["mode"] = json!("parent-input-once-v1");
        value["execution_budget"] = json!({"max_run_ms":60_000});
        assert!(serde_json::from_value::<WorkerPolicy>(value)
            .unwrap()
            .validate()
            .is_err());
    }

    #[test]
    fn host_limit_never_expands_the_explicit_owner_budget() {
        let start = Instant::now();
        let policy = WorkerBudget {
            max_run_ms: MAX_RUN_MS,
            max_idle_ms: None,
        };
        let budget = policy.start(start, 30_000);
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(29)),
            None
        );
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(30)),
            Some("worker-run-budget-expired")
        );
        let budget = WorkerBudget {
            max_run_ms: 40_000,
            max_idle_ms: None,
        }
        .start(start, MAX_RUN_MS);
        assert!(budget.expired(start + Duration::from_secs(40)));
    }

    #[test]
    fn workspace_profile_is_finite_and_owner_budget_can_only_narrow_it() {
        let policy = WorkerBudget::workspace_commands();
        policy.validate().unwrap();
        let start = Instant::now();
        assert!(policy
            .start(start, 600_000)
            .expired(start + Duration::from_secs(300)));
        assert!(!policy
            .start(start, 600_000)
            .expired(start + Duration::from_secs(299)));
        assert!(policy
            .start(start, 45_000)
            .expired(start + Duration::from_secs(45)));
        let owner = WorkerPolicy::window_owner_tasks();
        owner.validate().unwrap();
        assert_eq!(owner.execution_budget().unwrap().max_run_ms, MAX_RUN_MS);
        assert!(owner
            .execution_budget()
            .unwrap()
            .start(start, 120_000)
            .expired(start + Duration::from_secs(120)));
        assert!(!owner.offline_python_enabled());
        let configured = WorkerPolicy::window_workspace_tasks();
        configured.validate().unwrap();
        assert_eq!(configured.execution_budget().unwrap().max_run_ms, 300_000);
        assert!(!configured.offline_python_enabled());
    }

    #[test]
    fn committed_progress_resets_idle_but_never_the_absolute_budget() {
        let start = Instant::now();
        let mut budget = WorkerBudget {
            max_run_ms: 60_000,
            max_idle_ms: Some(3_000),
        }
        .start(start, 45_000);
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(3)),
            Some("worker-idle-budget-expired")
        );
        budget.observed(start + Duration::from_secs(2));
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(4)),
            None
        );
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(5)),
            Some("worker-idle-budget-expired")
        );
        budget.observed(start + Duration::from_secs(44));
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(45)),
            Some("worker-run-budget-expired")
        );
    }

    #[test]
    fn silence_has_no_implicit_timeout_and_zero_budget_fails_closed() {
        let start = Instant::now();
        let policy = WorkerBudget {
            max_run_ms: MAX_RUN_MS,
            max_idle_ms: None,
        };
        let budget = policy.start(start, MAX_RUN_MS);
        assert_eq!(
            budget.cancellation_key(start + Duration::from_secs(3599)),
            None
        );
        assert!(budget.expired(start + Duration::from_secs(3600)));
        assert!(policy.start(start, 0).expired(start));
    }
}
