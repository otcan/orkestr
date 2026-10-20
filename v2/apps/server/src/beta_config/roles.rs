//! Fixed operator-selected companions. This describes installation, not authority.
use serde::Deserialize;
use std::{collections::HashSet, path::PathBuf};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RoleLaunch {
    pub launcher: PathBuf,
    pub launcher_sha256: String,
    pub workspace: PathBuf,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Roles {
    pub fast: RoleLaunch,
    pub workers: [RoleLaunch; 4],
}

impl Roles {
    pub(crate) fn launches(&self) -> impl Iterator<Item = &RoleLaunch> {
        std::iter::once(&self.fast).chain(self.workers.iter())
    }

    pub(crate) fn validate(&self, deep: &std::path::Path) -> Result<(), &'static str> {
        let mut launchers = HashSet::from([deep]);
        for role in self.launches() {
            if !role.launcher.is_absolute()
                || !role.workspace.is_absolute()
                || !launchers.insert(role.launcher.as_path())
                || role.launcher_sha256.len() != 64
                || !role
                    .launcher_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("invalid beta role configuration");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> serde_json::Value {
        let role = |name: &str| {
            serde_json::json!({
                "launcher":format!("/opt/example/launcher-{name}"),
                "launcher_sha256":"a".repeat(64), "workspace":"/srv/example/workspace"
            })
        };
        serde_json::json!({"fast":role("fast"),
            "workers":[role("worker-0"),role("worker-1"),role("worker-2"),role("worker-3")]})
    }

    #[test]
    fn exact_fixed_launchers_allow_shared_workspace_but_no_authority_overrides() {
        let roles: Roles = serde_json::from_value(input()).unwrap();
        roles
            .validate(std::path::Path::new("/opt/example/launcher-deep"))
            .unwrap();
        for key in [
            "namespace",
            "supervisor_key",
            "token",
            "provider",
            "limits",
            "role",
        ] {
            let mut value = input();
            value["fast"][key] = serde_json::json!("untrusted");
            assert!(serde_json::from_value::<Roles>(value).is_err(), "{key}");
        }
    }

    #[test]
    fn worker_inventory_and_distinct_role_paths_are_closed() {
        for count in [0, 3, 5] {
            let mut value = input();
            value["workers"] = serde_json::Value::Array(vec![value["fast"].clone(); count]);
            assert!(serde_json::from_value::<Roles>(value).is_err());
        }
        let mut value = input();
        value["workers"][0] = value["fast"].clone();
        let roles: Roles = serde_json::from_value(value).unwrap();
        assert!(roles
            .validate(std::path::Path::new("/opt/example/deep"))
            .is_err());
        let roles: Roles = serde_json::from_value(input()).unwrap();
        assert!(roles.validate(&roles.fast.launcher).is_err());
    }
}
