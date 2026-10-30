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
    /// Deep only: after a capacity failure with settled tool calls, one
    /// continuation turn on the fallback (never a replay of the input).
    #[serde(default = "continue_deep")]
    pub continue_deep_after_side_effects: bool,
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
fn continue_deep() -> bool {
    orkestr_runtime::capacity_fallback::DEFAULT_CONTINUE_DEEP
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
        .map(|policy| policy.with_continuation(self.continue_deep_after_side_effects))
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
        assert!(policy.continues_after_side_effects(Role::Deep));
        let no_continue: CapacityFallbackConfig =
            serde_json::from_value(serde_json::json!({"continue_deep_after_side_effects": false}))
                .unwrap();
        assert!(!no_continue
            .policy()
            .unwrap()
            .continues_after_side_effects(Role::Deep));
        // The stall watchdog is off unless the operator sets it.
        assert_eq!(policy.stall_after(Role::Fast), None);
        assert_eq!(policy.stall_after(Role::Deep), None);
        let stall: CapacityFallbackConfig = serde_json::from_value(
            serde_json::json!({"stall_deep_secs": 90, "stall_fast_secs": 20}),
        )
        .unwrap();
        assert_eq!(
            stall
                .policy()
                .unwrap()
                .stall_after(Role::Fast)
                .unwrap()
                .as_secs(),
            20
        );
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
