//! Closed mutually exclusive native tool profiles.
use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ToolProfile {
    None,
    OfflinePython,
    WorkspaceExec,
    /// Operator-configured trusted command profile (background jobs).
    TrustedWorkspaceExec,
}
impl ToolProfile {
    /// `Some(trusted)` for either workspace command profile.
    pub(super) fn workspace(self) -> Option<bool> {
        match self {
            Self::WorkspaceExec => Some(false),
            Self::TrustedWorkspaceExec => Some(true),
            Self::None | Self::OfflinePython => None,
        }
    }
}

impl PreparingCodex {
    /// Trusted fixed-profile Worker setup. No caller schemas or execution bytes.
    pub fn open_worker_offline_python_retained(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
    ) -> Result<Self, SetupFailure> {
        if grant.binding().role != orkestr_v2_application::runtime::Role::Worker
            || grant.binding().native_session_id.is_some()
        {
            return Err(Blocker::Protocol.into());
        }
        Self::open_mode(
            store,
            grant,
            launcher,
            workspace,
            directories,
            true,
            ToolProfile::OfflinePython,
            resources,
            None,
            None,
        )
    }
}
