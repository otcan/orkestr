//! Fixed descriptor-only launcher entries; no browser-selected workspace mode.
use super::*;
use orkestr_v2_store_sqlite::WorkspaceLaunch;

impl TrustedLauncher {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn open_workspace_metadata_fd_retained(
        &self,
        store: Store,
        grant: BoundSessionMetadata,
        credential: &str,
        launch: &mut WorkspaceLaunch,
        directories: ChildDirectories,
        bounds: TransportBounds,
        resources: Box<dyn Send + 'static>,
    ) -> Result<(MetadataAuthority, MetadataChild), Error> {
        if grant.provider() != orkestr_v2_application::runtime::ProviderKind::Codex {
            return Err(Error::AuthorityProtocol);
        }
        let resume = grant.binding().native_session_id.is_some();
        let authority = MetadataAuthority::new_retained(store, grant, resources)?;
        let child = authority
            .issue_executor(
                &self.executable,
                &[
                    if resume {
                        "resume-owned-workspace-session"
                    } else {
                        "open-owned-workspace-session"
                    }
                    .into(),
                    "--protocol".into(),
                    PROTOCOL.into(),
                ],
                directories,
                bounds,
            )?
            .spawn_workspace(credential, launch)?;
        Ok((authority, child.mark_broker_launcher(BrokerLaunch(()))))
    }
}
