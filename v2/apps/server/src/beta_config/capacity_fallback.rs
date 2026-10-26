//! Operator capacity fallback policy for Codex turns (default: enabled).
//! See `orkestr_runtime::capacity_fallback` for the retry rule.
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CapacityFallbackConfig {
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default = "enabled")]
    pub deep: bool,
    #[serde(default = "enabled")]
    pub fast: bool,
    /// Merged over the built-in map; `null` disables a model's fallback.
    #[serde(default)]
    pub models: BTreeMap<String, Option<String>>,
    /// Stall watchdog seconds (0 disables): a silent turn without any tool
    /// call is interrupted and retried on the fallback.
    #[serde(default = "deep_stall")]
    pub stall_deep_secs: u64,
    #[serde(default = "fast_stall")]
    pub stall_fast_secs: u64,
}

fn enabled() -> bool {
    true
}
fn deep_stall() -> u64 {
    orkestr_runtime::capacity_fallback::DEFAULT_STALL_DEEP_SECS
}
fn fast_stall() -> u64 {
    orkestr_runtime::capacity_fallback::DEFAULT_STALL_FAST_SECS
}

impl CapacityFallbackConfig {
    pub(crate) fn policy(
        &self,
    ) -> Result<orkestr_runtime::capacity_fallback::CapacityFallback, &'static str> {
        orkestr_runtime::capacity_fallback::CapacityFallback::configured(
            self.enabled,
            self.deep,
            self.fast,
            self.models.clone(),
        )?
        .with_stall(self.stall_deep_secs, self.stall_fast_secs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use orkestr_v2_contracts::runtime::Role;

    #[test]
    fn absent_fields_keep_the_enabled_default_and_bad_targets_refuse() {
        let config: CapacityFallbackConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        let policy = config.policy().unwrap();
        assert_eq!(
            policy.fallback_for(Role::Deep, "gpt-6.1-sol"),
            Some("gpt-6-sol")
        );
        assert_eq!(policy.stall_after(Role::Fast).unwrap().as_secs(), 20);
        let off: CapacityFallbackConfig =
            serde_json::from_value(serde_json::json!({"enabled": false})).unwrap();
        assert_eq!(
            off.policy()
                .unwrap()
                .fallback_for(Role::Deep, "gpt-6.1-sol"),
            None
        );
        let fable: CapacityFallbackConfig =
            serde_json::from_value(serde_json::json!({"models": {"gpt-6.1-sol": "claude-fable"}}))
                .unwrap();
        assert!(fable.policy().is_err());
        assert!(serde_json::from_value::<CapacityFallbackConfig>(
            serde_json::json!({"unknown": 1})
        )
        .is_err());
    }
}
