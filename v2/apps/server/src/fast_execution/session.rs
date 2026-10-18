//! One distinct Fast child. Admission always uses the non-inbox Core issuer.
use super::{consume_fast, FastDispatch};
use orkestr_runtime::{
    containment::{Authority, ChildDirectories},
    execution::{CodexPump, PreparingCodex, ReadyCodex, SetupFailure, SubmissionFailure},
    supervisor,
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
pub struct LiveFast {
    store: Store,
    authority: Authority,
    pump: CodexPump,
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
}
impl std::fmt::Display for FastFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => write!(f, "Fast store refusal: {error:?}"),
            Self::Submission(error) => write!(f, "Fast submission refusal: {error:?}"),
        }
    }
}
impl PreparingFast {
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
                let (authority, pump) = self
                    .ready
                    .attach(self.store.clone(), cap)
                    .map_err(FastFailure::Submission)?;
                Ok(FastStart::Live(Box::new(LiveFast {
                    store: self.store,
                    authority,
                    pump,
                })))
            }
        }
    }
}
impl LiveFast {
    pub async fn tick(&mut self) -> Result<bool, supervisor::Error> {
        if self.pump.flush().is_err() {
            let _ = self.authority.revoke();
            return Err(supervisor::Error::Provider(
                orkestr_runtime::ports::Blocker::Protocol,
            ));
        }
        self.pump.step(&self.store).await
    }
    /// Cleanup is negative authority, never terminal acceptance or cancellation.
    pub fn quarantine(&mut self) {
        let _ = self.authority.revoke();
    }
}
impl Drop for LiveFast {
    fn drop(&mut self) {
        self.quarantine();
    }
}
