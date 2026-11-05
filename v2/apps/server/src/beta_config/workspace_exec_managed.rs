//! Explicit command-only dropped-executor environment. No legacy host/env
//! inheritance, inline credential reader, Root shell or provider account grant.
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManagedExecutorConfig {
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub credentials: Vec<BusinessCredential>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BusinessCredential {
    pub path: PathBuf,
    pub keys: Vec<String>,
}

fn key(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && value.len() <= 128
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && !["LD_", "PYTHON", "ORKESTR_", "CODEX_", "CLAUDE_"]
            .iter()
            .any(|prefix| value.starts_with(prefix))
        && !matches!(value, "BASH_ENV" | "ENV" | "IFS" | "SHELLOPTS" | "BASHOPTS")
}

fn path(value: &std::path::Path) -> bool {
    value.to_str().is_some_and(|text| {
        text.starts_with('/')
            && text.len() > 1
            && text.len() <= 4096
            && !text.contains('\0')
            && text[1..]
                .split('/')
                .all(|part| !matches!(part, "" | "." | ".."))
    })
}

impl ManagedExecutorConfig {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.environment.len() > 128
            || !self.environment.contains_key("PATH")
            || !self
                .environment
                .get("HOME")
                .is_some_and(|home| path(std::path::Path::new(home)))
            || self.environment.contains_key("PWD")
            || self
                .environment
                .iter()
                .any(|(name, value)| !key(name) || value.contains('\0') || value.len() > 16384)
            || self.credentials.len() > 8
        {
            return Err("invalid managed command environment");
        }
        let mut names: BTreeSet<_> = self.environment.keys().map(String::as_str).collect();
        let mut paths = BTreeSet::new();
        for selected in &self.credentials {
            if !path(&selected.path)
                || !paths.insert(&selected.path)
                || selected.keys.is_empty()
                || selected.keys.len() > 64
            {
                return Err("invalid managed business credential selection");
            }
            for name in &selected.keys {
                if !key(name)
                    || matches!(name.as_str(), "HOME" | "PATH" | "PWD")
                    || !names.insert(name.as_str())
                {
                    return Err("invalid managed business credential key");
                }
            }
        }
        if names.len() > 256 {
            return Err("managed command environment exceeds bound");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_command_configuration_is_closed_without_authority_or_legacy_credentials() {
        let value = serde_json::json!({"environment":{"HOME":"/home/example", "PATH":"/usr/bin:/bin"},
            "credentials":[{"path":"/etc/example/business.env","keys":["BUSINESS_ACCOUNT_KEY"]}]});
        serde_json::from_value::<ManagedExecutorConfig>(value.clone())
            .unwrap()
            .validate()
            .unwrap();
        for key in [
            "ORKESTR_V2_BOOTSTRAP_TOKEN",
            "CODEX_HOME",
            "LD_PRELOAD",
            "HOME",
        ] {
            let mut bad = value.clone();
            bad["credentials"][0]["keys"] = serde_json::json!([key]);
            assert!(serde_json::from_value::<ManagedExecutorConfig>(bad)
                .unwrap()
                .validate()
                .is_err());
        }
        let mut bad = value.clone();
        bad["credentials"][0]["keys"] =
            serde_json::json!(["BUSINESS_ACCOUNT_KEY", "BUSINESS_ACCOUNT_KEY"]);
        assert!(serde_json::from_value::<ManagedExecutorConfig>(bad)
            .unwrap()
            .validate()
            .is_err());
        for field in ["uid", "command", "host_privileged", "credential_env_files"] {
            let mut bad = value.clone();
            bad[field] = serde_json::json!(true);
            assert!(serde_json::from_value::<ManagedExecutorConfig>(bad).is_err());
        }
    }
}
