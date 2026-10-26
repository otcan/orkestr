//! One distinct Fast child. Admission always uses the non-inbox Core issuer.
use super::{consume_fast, FastDispatch, LiveFast};
use orkestr_runtime::{
    containment::ChildDirectories,
    execution::{PreparingCodex, ReadyCodex, SetupFailure, SubmissionFailure},
};
use orkestr_v2_application::runtime::{ProviderKind, Role, RuntimeStoreError};
use orkestr_v2_store_sqlite::{BoundSessionMetadata, FastAdmissionInput, Store};
use std::path::Path;

pub struct PreparingFast {
    store: Store,
    preparing: PreparingCodex,
}
pub struct ReadyFast {
    store: Store,
    ready: ReadyCodex,
}
pub enum FastStart {
    Live(Box<LiveFast>),
    Replay,
    ReconciliationRequired,
}
#[derive(Debug)]
pub enum FastFailure {
    Store(RuntimeStoreError),
    Submission(SubmissionFailure),
    Transport(orkestr_runtime::containment::Error),
}
impl std::fmt::Display for FastFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => write!(f, "Fast store refusal: {error:?}"),
            Self::Submission(error) => write!(f, "Fast submission refusal: {error:?}"),
            Self::Transport(error) => write!(f, "Fast transport refusal: {error:?}"),
        }
    }
}
impl PreparingFast {
    pub(crate) fn retire_setup(
        self,
    ) -> Result<
        orkestr_runtime::containment::metadata::RetiringMetadata,
        orkestr_runtime::containment::Error,
    > {
        self.preparing.retire_setup()
    }
    /// Same typed Fast grant, with the persistent manager's original-child gate.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn open_window_retained(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
        bind: impl FnOnce(orkestr_runtime::containment::metadata::BrokerChildLocator) -> Result<(), ()>,
    ) -> Result<Self, SetupFailure> {
        let preparing = PreparingCodex::open_window_fast_retained(
            store.clone(),
            grant,
            launcher,
            workspace,
            directories,
            resources,
            bind,
        )?;
        Ok(Self { store, preparing })
    }
    /// Trusted configuration only. The opaque grant must name a distinct Fast
    /// binding; Deep and Worker grants are rejected before any process spawn.
    pub fn open_retained(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
    ) -> Result<Self, SetupFailure> {
        if grant.binding().role != Role::Fast || grant.provider() != ProviderKind::Codex {
            return Err(orkestr_runtime::ports::Blocker::Protocol.into());
        }
        let preparing = PreparingCodex::open_retained(
            store.clone(),
            grant,
            launcher,
            workspace,
            directories,
            resources,
        )?;
        Ok(Self { store, preparing })
    }
    pub fn poll_ready(&mut self) -> Result<bool, SetupFailure> {
        self.preparing.poll()
    }
    pub async fn confirm(self) -> Result<ReadyFast, SetupFailure> {
        Ok(ReadyFast {
            store: self.store,
            ready: self.preparing.confirm().await?,
        })
    }
}
impl ReadyFast {
    pub(crate) fn retire_setup(
        self,
    ) -> Result<
        orkestr_runtime::containment::metadata::RetiringMetadata,
        orkestr_runtime::containment::Error,
    > {
        self.ready.retire_setup()
    }
    /// Consumes this setup even on replay or uncertainty. Neither outcome can
    /// restart a provider or fall back to a Deep inbox claim.
    pub async fn dispatch(
        self,
        credential: &str,
        input: &FastAdmissionInput,
    ) -> Result<FastStart, FastFailure> {
        match consume_fast(&self.store, credential, input)
            .await
            .map_err(FastFailure::Store)?
        {
            FastDispatch::Replay => Ok(FastStart::Replay),
            FastDispatch::ReconciliationRequired => Ok(FastStart::ReconciliationRequired),
            FastDispatch::Consumed(cap) => {
                let provider = cap.provider().clone();
                let renewal = self
                    .store
                    .authorize_running_renewal(&cap)
                    .await
                    .map_err(FastFailure::Store)?;
                let (authority, pump) = self
                    .ready
                    .attach(self.store.clone(), cap)
                    .map_err(FastFailure::Submission)?;
                Ok(FastStart::Live(Box::new(LiveFast::new(
                    self.store, provider, renewal, authority, pump,
                ))))
            }
        }
    }
}
