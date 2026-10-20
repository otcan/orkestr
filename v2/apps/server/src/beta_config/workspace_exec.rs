//! One trusted project and conversation. No HTTP or model-supplied paths.
use orkestr_v2_contracts::ConversationId;
use orkestr_v2_store_sqlite::{WorkspaceInstallation, WorkspaceOperatorAllowlist};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceExecConfig {
    pub conversation_id: ConversationId,
    pub project_id: uuid::Uuid,
    pub workspace: PathBuf,
    pub allowed_roots: Vec<PathBuf>,
    pub protected_roots: Vec<PathBuf>,
    pub cgroup_root: PathBuf,
    pub toolchain_root: PathBuf,
    /// Optional trusted owner profile; absent keeps the restricted beta.3 profile.
    #[serde(default)]
    pub trusted: Option<super::workspace_exec_trusted::TrustedConfig>,
}

impl WorkspaceExecConfig {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.conversation_id.0.is_nil()
            || self.project_id.is_nil()
            || self.allowed_roots != [self.workspace.clone()]
            || self.protected_roots.is_empty()
            || self.protected_roots.len() > 55
            || [&self.workspace, &self.cgroup_root, &self.toolchain_root]
                .into_iter()
                .chain(self.protected_roots.iter())
                .any(|path| {
                    !path.is_absolute()
                        || path == Path::new("/")
                        || path
                            .to_str()
                            .is_none_or(|text| text.contains('\0') || text.len() > 4096)
                        || path
                            .components()
                            .any(|part| matches!(part, std::path::Component::ParentDir))
                })
            || self.workspace.starts_with(&self.toolchain_root)
            || self.toolchain_root.starts_with(&self.workspace)
            || self.workspace.starts_with(&self.cgroup_root)
            || self.cgroup_root.starts_with(&self.workspace)
            || self.toolchain_root.starts_with(&self.cgroup_root)
            || self.cgroup_root.starts_with(&self.toolchain_root)
        {
            return Err("invalid workspace execution profile");
        }
        if let Some(trusted) = &self.trusted {
            trusted.profile()?.validate(&[
                &self.workspace,
                &self.cgroup_root,
                &self.toolchain_root,
            ])?;
        }
        Ok(())
    }

    /// Full trusted validation against every host location the server owns:
    /// its private home, provider workspaces, cgroup root, image and project.
    pub(crate) fn trusted_profile(
        &self,
        home: &Path,
        native_workspaces: impl Iterator<Item = PathBuf>,
    ) -> Result<Option<orkestr_runtime::workspace_exec::profile::TrustedProfile>, &'static str>
    {
        let Some(trusted) = &self.trusted else {
            return Ok(None);
        };
        let profile = trusted.profile()?;
        let natives: Vec<PathBuf> = native_workspaces.collect();
        let mut reserved: Vec<&Path> = vec![
            home,
            &self.workspace,
            &self.cgroup_root,
            &self.toolchain_root,
        ];
        reserved.extend(natives.iter().map(PathBuf::as_path));
        profile.validate(&reserved)?;
        Ok(Some(profile))
    }

    pub(crate) fn installation(
        &self,
        home: &Path,
        native_workspaces: impl Iterator<Item = PathBuf>,
    ) -> Result<WorkspaceInstallation, &'static str> {
        use std::os::unix::fs::MetadataExt;
        self.validate()?;
        let uid = std::fs::metadata(home)
            .map_err(|_| "workspace operator identity unavailable")?
            .uid();
        let mut protected = self.protected_roots.clone();
        protected.extend([
            home.to_owned(),
            self.toolchain_root.clone(),
            self.cgroup_root.clone(),
        ]);
        protected.extend(native_workspaces);
        WorkspaceOperatorAllowlist::new(self.allowed_roots.clone(), protected, uid)
            .and_then(|allowlist| allowlist.installation(&self.workspace))
            .map_err(|_| "workspace execution installation refused")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> serde_json::Value {
        serde_json::json!({
            "conversation_id":uuid::Uuid::new_v4(), "project_id":uuid::Uuid::new_v4(),
            "workspace":"/srv/project", "allowed_roots":["/srv/project"],
            "protected_roots":["/srv/private"], "cgroup_root":"/sys/fs/cgroup/example",
            "toolchain_root":"/opt/example-command-image"
        })
    }
    #[test]
    fn profile_is_closed_and_registers_exactly_one_project() {
        let value = profile();
        serde_json::from_value::<WorkspaceExecConfig>(value.clone())
            .unwrap()
            .validate()
            .unwrap();
        for (key, invalid) in [
            (
                "allowed_roots",
                serde_json::json!(["/srv/project", "/srv/other"]),
            ),
            ("workspace", serde_json::json!("/srv/other")),
            ("conversation_id", serde_json::json!(uuid::Uuid::nil())),
            ("project_id", serde_json::json!(uuid::Uuid::nil())),
            ("cgroup_root", serde_json::json!("/")),
            ("toolchain_root", serde_json::json!("/srv/project/image")),
            ("protected_roots", serde_json::json!([])),
        ] {
            let mut bad = value.clone();
            bad[key] = invalid;
            assert!(serde_json::from_value::<WorkspaceExecConfig>(bad)
                .unwrap()
                .validate()
                .is_err());
        }
        let mut trusted = value.clone();
        trusted["trusted"] = serde_json::json!({"network": true, "host_toolchain": true,
            "cache_mounts": ["/var/cache/example"]});
        let config = serde_json::from_value::<WorkspaceExecConfig>(trusted.clone()).unwrap();
        config.validate().unwrap();
        let profile = config
            .trusted_profile(Path::new("/srv/orkestr-home"), std::iter::empty())
            .unwrap()
            .unwrap();
        assert!(profile.network && !profile.credentials_exposed());
        for overlap in ["/srv/project", "/srv", "/srv/orkestr-home/secrets", "/opt"] {
            let mut bad = trusted.clone();
            bad["trusted"]["credential_mounts"] = serde_json::json!([overlap]);
            let config = serde_json::from_value::<WorkspaceExecConfig>(bad).unwrap();
            assert!(
                config.validate().is_err()
                    || config
                        .trusted_profile(Path::new("/srv/orkestr-home"), std::iter::empty())
                        .is_err(),
                "{overlap}"
            );
        }
        for key in ["command", "environment", "network", "owner_id"] {
            let mut bad = value.clone();
            bad[key] = serde_json::json!("untrusted");
            assert!(serde_json::from_value::<WorkspaceExecConfig>(bad).is_err());
        }
    }
}
