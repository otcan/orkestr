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
        Ok(())
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
        for key in ["command", "environment", "network", "owner_id"] {
            let mut bad = value.clone();
            bad[key] = serde_json::json!("untrusted");
            assert!(serde_json::from_value::<WorkspaceExecConfig>(bad).is_err());
        }
    }
}
