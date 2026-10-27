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
    /// Start the fresh native thread with the Fast turn's explicit model.
    pub(crate) fn with_thread_model(self, model: Option<String>) -> Result<Self, SetupFailure> {
        Ok(Self {
            store: self.store,
            preparing: self.preparing.with_thread_model(model)?,
        })
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
        let dispatch = consume_fast(&self.store, credential, input)
            .await
            .map_err(FastFailure::Store)?;
        self.start(dispatch).await
    }

    /// Like `dispatch`, but when Core refuses the admission itself (no run
    /// was created: held, already presented elsewhere, stale or busy) this
    /// unused setup is handed back so its child can be retired normally.
    pub(crate) async fn dispatch_or_refused(
        self,
        credential: &str,
        input: &FastAdmissionInput,
    ) -> Result<Result<FastStart, (Box<Self>, RuntimeStoreError)>, FastFailure> {
        let admitted = match self.store.admit_fast(credential, input).await {
            Ok(admitted) => admitted,
            Err(
                error @ (RuntimeStoreError::Fenced
                | RuntimeStoreError::Conflict
                | RuntimeStoreError::Busy
                | RuntimeStoreError::StaleLease
                | RuntimeStoreError::NotFound),
            ) => return Ok(Err((Box::new(self), error))),
            Err(error) => return Err(FastFailure::Store(error)),
        };
        let dispatch = super::consume_admitted(&self.store, admitted, input)
            .await
            .map_err(FastFailure::Store)?;
        self.start(dispatch).await.map(Ok)
    }

    async fn start(self, dispatch: FastDispatch) -> Result<FastStart, FastFailure> {
        match dispatch {
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
