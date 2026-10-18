//! Explicit local scheduling policy; never accepted by an HTTP endpoint.
use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerPolicy {
    mode: String,
    lifetime_ms: u32,
}

impl WorkerPolicy {
    /// One independently bound Worker for the parent's immutable input. This
    /// policy cannot select an owner, parent, native session, prompt or privilege.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.mode != "parent-input-once-v1" || !(1..=30_000).contains(&self.lifetime_ms) {
            return Err("unsupported bounded Worker scheduling policy");
        }
        Ok(())
    }

    pub(super) fn lifetime_ms(&self) -> u32 {
        self.lifetime_ms
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
    }
}
