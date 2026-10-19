//! Explicit operator installation, never a browser path or inferred inventory.
use super::*;
use orkestr_v2_store_sqlite::{WorkspaceGrant, WorkspaceInstallation, WorkspaceOperatorAllowlist};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WorkspacePolicy {
    project_id: uuid::Uuid,
    allowed_roots: Vec<PathBuf>,
    protected_roots: Vec<PathBuf>,
}
impl WorkspacePolicy {
    pub(super) fn installation(
        &self,
        selected: &Path,
        home: &Path,
    ) -> Result<WorkspaceInstallation, &'static str> {
        use std::os::unix::fs::MetadataExt;
        if self.project_id.is_nil() {
            return Err("workspace project identity is required");
        }
        let uid = std::fs::metadata(home)
            .map_err(|_| "workspace operator unavailable")?
            .uid();
        let mut protected = self.protected_roots.clone();
        protected.push(home.to_path_buf());
        WorkspaceOperatorAllowlist::new(self.allowed_roots.clone(), protected, uid)
            .and_then(|allowlist| allowlist.installation(selected))
            .map_err(|_| "workspace operator installation refused")
    }
    pub(super) async fn register(
        &self,
        store: &Store,
        token: &str,
        conversation: &orkestr_v2_contracts::ConversationId,
        installation: WorkspaceInstallation,
    ) -> Result<WorkspaceGrant, &'static str> {
        store
            .register_workspace(token, conversation, self.project_id, installation)
            .await
            .map_err(|_| "workspace registration refused")
    }
}
impl ConfiguredExecution {
    pub(super) async fn bind_workspace(
        &self,
        binding: &orkestr_v2_application::runtime::Binding,
    ) -> Result<(), &'static str> {
        if let Some(grant) = &self.workspace_grant {
            self.store
                .bind_workspace_session(&self.token, grant, binding)
                .await
                .map_err(|_| "workspace session binding refused")?;
        }
        Ok(())
    }
    pub(super) async fn workspace_launch(
        &self,
        metadata: &BoundSessionMetadata,
    ) -> Result<Option<orkestr_v2_store_sqlite::WorkspaceLaunch>, &'static str> {
        use orkestr_v2_store_sqlite::{
            WorkspaceLaunchConsumption, WorkspaceLaunchReservationResult,
        };
        let Some(grant) = &self.workspace_grant else {
            return Ok(None);
        };
        self.bind_workspace(metadata.binding()).await?;
        let key = format!(
            "workspace:{}:{}",
            metadata.binding().session_id,
            metadata.binding().generation
        );
        let reservation = match self
            .store
            .reserve_workspace_launch(&self.token, grant, metadata, &key)
            .await
            .map_err(|_| "workspace launch reservation refused")?
        {
            WorkspaceLaunchReservationResult::Reserved(value) => value,
            WorkspaceLaunchReservationResult::ReconciliationRequired => {
                return Err("workspace launch requires reconciliation")
            }
        };
        match self
            .store
            .consume_workspace_launch(&self.token, reservation)
            .await
            .map_err(|_| "workspace launch consumption uncertain")?
        {
            WorkspaceLaunchConsumption::Launch(value) => Ok(Some(value)),
            WorkspaceLaunchConsumption::ReconciliationRequired => {
                Err("workspace launch requires reconciliation")
            }
        }
    }
}
