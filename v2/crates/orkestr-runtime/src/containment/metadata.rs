//! Pre-run setup and one-way transfer; no raw setup path authorizes inference.
//!
//! Core d2a1720b issues the non-Clone Starting grant and Ready transition.
//! Runtime owns module registration, correlated readiness validation and private
//! prepare(cap) -> (ConsumedTurn, real StoreFence). Preparation performs no I/O.
//! The existing process/reaper/framing implementation is reused without restart.
//! One setup grant permits one child; a transferred child retains its original
//! capacity/reaper lineage. Old metadata revocation has no execution ownership.
//!
//! Lock order is metadata gate -> Core durable fence -> execution gate -> child.
//! Never call these methods from an already-held durable fence callback. Setup
//! is frozen before awaiting confirmation, so cancellation cannot leave a grant
//! available for writes. Every attach failure quarantines the owned process and
//! consumes the dispatch, including unknown callback/commit outcomes.
//!
//! The broker remains Runtime-owned: no profile/auth-home copying, environment
//! overrides, live-session adoption, or canonical credential access is provided.
//! Runtime must supply a separately authorized canonical subscription route;
//! an executable or disposable HOME is not subscription authorization.
use super::process::{start_reaper_retained, validate_metadata, Process, Reaper};
use super::scope::{Shared, State};
use super::{
    sys, Authority, ChildDirectories, ConsumedTurn, DispatchFence, Error, ExecutionScope, Exit,
    Flush, Output, OwnedChild, TransportBounds, TurnFailure,
};
use orkestr_v2_application::runtime::{Binding, NativeSessionConfirmation, ProviderKind};
use orkestr_v2_store_sqlite::{
    BoundSessionMetadata, ConsumedProviderDispatch, ReadySessionTransition, Store,
};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

#[derive(Clone, PartialEq, Eq)]
struct MetadataScope {
    binding: Binding,
    namespace: String,
    incarnation: String,
    provider: ProviderKind,
}
impl MetadataScope {
    fn from_grant(grant: &BoundSessionMetadata) -> Self {
        Self {
            binding: grant.binding().clone(),
            namespace: grant.namespace().into(),
            incarnation: grant.incarnation_id().into(),
            provider: grant.provider(),
        }
    }
}
#[derive(PartialEq, Eq)]
enum Phase {
    Setup,
    Confirming,
    Ready,
    Transferred,
    Revoked,
}
struct MetadataState {
    phase: Phase,
    grant: Option<BoundSessionMetadata>,
    process: Option<Weak<Process>>,
    broker_open_attempted: bool,
}
struct MetadataShared {
    store: Store,
    scope: MetadataScope,
    state: Mutex<MetadataState>,
    active: Arc<AtomicUsize>,
    reaper: Reaper,
}
impl MetadataShared {
    fn quarantine(&self, process: &Process) {
        if let Ok(mut state) = self.state.lock() {
            state.phase = Phase::Revoked;
        }
        let _ = process.stop();
    }
    // Lock order: metadata gate -> Core durable fence -> execution gate -> child.
    // No caller may enter metadata methods from a durable fence callback.
    fn setup<T>(&self, action: impl FnOnce() -> Result<T, Error>) -> Result<T, Error> {
        let state = self.state.lock().map_err(|_| Error::Revoked)?;
        if state.phase != Phase::Setup {
            return Err(Error::Revoked);
        }
        let grant = state.grant.as_ref().ok_or(Error::Revoked)?;
        self.store
            .with_metadata_fence(grant, action)
            .map_err(|_| Error::Revoked)?
    }
}

