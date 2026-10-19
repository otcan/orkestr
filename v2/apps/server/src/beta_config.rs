//! Closed operator configuration; never accepted from HTTP.
pub(crate) mod loading;
use orkestr_v2_contracts::{ConversationId, OwnerId};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
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
}
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
        Ok(())
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
