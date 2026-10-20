//! Explicit local scheduling policy; never accepted by an HTTP endpoint.
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerPolicy {
    mode: String,
    lifetime_ms: u32,
    #[serde(default)]
    execution_budget: Option<super::budget::WorkerBudget>,
    #[serde(default)]
    offline_python: bool,
    #[serde(default)]
    broker_launcher: Option<PathBuf>,
    #[serde(default)]
    broker_launcher_sha256: Option<String>,
}

impl WorkerPolicy {
    /// Window Workers without command authority. The owner's explicit task
    /// budget (never this host cap alone) enables same-child lease renewal, so
    /// a longer task no longer stops at the 30 second initial lease.
    pub(crate) fn window_owner_tasks() -> Self {
        Self {
            mode: "owner-tasks-v1".into(),
            lifetime_ms: 30_000,
            execution_budget: Some(super::budget::WorkerBudget::owner_tasks()),
            offline_python: false,
            broker_launcher: None,
            broker_launcher_sha256: None,
        }
    }

    pub(crate) fn window_workspace_tasks() -> Self {
        Self {
            execution_budget: Some(super::budget::WorkerBudget::workspace_commands()),
            ..Self::window_owner_tasks()
        }
    }
    /// Trusted command profile: Workers may poll detached jobs for longer.
    pub(crate) fn window_trusted_workspace_tasks(max_run_ms: u32) -> Self {
        Self {
            execution_budget: Some(super::budget::WorkerBudget::trusted_workspace_commands(
                max_run_ms,
            )),
            ..Self::window_owner_tasks()
        }
    }
    /// One independently bound Worker for the parent's immutable input. This
    /// policy cannot select an owner, parent, native session, prompt or privilege.
    pub fn validate(&self) -> Result<(), &'static str> {
        if !matches!(
            self.mode.as_str(),
            "parent-input-once-v1" | "owner-tasks-v1"
        ) || !(1..=30_000).contains(&self.lifetime_ms)
            || (self.owner_tasks() && self.lifetime_ms != 30_000)
        {
            return Err("unsupported bounded Worker scheduling policy");
        }
        if let Some(budget) = &self.execution_budget {
            if !self.owner_tasks() {
                return Err("extended Worker budgets require explicit owner tasks");
            }
            budget.validate()?;
        }
        match (
            self.offline_python,
            &self.broker_launcher,
            &self.broker_launcher_sha256,
        ) {
            (false, None, None) => {}
            (true, Some(path), Some(digest)) => {
                super::configuration::verify_launcher(path, digest)?
            }
            _ => {
                return Err("offline Worker requires one fixed trusted broker launcher and digest")
            }
        }
        Ok(())
    }

    pub fn offline_python_enabled(&self) -> bool {
        self.offline_python
    }

    pub fn broker_launcher(&self) -> Option<(&Path, &str)> {
        self.broker_launcher
            .as_deref()
            .zip(self.broker_launcher_sha256.as_deref())
    }

    pub(super) fn owner_tasks(&self) -> bool {
        self.mode == "owner-tasks-v1"
    }

    pub(super) fn lifetime_ms(&self) -> u32 {
        self.lifetime_ms
    }

    pub(super) fn execution_budget(&self) -> Option<&super::budget::WorkerBudget> {
        self.execution_budget.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_explicit_bounded_server_policy_is_accepted() {
        for lifetime_ms in [1, 30_000] {
            let policy: WorkerPolicy = serde_json::from_value(json!({
                "mode":"parent-input-once-v1", "lifetime_ms":lifetime_ms
            }))
            .unwrap();
            assert!(policy.validate().is_ok());
            assert_eq!(policy.lifetime_ms(), lifetime_ms);
        }
        for (mode, lifetime_ms) in [
            ("parent-input-once-v1", 0),
            ("parent-input-once-v1", 30_001),
            ("unbounded", 100),
            ("owner-tasks-v1", 1000),
        ] {
            let policy: WorkerPolicy = serde_json::from_value(json!({
                "mode":mode, "lifetime_ms":lifetime_ms
            }))
            .unwrap();
            assert!(policy.validate().is_err());
        }
        for field in [
            "owner_id",
            "prompt",
            "parent_run",
            "native_session",
            "capabilities",
        ] {
            let mut value = json!({"mode":"parent-input-once-v1", "lifetime_ms":1000});
            value[field] = json!("synthetic forged authority");
            assert!(serde_json::from_value::<WorkerPolicy>(value).is_err());
        }
        assert!(serde_json::from_value::<WorkerPolicy>(json!({})).is_err());
        let tasks: WorkerPolicy = serde_json::from_value(json!({
            "mode":"owner-tasks-v1", "lifetime_ms":30000
        }))
        .unwrap();
        assert!(tasks.validate().is_ok() && tasks.owner_tasks());
    }

    #[test]
    fn offline_profile_is_explicit_complete_and_pins_private_executable() {
        use sha2::{Digest, Sha256};
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"))
            .join(format!("worker-policy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let launcher = root.join("synthetic-worker-broker");
        std::fs::write(&launcher, b"#!/bin/sh\nexit 2\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let launcher = launcher.canonicalize().unwrap();
        let valid = json!({"mode":"owner-tasks-v1", "lifetime_ms":30000, "offline_python":true,
            "broker_launcher":launcher, "broker_launcher_sha256":format!("{:x}", Sha256::digest(std::fs::read(&launcher).unwrap()))});
        let policy: WorkerPolicy = serde_json::from_value(valid.clone()).unwrap();
        assert!(policy.validate().is_ok() && policy.offline_python_enabled());
        assert_eq!(policy.broker_launcher().unwrap().0, launcher);
        for field in ["broker_launcher", "broker_launcher_sha256"] {
            let mut missing = valid.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<WorkerPolicy>(missing)
                .unwrap()
                .validate()
                .is_err());
        }
        let mut disabled = valid.clone();
        disabled["offline_python"] = json!(false);
        assert!(serde_json::from_value::<WorkerPolicy>(disabled)
            .unwrap()
            .validate()
            .is_err());
        let mut wrong = valid.clone();
        wrong["broker_launcher_sha256"] = json!("0".repeat(64));
        assert!(serde_json::from_value::<WorkerPolicy>(wrong)
            .unwrap()
            .validate()
            .is_err());
        let mut relative = valid;
        relative["broker_launcher"] = json!("relative-broker");
        assert!(serde_json::from_value::<WorkerPolicy>(relative)
            .unwrap()
            .validate()
            .is_err());
        std::fs::write(&launcher, b"#!/bin/sh\nexit 3\n").unwrap();
        assert!(
            policy.validate().is_err(),
            "changed executable must invalidate the profile"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