/// One authenticated Starting grant, one child, no inference capability.
/// Runtime provides canonical subscription access separately through its broker.
pub struct MetadataAuthority {
    shared: Arc<MetadataShared>,
}
impl MetadataAuthority {
    pub fn new(store: Store, grant: BoundSessionMetadata) -> Result<Self, Error> {
        Self::new_retained(store, grant, Box::new(()))
    }
    /// Retains opaque capacity/scratch until the owned reaper has waited every child.
    pub fn new_retained(
        store: Store,
        grant: BoundSessionMetadata,
        resources: Box<dyn Send + 'static>,
    ) -> Result<Self, Error> {
        sys::supported()?;
        // Validate ordinary issuer authority before creating local resources.
        store
            .with_metadata_fence(&grant, || Ok::<_, Error>(()))
            .map_err(|_| Error::Revoked)??;
        let active = Arc::new(AtomicUsize::new(0));
        let reaper = start_reaper_retained(active.clone(), resources)?;
        Ok(Self {
            shared: Arc::new(MetadataShared {
                store,
                scope: MetadataScope::from_grant(&grant),
                state: Mutex::new(MetadataState {
                    phase: Phase::Setup,
                    grant: Some(grant),
                    process: None,
                    broker_open_attempted: false,
                }),
                active,
                reaper,
            }),
        })
    }
    pub fn issue_executor(
        &self,
        program: &Path,
        args: &[OsString],
        directories: ChildDirectories,
        bounds: TransportBounds,
    ) -> Result<MetadataExecutor, Error> {
        let bounds = bounds.validate()?;
        if !program.is_absolute() || !program.is_file() {
            return Err(Error::InvalidPath);
        }
        let program = program.canonicalize().map_err(|_| Error::InvalidPath)?;
        self.shared.setup(|| Ok(()))?;
        Ok(MetadataExecutor {
            shared: self.shared.clone(),
            program,
            args: args.to_vec(),
            directories,
            bounds,
        })
    }
    pub fn revoke(&self) -> Result<(), Error> {
        let mut state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
        if state.phase == Phase::Transferred {
            return Ok(());
        }
        state.phase = Phase::Revoked;
        if let Some(process) = state.process.as_ref().and_then(Weak::upgrade) {
            process.stop()?;
        }
        Ok(())
    }
}
impl Drop for MetadataAuthority {
    fn drop(&mut self) {
        let _ = self.revoke();
    }
}

pub struct MetadataExecutor {
    shared: Arc<MetadataShared>,
    program: PathBuf,
    args: Vec<OsString>,
    directories: ChildDirectories,
    bounds: TransportBounds,
}
impl MetadataExecutor {
    pub fn spawn(&self) -> Result<MetadataChild, Error> {
        self.spawn_mode(false)
    }
    pub(super) fn spawn_with_provider_fd(&self) -> Result<MetadataChild, Error> {
        self.spawn_mode(true)
    }
    fn spawn_mode(&self, provider_fd: bool) -> Result<MetadataChild, Error> {
        let mut state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
        if state.phase != Phase::Setup {
            return Err(Error::Revoked);
        }
        if state.process.is_some() || self.shared.active.load(Ordering::Acquire) != 0 {
            return Err(Error::Capacity);
        }
        let grant = state.grant.as_ref().ok_or(Error::Revoked)?;
        let mut process = None;
        let result = self.shared.store.with_metadata_fence(grant, || {
            process = Some(Process::spawn_config_mode(
                &self.program,
                &self.args,
                &self.directories,
                self.bounds,
                &self.shared.active,
                &self.shared.reaper,
                provider_fd,
                if provider_fd {
                    grant
                        .binding()
                        .native_session_id
                        .as_deref()
                        .map(|native| {
                            super::resume_bootstrap::ResumeBootstrap::from_grant(
                                grant.provider(),
                                native,
                            )
                        })
                        .transpose()?
                } else {
                    None
                },
            )?);
            Ok::<_, Error>(())
        });
        // Once spawn happened, even a COMMIT failure cannot grant a replacement.
        if let Some(process) = &process {
            state.process = Some(Arc::downgrade(process));
        }
        result.map_err(|_| Error::Revoked)??;
        Ok(MetadataChild {
            shared: self.shared.clone(),
            process: process.ok_or(Error::AuthorityProtocol)?,
            broker_launcher: false,
        })
    }
}

/// Non-Clone owned setup endpoint. No turn method, raw pipe, PID or environment.
pub struct MetadataChild {
    shared: Arc<MetadataShared>,
    process: Arc<Process>,
    broker_launcher: bool,
}
impl MetadataChild {
    pub(crate) fn receive_provider_writer(&self) -> Result<bool, Error> {
        self.shared.setup(|| {
            let mut live = self.process.live.lock().map_err(|_| Error::Revoked)?;
            if live.provider_writer.is_some() {
                return Ok(true);
            }
            let writer = live
                .handoff
                .as_mut()
                .ok_or(Error::AuthorityProtocol)?
                .receive()?;
            if let Some(writer) = writer {
                live.provider_writer = Some(writer);
                live.handoff = None;
                return Ok(true);
            }
            Ok(false)
        })
    }
    pub(crate) fn write_provider_metadata(&self, bytes: &[u8]) -> Result<usize, Error> {
        self.shared.setup(|| {
            self.process
                .live
                .lock()
                .map_err(|_| Error::Revoked)?
                .provider_writer
                .as_mut()
                .ok_or(Error::AuthorityProtocol)?
                .write_suffix(bytes)
        })
    }

