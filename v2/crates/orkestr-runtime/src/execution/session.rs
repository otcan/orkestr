//! Trusted owned-broker setup. No run or inference authority is invented here.
use super::*;
use crate::broker::{channel::BrokerChannel, BrokerOpen};
use crate::containment::{
    broker::TrustedLauncher,
    metadata::{MetadataAuthority, MetadataChild, ReadyMetadataChild},
    ChildDirectories, Output, TransportBounds,
};
use orkestr_v2_application::runtime::{Binding, NativeSessionConfirmation};
use orkestr_v2_store_sqlite::{BoundSessionMetadata, Store};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum SetupFailure {
    Protocol(Blocker),
    Transport(crate::containment::Error),
}
impl From<Blocker> for SetupFailure {
    fn from(value: Blocker) -> Self {
        Self::Protocol(value)
    }
}
impl From<crate::containment::Error> for SetupFailure {
    fn from(value: crate::containment::Error) -> Self {
        Self::Transport(value)
    }
}
#[derive(Clone, Copy)]
enum Phase {
    Open,
    Initialize,
    Initialized,
    Account,
    Thread,
    Ready,
}

/// One Core Starting grant owns one child and one closed setup state machine.
/// The caller supplies trusted installation/workspace configuration only.
pub struct PreparingCodex {
    authority: MetadataAuthority,
    child: Option<MetadataChild>,
    binding: Binding,
    workspace: PathBuf,
    open: Option<BrokerOpen>,
    channel: Option<BrokerChannel>,
    rpc: CodexRpc,
    phase: Phase,
    failed: bool,
}
impl PreparingCodex {
    pub fn open(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
    ) -> Result<Self, SetupFailure> {
        if grant.provider() != ProviderKind::Codex
            || workspace.canonicalize().ok().as_deref() != Some(workspace)
        {
            return Err(Blocker::Protocol.into());
        }
        let binding = grant.binding().clone();
        let (authority, child) = TrustedLauncher::configured(launcher)?.open_metadata(
            store,
            grant,
            directories,
            TransportBounds::default(),
        )?;
        let open = child.open_broker_metadata()?;
        Ok(Self {
            authority,
            child: Some(child),
            binding,
            workspace: workspace.into(),
            open: Some(open),
            channel: None,
            rpc: CodexRpc::default(),
            phase: Phase::Open,
            failed: false,
        })
    }
    fn queue(&mut self, frame: serde_json::Value) -> Result<(), SetupFailure> {
        let request = self
            .channel
            .as_mut()
            .ok_or(Blocker::Protocol)?
            .metadata(frame)?;
        self.child
            .as_ref()
            .ok_or(Blocker::Protocol)?
            .enqueue_broker_metadata(request)?;
        Ok(())
    }
    /// Bounded nonblocking setup progress; errors quarantine without replay.
    pub fn poll(&mut self) -> Result<bool, SetupFailure> {
        if self.failed {
            return Err(Blocker::Protocol.into());
        }
        let result = self.poll_inner();
        if result.is_err() {
            self.failed = true;
            let _ = self.authority.revoke();
        }
        result
    }
    fn poll_inner(&mut self) -> Result<bool, SetupFailure> {
        if matches!(self.phase, Phase::Ready) {
            return Ok(true);
        }
        let child = self.child.as_ref().ok_or(Blocker::Protocol)?;
        child.flush_stdin()?;
        let bytes = match child.poll_stdout()? {
            Output::Pending => return Ok(false),
            Output::Frame(bytes) => bytes,
            Output::Eof => return Err(Blocker::Protocol.into()),
        };
        if matches!(self.phase, Phase::Open) {
            let handle = self
                .open
                .as_mut()
                .ok_or(Blocker::Protocol)?
                .receive(&bytes)?;
            self.open = None;
            self.channel = Some(handle.into_channel());
            let initialize = self.rpc.initialize()?;
            self.queue(initialize)?;
            self.phase = Phase::Initialize;
            return Ok(false);
        }
        let response = self
            .channel
            .as_mut()
            .ok_or(Blocker::Protocol)?
            .receive(&bytes)?;
        match self.phase {
            Phase::Initialize => {
                let frame = response.ok_or(Blocker::Protocol)?;
                let initialized = self
                    .rpc
                    .receive(&frame.to_string())?
                    .ok_or(Blocker::Protocol)?;
                self.queue(initialized)?;
                self.phase = Phase::Initialized;
            }
            Phase::Initialized => {
                if response.is_some() {
                    return Err(Blocker::Protocol.into());
                }
                let account = self.rpc.account_read()?;
                self.queue(account)?;
                self.phase = Phase::Account;
            }
            Phase::Account => {
                let frame = response.ok_or(Blocker::Protocol)?;
                self.rpc.receive(&frame.to_string())?;
                let thread = self.rpc.create_session(&self.workspace)?;
                self.queue(thread)?;
                self.phase = Phase::Thread;
            }
            Phase::Thread => {
                let frame = response.ok_or(Blocker::Protocol)?;
                self.rpc.receive(&frame.to_string())?;
                if self.rpc.native_session().is_none() {
                    return Err(Blocker::Protocol.into());
                }
                self.phase = Phase::Ready;
            }
            _ => return Err(Blocker::Protocol.into()),
        }
        Ok(matches!(self.phase, Phase::Ready))
    }
    /// Only complete validated persistence/workspace/subscription setup reaches
    /// Core confirmation. Core checks its original grant again atomically.
    pub async fn confirm(mut self) -> Result<ReadyCodex, SetupFailure> {
        if self.failed || !matches!(self.phase, Phase::Ready) {
            return Err(Blocker::Protocol.into());
        }
        let evidence = NativeSessionConfirmation {
            session_id: self.binding.session_id.clone(),
            expected_generation: self.binding.generation,
            native_session_id: self.rpc.native_session().ok_or(Blocker::Protocol)?.into(),
            protocol_version: "codex-rpc-1".into(),
            source_event_key: format!(
                "broker-ready:{}:{}",
                self.binding.session_id, self.binding.generation
            ),
        };
        let child = self
            .child
            .take()
            .ok_or(Blocker::Protocol)?
            .confirm(evidence)
            .await?;
        Ok(ReadyCodex {
            _metadata_authority: self.authority,
            child,
            channel: self.channel.take().ok_or(Blocker::Protocol)?,
            rpc: self.rpc,
        })
    }
}

