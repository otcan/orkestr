//! Explicit managed canonical Deep profile; final Core admission is separate.
use super::*;
use crate::containment::metadata::BrokerChildLocator;
impl PreparingCodex {
    #[allow(clippy::too_many_arguments)]
    pub fn open_window_desk_retained(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
        bind: impl FnOnce(BrokerChildLocator) -> Result<(), ()>,
    ) -> Result<Self, SetupFailure> {
        if grant.binding().role != orkestr_v2_application::runtime::Role::Deep
            || grant.binding().native_session_id.is_some()
        {
            return Err(Blocker::Unsupported.into());
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
            ToolProfile::DeskLogin,
            resources,
            None,
            Some(&mut gate),
        )
    }
}