    /// Only the trusted fixed-launcher module can construct this marker.
    pub(super) fn mark_broker_launcher(mut self, _: super::broker::BrokerLaunch) -> Self {
        self.broker_launcher = true;
        self.process.broker_launcher.store(true, Ordering::Release);
        self
    }

    /// One typed open derived internally from the original issuer grant. No
    /// caller JSON, handle or identity is accepted. Latch before enqueue; an
    /// uncertain queue/transaction outcome quarantines instead of retrying.
    pub fn open_broker_metadata(&self) -> Result<crate::broker::BrokerOpen, Error> {
        let result = (|| {
            let mut state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
            let outcome = (|| {
                if !self.broker_launcher || state.phase != Phase::Setup {
                    return Err(Error::Revoked);
                }
                if state.broker_open_attempted {
                    return Err(Error::AuthorityProtocol);
                }
                state.broker_open_attempted = true;
                let grant = state.grant.as_ref().ok_or(Error::Revoked)?;
                let mut codec = crate::broker::BrokerOpen::from_metadata(grant)
                    .map_err(|_| Error::InvalidFrame)?;
                codec
                    .bind_lineage(self.process.broker_lineage.clone())
                    .map_err(|_| Error::InvalidFrame)?;
                let frame = codec.request().map_err(|_| Error::InvalidFrame)?;
                if frame.len() > self.process.max_frame {
                    return Err(Error::FrameTooLarge);
                }
                self.shared
                    .store
                    .with_metadata_fence(grant, || {
                        self.process
                            .live
                            .lock()
                            .map_err(|_| Error::Revoked)?
                            .framing
                            .enqueue(&frame)
                    })
                    .map_err(|_| Error::Revoked)??;
                Ok(codec)
            })();
            // Close the phase under the same gate before another thread can
            // flush a previously queued setup frame after an uncertain open.
            if outcome.is_err() {
                state.phase = Phase::Revoked;
            }
            outcome
        })();
        if result.is_err() {
            self.shared.quarantine(&self.process);
        }
        result
    }

    pub fn enqueue_metadata(&self, frame: &[u8]) -> Result<(), Error> {
        if frame.len() > self.process.max_frame {
            return Err(Error::FrameTooLarge);
        }
        let canonical = validate_metadata(frame, &self.process.workspace)?;
        self.shared.setup(|| {
            self.process
                .live
                .lock()
                .map_err(|_| Error::Revoked)?
                .framing
                .enqueue(&canonical)
        })
    }
    pub fn flush_stdin(&self) -> Result<Flush, Error> {
        self.shared.setup(|| {
            let mut live = self.process.live.lock().map_err(|_| Error::Revoked)?;
            let result = live.framing.flush();
            if result.is_err() {
                live.framing.close();
            }
            result
        })
    }
    pub fn poll_stdout(&self) -> Result<Output, Error> {
        self.shared.setup(|| {
            let mut live = self.process.live.lock().map_err(|_| Error::Revoked)?;
            let result = live.framing.read();
            if result.is_err() {
                live.framing.close();
            }
            result
        })
    }
    pub fn poll_exit(&self) -> Result<Option<Exit>, Error> {
        self.shared.setup(|| {
            let live = self.process.live.lock().map_err(|_| Error::Revoked)?;
            sys::observe_exit(live.child.as_ref().ok_or(Error::PipeClosed)?.id())
        })
    }
    /// Runtime must first validate correlated protocol readiness, native identity,
    /// workspace and sandbox response. Freezes writes before consuming setup grant.
    pub async fn confirm(
        self,
        evidence: NativeSessionConfirmation,
    ) -> Result<ReadyMetadataChild, Error> {
        let grant = {
            let mut state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
            if state.phase != Phase::Setup {
                return Err(Error::Revoked);
            }
            let live = self.process.live.lock().map_err(|_| Error::Revoked)?;
            if !live.framing.queue.is_empty() {
                return Err(Error::Backpressure);
            }
            state.phase = Phase::Confirming;
            state.grant.take().ok_or(Error::Revoked)?
        };
        let result = self
            .shared
            .store
            .confirm_metadata_session(grant, evidence)
            .await;
        match result {
            Ok(transition) => {
                let mut state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
                if state.phase != Phase::Confirming {
                    drop(state);
                    self.shared.quarantine(&self.process);
                    return Err(Error::Revoked);
                }
                state.phase = Phase::Ready;
                drop(state);
                Ok(ReadyMetadataChild {
                    child: self,
                    transition: Some(transition),
                })
            }
            Err(_) => {
                self.shared.quarantine(&self.process);
                Err(Error::Revoked)
            }
        }
    }
}

