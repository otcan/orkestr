//! One-use descriptor launch under Core's combined workspace/metadata fence.
use super::*;
use orkestr_v2_store_sqlite::WorkspaceLaunch;

impl MetadataExecutor {
    /// Trusted launcher-only setup. The launch was durably consumed before this
    /// call; neither an error nor dropping this handle authorizes another spawn.
    pub fn spawn_workspace(
        &self,
        credential: &str,
        launch: &mut WorkspaceLaunch,
    ) -> Result<MetadataChild, Error> {
        let mut state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
        if state.phase != Phase::Setup
            || state.process.is_some()
            || self.shared.active.load(Ordering::Acquire) != 0
        {
            return Err(Error::Revoked);
        }
        let grant = state.grant.as_ref().ok_or(Error::Revoked)?;
        let mut process = None;
        let result = self.shared.store.with_workspace_metadata_fence(
            credential,
            launch,
            grant,
            |descriptors| {
                let identity = descriptors.workspace_identity();
                let workspace = super::super::workspace_launch::WorkspaceDescriptor::capture(
                    descriptors.workspace(),
                    super::super::workspace_launch::Identity {
                        device: identity.device(),
                        inode: identity.inode(),
                        owner: identity.uid(),
                    },
                )
                .map_err(|_| Error::InvalidPath)?;
                let resume = grant
                    .binding()
                    .native_session_id
                    .as_deref()
                    .map(|native| {
                        super::super::resume_bootstrap::ResumeBootstrap::from_grant(
                            grant.provider(),
                            native,
                        )
                    })
                    .transpose()?;
                process = Some(Process::spawn_config_workspace(
                    &self.program,
                    &self.args,
                    &self.directories,
                    self.bounds,
                    &self.shared.active,
                    &self.shared.reaper,
                    true,
                    resume,
                    Some(workspace),
                )?);
                Ok::<_, Error>(())
            },
        );
        if let Some(child) = &process {
            state.process = Some(Arc::downgrade(child));
        }
        match result {
            Ok(Ok(())) => Ok(MetadataChild {
                shared: self.shared.clone(),
                process: process.ok_or(Error::AuthorityProtocol)?,
                broker_launcher: false,
            }),
            _ => {
                state.phase = Phase::Revoked;
                // Keep the exact original child until owned cleanup takes it;
                // outer transaction failure must never discard spawn ownership.
                if let Some(child) = process {
                    let _ = child.stop();
                }
                Err(Error::Revoked)
            }
        }
    }
}
