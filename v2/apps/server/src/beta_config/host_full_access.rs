//! Owner/instance-level "host full access" (V1-equivalent). Operator-only,
//! default absent. When present, every conversation served by this instance
//! runs its Codex provider sessions directly on the host with the
//! `danger-full-access` sandbox and approval `never`, and a trusted workspace
//! profile may additionally opt into `host_privileged` commands. Equivalent to
//! host root whenever the service user has passwordless sudo.
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HostFullAccess {
    /// Provider sessions use host full access (default true).
    #[serde(default = "enabled")]
    pub providers: bool,
    /// The real executor environment (must include HOME and PATH), e.g. the
    /// V1 executors' HOME, CODEX_HOME and PATH. Host-specific: private config.
    pub environment: BTreeMap<String, String>,
}

fn enabled() -> bool {
    true
}

impl HostFullAccess {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        let name = orkestr_runtime::workspace_exec::profile::host_environment_key_allowed;
        if self.environment.len() > 256
            || !["HOME", "PATH"]
                .iter()
                .all(|key| self.environment.contains_key(*key))
            || !self
                .environment
                .iter()
                .all(|(k, v)| name(k) && !v.contains('\0') && v.len() <= 16384)
            || !std::path::Path::new(&self.environment["HOME"]).is_absolute()
        {
            return Err("invalid host full access environment");
        }
        Ok(())
    }

    pub(crate) fn environment(&self) -> Vec<(String, String)> {
        self.environment
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_real_home_and_path_and_is_closed() {
        let valid: HostFullAccess = serde_json::from_value(serde_json::json!({
            "environment": {"HOME": "/home/example", "PATH": "/usr/bin:/bin", "CODEX_HOME": "/home/example/.codex"}
        }))
        .unwrap();
        valid.validate().unwrap();
        assert!(valid.providers);
        for environment in [
            serde_json::json!({"PATH": "/usr/bin"}),
            serde_json::json!({"HOME": "relative", "PATH": "/usr/bin"}),
            serde_json::json!({"HOME": "/h", "PATH": "/usr/bin", "1BAD": "x"}),
        ] {
            let bad: HostFullAccess =
                serde_json::from_value(serde_json::json!({"environment": environment})).unwrap();
            assert!(bad.validate().is_err());
        }
        assert!(serde_json::from_value::<HostFullAccess>(
            serde_json::json!({"environment": {}, "sandbox": "off"})
        )
        .is_err());
    }
}