pub struct ReadyMetadataChild {
    child: MetadataChild,
    transition: Option<ReadySessionTransition>,
}
impl ReadyMetadataChild {
    /// Trusted Runtime prepares its private wrapper and real StoreFence from the
    /// supplied cap only; no I/O or caller frames. Both inputs are consumed once.
    pub(crate) fn attach_and_enqueue<D: ConsumedTurn>(
        mut self,
        cap: Box<ConsumedProviderDispatch>,
        prepare: impl FnOnce(
            Box<ConsumedProviderDispatch>,
        ) -> Result<(D, Arc<dyn DispatchFence>), Error>,
    ) -> Result<(Authority, OwnedChild), TurnFailure> {
        let result = (|| {
            let mut metadata = self.child.shared.state.lock().map_err(|_| Error::Revoked)?;
            if metadata.phase != Phase::Ready {
                return Err(Error::Revoked);
            }
            let transition = self.transition.take().ok_or(Error::Revoked)?;
            if MetadataScope::from_grant(transition.metadata()) != self.child.shared.scope {
                return Err(Error::WrongScope);
            }
            let cap = Box::new(
                transition
                    .attach_execution(*cap)
                    .map_err(|_| Error::WrongScope)?,
            );
            let run = &cap.provider().run;
            let expected = ExecutionScope::new(
                cap.namespace(),
                cap.incarnation_id(),
                &run.owner_id.to_string(),
                &run.session_id.to_string(),
                &run.run_id.to_string(),
                run.dispatch_fence,
            )?;
            let (turn, fence) = prepare(cap)?;
            let lineage = turn.broker_lineage();
            let (scope, frame) = turn.into_submission();
            if scope != expected {
                return Err(Error::WrongScope);
            }
            if frame.len() > self.child.process.max_frame {
                return Err(Error::FrameTooLarge);
            }
            let canonical =
                super::broker_frames::turn(&frame, lineage.as_ref(), &self.child.process)?;
            let shared = Arc::new(Shared {
                scope: scope.clone(),
                fence,
                state: Mutex::new(State {
                    revoked: false,
                    children: BTreeMap::new(),
                    next: 2,
                }),
                active: self.child.shared.active.clone(),
                maximum: 1,
                reaper: self.child.shared.reaper.clone(),
            });
            shared.dispatch(&scope, |execution| {
                let mut live = self.child.process.live.lock().map_err(|_| Error::Revoked)?;
                if !live.framing.queue.is_empty() {
                    return Err(Error::Backpressure);
                }
                live.framing.enqueue(&canonical)?;
                execution
                    .children
                    .insert(1, Arc::downgrade(&self.child.process));
                metadata.process = None;
                metadata.phase = Phase::Transferred;
                Ok(())
            })?;
            Ok((
                Authority {
                    shared: shared.clone(),
                },
                OwnedChild {
                    shared,
                    process: self.child.process.clone(),
                },
            ))
        })();
        if result.is_err() {
            self.child.shared.quarantine(&self.child.process);
        }
        result.map_err(|cause| TurnFailure { cause })
    }
}

mod broker_admission;
mod liveness;
mod retirement;
pub use retirement::{ReapedMetadata, RetiringMetadata};
#[cfg(test)]
mod tests;

#[path = "metadata/claude.rs"]
mod claude;

mod workspace;

mod broker_locator;
pub use broker_locator::BrokerChildLocator;
