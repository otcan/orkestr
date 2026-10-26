//! Instance-wide Codex capacity fallback policy (operator configuration only).
//!
//! When a Codex turn ends with a closed capacity/overload class and the broker
//! proves that the turn made no tool call and no side-effecting item, Runtime
//! retries the very same turn once, in the same native thread and the same
//! durable run, with the configured fallback model. Any tool call or other
//! side effect before the error means no retry: the run fails with the
//! closed `provider` class. The policy never selects a Claude model.
use orkestr_v2_contracts::runtime::Role;
use std::collections::BTreeMap;
use std::sync::RwLock;

/// Built-in map; operator configuration may replace or disable entries.
pub const DEFAULT_FALLBACKS: &[(&str, &str)] =
    &[("gpt-6.1-sol", "gpt-6-sol"), ("gpt-6-luna", "gpt-6-sol")];

/// Stable prefix of the one structured log line per capacity decision.
pub const LOG_PREFIX: &str = "orkestr_capacity_fallback";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapacityFallback {
    enabled: bool,
    deep: bool,
    fast: bool,
    models: BTreeMap<String, Option<String>>,
    /// Stall watchdog: a turn with no first model item after this many
    /// seconds and no tool call is interrupted and retried on the fallback.
    /// Codex sleeps for the provider's 429 Retry-After (minutes) before it
    /// reports an error. Zero disables the watchdog for that role.
    stall_deep_secs: u64,
    stall_fast_secs: u64,
}

impl Default for CapacityFallback {
    /// Enabled for Deep and Fast with the built-in map; Workers never retry.
    fn default() -> Self {
        Self {
            enabled: true,
            deep: true,
            fast: true,
            models: DEFAULT_FALLBACKS
                .iter()
                .map(|(from, to)| ((*from).to_owned(), Some((*to).to_owned())))
                .collect(),
            stall_deep_secs: DEFAULT_STALL_DEEP_SECS,
            stall_fast_secs: DEFAULT_STALL_FAST_SECS,
        }
    }
}

/// Off by default until a canary trace measures `turn/started` -> first item
/// (compaction, xhigh reasoning); the capacity-class retry stays on.
pub const DEFAULT_STALL_DEEP_SECS: u64 = 0;
pub const DEFAULT_STALL_FAST_SECS: u64 = 0;
const MAX_STALL_SECS: u64 = 3600;

/// A fallback target must be a Codex launch model, never Claude (Fable).
fn target_valid(model: &str) -> bool {
    orkestr_v2_contracts::launch_model_valid(model)
        && !model.to_ascii_lowercase().starts_with("claude")
        && !model.to_ascii_lowercase().contains("fable")
}

impl CapacityFallback {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            ..Self::default()
        }
    }

    /// Validated operator policy. `models` entries are merged over the
    /// built-in map; a `None` target disables that model's fallback.
    pub fn configured(
        enabled: bool,
        deep: bool,
        fast: bool,
        models: BTreeMap<String, Option<String>>,
    ) -> Result<Self, &'static str> {
        let mut policy = Self {
            enabled,
            deep,
            fast,
            ..Self::default()
        };
        if models.len() > 32 {
            return Err("too many capacity fallback models");
        }
        for (from, to) in models {
            if !orkestr_v2_contracts::launch_model_valid(&from)
                || to
                    .as_deref()
                    .is_some_and(|to| !target_valid(to) || to == from)
            {
                return Err("invalid capacity fallback model");
            }
            policy.models.insert(from, to);
        }
        Ok(policy)
    }

    /// Operator stall watchdog seconds per role (0 disables).
    pub fn with_stall(mut self, deep: u64, fast: u64) -> Result<Self, &'static str> {
        if deep > MAX_STALL_SECS || fast > MAX_STALL_SECS {
            return Err("invalid capacity stall watchdog");
        }
        self.stall_deep_secs = deep;
        self.stall_fast_secs = fast;
        Ok(self)
    }

    /// The stall watchdog deadline for a role, if enabled.
    pub fn stall_after(&self, role: Role) -> Option<std::time::Duration> {
        let secs = match role {
            Role::Deep => self.stall_deep_secs,
            Role::Fast => self.stall_fast_secs,
            Role::Worker => 0,
        };
        (self.enabled_for(role) && secs > 0).then(|| std::time::Duration::from_secs(secs))
    }

    pub fn enabled_for(&self, role: Role) -> bool {
        self.enabled
            && match role {
                Role::Deep => self.deep,
                Role::Fast => self.fast,
                Role::Worker => false,
            }
    }

    /// The one fallback for a turn that failed on `model`, if any.
    pub fn fallback_for(&self, role: Role, model: &str) -> Option<&str> {
        if !self.enabled_for(role) {
            return None;
        }
        self.models
            .get(model)
            .and_then(|to| to.as_deref())
            .filter(|to| *to != model && target_valid(to))
    }
}

