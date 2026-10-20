//! Closed operator configuration; never accepted from HTTP.
pub(crate) mod host_full_access;
pub(crate) mod loading;
pub(crate) mod roles;
pub(crate) mod workspace_exec;
pub(crate) mod workspace_exec_trusted;
use orkestr_v2_contracts::{ConversationId, OwnerId};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BetaConfig {
    pub schema_version: u32,
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub manager_socket: PathBuf,
    pub launcher: PathBuf,
    pub launcher_sha256: String,
    pub workspace: PathBuf,
    pub namespace: String,
    pub supervisor_key: String,
    #[serde(default)]
    pub roles: Option<roles::Roles>,
    #[serde(default)]
    pub workspace_exec: Option<workspace_exec::WorkspaceExecConfig>,
    /// Owner-wide bound on concurrently live execution windows (conversations
    /// with active Deep work). Further fresh-window intents queue durably.
    #[serde(default)]
    pub max_active_windows: Option<u32>,
    /// Owner/instance-level V1-equivalent full access; absent by default.
    #[serde(default)]
    pub host_full_access: Option<host_full_access::HostFullAccess>,
}
/// Default number of conversations that may hold a live window at once.
pub(crate) const DEFAULT_ACTIVE_WINDOWS: u32 = 8;
/// Upper bound; the root manager's independent ceiling stays above it.
pub(crate) const MAX_ACTIVE_WINDOWS: u32 = 12;
impl BetaConfig {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        let key = |s: &str| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
        };
        if self.schema_version != 1
            || self.owner_id.0.is_nil()
            || self.conversation_id.0.is_nil()
            || !self.manager_socket.is_absolute()
            || !self.launcher.is_absolute()
            || !self.workspace.is_absolute()
            || !key(&self.namespace)
            || !key(&self.supervisor_key)
            || self.launcher_sha256.len() != 64
            || !self
                .launcher_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("invalid beta configuration");
        }
        if let Some(roles) = &self.roles {
            roles.validate(&self.launcher)?;
        }
        if self
            .max_active_windows
            .is_some_and(|value| value == 0 || value > MAX_ACTIVE_WINDOWS)
        {
            return Err("invalid beta window capacity");
        }
        if let Some(access) = &self.host_full_access {
            access.validate()?;
        }
        if let Some(profile) = &self.workspace_exec {
            profile.validate_with(self.host_full_access.as_ref())?;
            if self.roles.is_none() {
                return Err("workspace execution requires configured Worker roles");
            }
        }
        Ok(())
    }

    pub(crate) fn active_windows(&self) -> u32 {
        self.max_active_windows.unwrap_or(DEFAULT_ACTIVE_WINDOWS)
    }

    pub(crate) fn workspace_profile(&self) -> Option<&workspace_exec::WorkspaceExecConfig> {
        self.workspace_exec
            .as_ref()
            .filter(|profile| profile.conversation_id == self.conversation_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> serde_json::Value {
        serde_json::json!({
            "schema_version":1,
            "owner_id":"11111111-1111-4111-8111-111111111111",
            "conversation_id":"22222222-2222-4222-8222-222222222222",
            "manager_socket":"/run/example-manager/control.sock",
            "launcher":"/opt/example-package/launcher",
            "launcher_sha256":"a".repeat(64),
            "workspace":"/srv/example-workspace",
            "namespace":"beta-deep", "supervisor_key":"beta-supervisor"
        })
    }
    #[test]
    fn closed_schema_rejects_authority_and_limit_overrides() {
        let valid: BetaConfig = serde_json::from_value(input()).unwrap();
        valid.validate().unwrap();
        for name in [
            "token",
            "machine_token_file",
            "role",
            "provider",
            "limits",
            "account",
        ] {
            let mut value = input();
            value[name] = serde_json::json!("override");
            assert!(
                serde_json::from_value::<BetaConfig>(value).is_err(),
                "{name}"
            );
        }
    }
    #[test]
    fn window_capacity_defaults_and_is_bounded() {
        let valid: BetaConfig = serde_json::from_value(input()).unwrap();
        assert_eq!(valid.active_windows(), DEFAULT_ACTIVE_WINDOWS);
        for (value, ok) in [(1, true), (12, true), (0, false), (13, false)] {
            let mut config = input();
            config["max_active_windows"] = serde_json::json!(value);
            let config: BetaConfig = serde_json::from_value(config).unwrap();
            assert_eq!(config.validate().is_ok(), ok, "{value}");
            if ok {
                assert_eq!(config.active_windows(), value);
            }
        }
        let mut negative = input();
        negative["max_active_windows"] = serde_json::json!(-1);
        assert!(serde_json::from_value::<BetaConfig>(negative).is_err());
    }
    #[test]
    fn relative_paths_nil_scope_and_noncanonical_digest_refuse() {
        for (key, bad) in [
            ("schema_version", serde_json::json!(2)),
            (
                "owner_id",
                serde_json::json!("00000000-0000-0000-0000-000000000000"),
            ),
            ("manager_socket", serde_json::json!("relative.sock")),
            ("workspace", serde_json::json!("relative")),
            ("launcher_sha256", serde_json::json!("A".repeat(64))),
            ("namespace", serde_json::json!("invalid namespace")),
        ] {
            let mut value = input();
            value[key] = bad;
            let config: BetaConfig = serde_json::from_value(value).unwrap();
            assert!(config.validate().is_err(), "{key}");
        }
    }
}
