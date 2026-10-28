//! Exact-role metadata grants share the same pre-FD3 manager bind gate.
use super::*;
use crate::containment::metadata::BrokerChildLocator;
use orkestr_v2_application::runtime::Role;

impl PreparingCodex {
    /// The original Deep entry remains role-specific. The callback obtains the
    /// authenticated manager ACK before any broker-open/native frame is queued.
    #[allow(clippy::too_many_arguments)]
    pub fn open_window_retained(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
        bind: impl FnOnce(BrokerChildLocator) -> Result<(), ()>,
    ) -> Result<Self, SetupFailure> {
        Self::open_window_role(
            store,
            grant,
            launcher,
            workspace,
            directories,
            resources,
            bind,
            Role::Deep,
            ToolProfile::None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open_window_fast_retained(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
        bind: impl FnOnce(BrokerChildLocator) -> Result<(), ()>,
    ) -> Result<Self, SetupFailure> {
        Self::open_window_role(
            store,
            grant,
            launcher,
            workspace,
            directories,
            resources,
            bind,
            Role::Fast,
            ToolProfile::None,
        )
    }

    /// A read-only parallel Deep slot: a fresh native session on the
    /// read-only service profile, whose connection requests and requires the
    /// read-only sandbox (network off) whatever the instance access is.
    #[allow(clippy::too_many_arguments)]
    pub fn open_window_parallel_deep_retained(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
        bind: impl FnOnce(BrokerChildLocator) -> Result<(), ()>,
    ) -> Result<Self, SetupFailure> {
        if grant.binding().native_session_id.is_some() {
            return Err(Blocker::Protocol.into());
        }
        let mut setup = Self::open_window_role(
            store,
            grant,
            launcher,
            workspace,
            directories,
            resources,
            bind,
            Role::Deep,
            ToolProfile::None,
        )?;
        setup.rpc = CodexRpc::read_only();
        Ok(setup)
    }

    /// A Worker starts only a fresh native session under its sealed parent grant.
    #[allow(clippy::too_many_arguments)]
    pub fn open_window_worker_retained(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
        bind: impl FnOnce(BrokerChildLocator) -> Result<(), ()>,
    ) -> Result<Self, SetupFailure> {
        if grant.binding().native_session_id.is_some() {
            return Err(Blocker::Protocol.into());
        }
        Self::open_window_role(
            store,
            grant,
            launcher,
            workspace,
            directories,
            resources,
            bind,
            Role::Worker,
            ToolProfile::None,
        )
    }

    /// A Worker starts only a fresh native session under its sealed parent grant.
    #[allow(clippy::too_many_arguments)]
    pub fn open_window_workspace_exec_retained(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
        bind: impl FnOnce(BrokerChildLocator) -> Result<(), ()>,
    ) -> Result<Self, SetupFailure> {
        if grant.binding().native_session_id.is_some() {
            return Err(Blocker::Protocol.into());
        }
        Self::open_window_role(
            store,
            grant,
            launcher,
            workspace,
            directories,
            resources,
            bind,
            Role::Worker,
            ToolProfile::WorkspaceExec,
        )
    }

    /// Trusted command profile: same sealed setup, extended fixed advertisement.
    #[allow(clippy::too_many_arguments)]
    pub fn open_window_trusted_workspace_exec_retained(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
        bind: impl FnOnce(BrokerChildLocator) -> Result<(), ()>,
    ) -> Result<Self, SetupFailure> {
        if grant.binding().native_session_id.is_some() {
            return Err(Blocker::Protocol.into());
        }
        Self::open_window_role(
            store,
            grant,
            launcher,
            workspace,
            directories,
            resources,
            bind,
            Role::Worker,
            ToolProfile::TrustedWorkspaceExec,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn open_window_role(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
        bind: impl FnOnce(BrokerChildLocator) -> Result<(), ()>,
        role: Role,
        tool_profile: ToolProfile,
    ) -> Result<Self, SetupFailure> {
        if grant.binding().role != role {
            return Err(Blocker::Protocol.into());
        }
        let mut bind = Some(bind);
        let mut gate = |child: &MetadataChild| {
            let locator = child.broker_locator()?;
            bind.take().ok_or(Blocker::Protocol)?(locator).map_err(|_| Blocker::Protocol.into())
        };
        Self::open_mode(
            store,
            grant,
            launcher,
            workspace,
            directories,
            true,
            tool_profile,
            resources,
            None,
            Some(&mut gate),
        )
    }
}