pub struct ReadyCodex {
    _metadata_authority: MetadataAuthority,
    child: ReadyMetadataChild,
    channel: BrokerChannel,
    rpc: CodexRpc,
}

impl ReadyCodex {
    /// Consume Core's single-use capability while transferring the very same
    /// metadata child. Failure cannot return or recreate the capability.
    pub fn attach(
        mut self,
        store: Store,
        capability: Box<ConsumedProviderDispatch>,
    ) -> Result<(crate::containment::Authority, super::pump::CodexPump), SubmissionFailure> {
        let provider = capability.provider().clone();
        let native = provider
            .binding
            .native_session_id
            .as_deref()
            .ok_or(SubmissionFailure::Protocol(Blocker::UnknownSession))?;
        if provider.binding.provider_kind != ProviderKind::Codex
            || provider.run.purpose != AdmissionPurpose::Execution
            || provider.run.owner_id != provider.binding.owner_id
            || provider.run.conversation_id != provider.binding.conversation_id
            || provider.run.session_id != provider.binding.session_id
            || provider.run.role != provider.binding.role
            || provider.run.native_session_id != provider.binding.native_session_id
        {
            return Err(SubmissionFailure::Protocol(Blocker::Protocol));
        }
        let scope = execution_scope(&capability).map_err(SubmissionFailure::Transport)?;
        let request_id = self
            .rpc
            .claim_turn_request(native)
            .map_err(SubmissionFailure::Protocol)?;
        let stream = crate::codex_rpc::TurnStream::new(native, request_id)
            .map_err(SubmissionFailure::Protocol)?;
        let envelope = self
            .channel
            .reserve_execution(request_id)
            .map_err(SubmissionFailure::Protocol)?;
        let (authority, child) = self
            .child
            .attach_and_enqueue(capability, |cap| {
                let fence =
                    std::sync::Arc::new(super::fence::StoreFence::from_consumed(store, &cap)?);
                let scope = execution_scope(&cap)?;
                Ok((
                    CodexTurn {
                        capability: cap,
                        scope,
                        request_id,
                        broker: Some(envelope),
                    },
                    fence as std::sync::Arc<dyn crate::containment::DispatchFence>,
                ))
            })
            .map_err(|failure| SubmissionFailure::Transport(failure.cause))?;
        Ok((
            authority,
            super::pump::CodexPump::new(child, scope, provider, stream).with_broker(self.channel),
        ))
    }
}

impl std::fmt::Display for SetupFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Protocol(error) => write!(f, "protocol refusal: {error:?}"),
            Self::Transport(error) => write!(f, "transport refusal: {error:?}"),
        }
    }
}