static POLICY: RwLock<Option<CapacityFallback>> = RwLock::new(None);

/// Trusted startup only, before any provider session exists.
pub fn install(policy: CapacityFallback) {
    if let Ok(mut current) = POLICY.write() {
        *current = Some(policy);
    }
}

/// The installed policy, or the enabled default.
pub fn current() -> CapacityFallback {
    POLICY
        .read()
        .ok()
        .and_then(|policy| policy.clone())
        .unwrap_or_default()
}

/// One structured diagnostic line per capacity decision, for the capacity
/// watcher. Closed fields only: never provider text, paths or credentials.
pub(crate) fn log(
    outcome: &'static str,
    role: Role,
    run: &str,
    conversation: &str,
    from: Option<&str>,
    to: Option<&str>,
) {
    let at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let role = match role {
        Role::Deep => "deep",
        Role::Fast => "fast",
        Role::Worker => "worker",
    };
    eprintln!(
        "{LOG_PREFIX} {}",
        serde_json::json!({
            "event": "codex_capacity",
            "outcome": outcome,
            "role": role,
            "run_id": run,
            "conversation_id": conversation,
            "from_model": from,
            "to_model": to,
            "at_ms": at_ms,
        })
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_maps_sol_and_luna_for_deep_and_fast_only() {
        let policy = CapacityFallback::default();
        for role in [Role::Deep, Role::Fast] {
            assert_eq!(policy.fallback_for(role, "gpt-6.1-sol"), Some("gpt-6-sol"));
            assert_eq!(policy.fallback_for(role, "gpt-6-luna"), Some("gpt-6-sol"));
            assert_eq!(policy.fallback_for(role, "gpt-6-sol"), None);
            assert_eq!(policy.fallback_for(role, "unmapped"), None);
        }
        assert_eq!(policy.fallback_for(Role::Worker, "gpt-6.1-sol"), None);
        assert_eq!(
            CapacityFallback::disabled().fallback_for(Role::Deep, "gpt-6.1-sol"),
            None
        );
    }

    #[test]
    fn configuration_merges_disables_and_never_targets_claude() {
        let mut models = BTreeMap::new();
        models.insert("gpt-6-luna".to_owned(), None);
        models.insert("gpt-7".to_owned(), Some("gpt-6-sol".to_owned()));
        let policy = CapacityFallback::configured(true, true, false, models).unwrap();
        assert_eq!(policy.fallback_for(Role::Deep, "gpt-6-luna"), None);
        assert_eq!(policy.fallback_for(Role::Deep, "gpt-7"), Some("gpt-6-sol"));
        assert_eq!(
            policy.fallback_for(Role::Deep, "gpt-6.1-sol"),
            Some("gpt-6-sol")
        );
        assert_eq!(policy.fallback_for(Role::Fast, "gpt-6.1-sol"), None);
        for target in [
            "claude-fable",
            "claude-opus-5-5",
            "Fable",
            "gpt-6.1-sol",
            "bad model",
        ] {
            let mut models = BTreeMap::new();
            models.insert("gpt-6.1-sol".to_owned(), Some(target.to_owned()));
            assert!(
                CapacityFallback::configured(true, true, true, models).is_err(),
                "{target}"
            );
        }
    }
}
