//! Trusted owned-broker setup. No run or inference authority is invented here.
mod tool_profile;
mod window;
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
use tool_profile::ToolProfile;

type BeforeOpen<'a> = &'a mut dyn FnMut(&MetadataChild) -> Result<(), SetupFailure>;

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
    actual_fd: bool,
    tool_profile: ToolProfile,
    writing: Option<super::provider_write::PendingWrite>,
}
impl PreparingCodex {
    pub fn open(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
    ) -> Result<Self, SetupFailure> {
        Self::open_retained(store, grant, launcher, workspace, directories, Box::new(()))
    }
    /// Opaque resources are released only after the owned reaper finishes, including setup failures.
    pub fn open_retained(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
    ) -> Result<Self, SetupFailure> {
        Self::open_mode(
            store,
            grant,
            launcher,
            workspace,
            directories,
            true,
            ToolProfile::None,
            resources,
            None,
            None,
        )
    }
    /// Explicit trusted descriptor setup. The Core launch is already consumed;
    /// errors cannot authorize a second child or a fallback pathname launch.
    #[allow(clippy::too_many_arguments)]
    pub fn open_workspace_retained(
        store: Store,
        grant: BoundSessionMetadata,
        credential: &str,
        launch: &mut orkestr_v2_store_sqlite::WorkspaceLaunch,
        launcher: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
    ) -> Result<Self, SetupFailure> {
        Self::open_mode(
            store,
            grant,
            launcher,
            Path::new("/workspace"),
            directories,
            true,
            ToolProfile::None,
            resources,
            Some((credential, launch)),
            None,
        )
    }
    #[cfg(test)]
    pub(super) fn open_legacy(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
    ) -> Result<Self, SetupFailure> {
        Self::open_mode(
            store,
            grant,
            launcher,
            workspace,
            directories,
            false,
            ToolProfile::None,
            Box::new(()),
            None,
            None,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn open_mode(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        workspace: &Path,
        directories: ChildDirectories,
        actual_fd: bool,
        tool_profile: ToolProfile,
        resources: Box<dyn Send + 'static>,
        workspace_launch: Option<(&str, &mut orkestr_v2_store_sqlite::WorkspaceLaunch)>,
        before_open: Option<BeforeOpen<'_>>,
    ) -> Result<Self, SetupFailure> {
        if grant.provider() != ProviderKind::Codex
            || if workspace_launch.is_some() {
                workspace != Path::new("/workspace")
            } else {
                workspace.canonicalize().ok().as_deref() != Some(workspace)
            }
        {
            return Err(Blocker::Protocol.into());
        }
        let binding = grant.binding().clone();
        let launcher = TrustedLauncher::configured(launcher)?;
        let (authority, child) = if let Some((credential, launch)) = workspace_launch {
            launcher.open_workspace_metadata_fd_retained(
                store,
                grant,
                credential,
                launch,
                directories,
                TransportBounds::default(),
                resources,
            )?
        } else if tool_profile.workspace().is_some() {
            launcher.open_workspace_worker_metadata_fd_retained(
                store,
                grant,
                directories,
                TransportBounds::default(),
                resources,
            )?
        } else if tool_profile == ToolProfile::OfflinePython {
            launcher.open_worker_metadata_fd_retained(
                store,
                grant,
                directories,
                TransportBounds::default(),
                resources,
            )?
        } else if actual_fd {
            launcher.open_metadata_fd_retained(
                store,
                grant,
                directories,
                TransportBounds::default(),
                resources,
            )?
        } else {
            launcher.open_metadata(store, grant, directories, TransportBounds::default())?
        };
        if let Some(trusted) = tool_profile.workspace() {
            child.enable_workspace_exec(trusted)?;
        }
        if tool_profile == ToolProfile::OfflinePython {
            child.enable_offline_python()?;
        }
        if let Some(bind) = before_open {
            bind(&child)?;
        }
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
            actual_fd,
            tool_profile,
            writing: None,
        })
    }
    fn queue(&mut self, mut frame: serde_json::Value) -> Result<(), SetupFailure> {
        if let Some(trusted) = self.tool_profile.workspace() {
            crate::broker::workspace_setup::enable(&mut frame, trusted);
        }
        if self.tool_profile == ToolProfile::OfflinePython {
            crate::broker::offline_setup::enable(&mut frame);
        }
        if self.actual_fd {
            self.writing = Some(super::provider_write::PendingWrite::new(&frame)?);
        }
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
        if self.actual_fd {
            if !child.receive_provider_writer()? {
                return Ok(false);
            }
            if let Some(writing) = self.writing.as_mut() {
                if writing.prepared() {
                    let done = writing
                        .write(self.channel.as_mut().ok_or(Blocker::Protocol)?, |bytes| {
                            child.write_provider_metadata(bytes)
                        })?;
                    if done {
                        self.writing = None;
                    } else {
                        return Ok(false);
                    }
                }
            }
        }
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
            let mut channel = handle.into_channel();
            if self.tool_profile == ToolProfile::OfflinePython {
                channel.enable_offline_python()?;
            }
            if let Some(trusted) = self.tool_profile.workspace() {
                channel.enable_workspace_exec(trusted)?;
            }
            if self.actual_fd {
                channel.require_prepared()?;
            }
            self.channel = Some(channel);
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
        if self.actual_fd
            && serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .is_some_and(|v| v["method"] == "BrokerPrepared")
        {
            self.writing
                .as_mut()
                .ok_or(Blocker::Protocol)?
                .prepare(self.channel.as_mut().ok_or(Blocker::Protocol)?)?;
            return Ok(false);
        }
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
                let thread = match self.binding.native_session_id.as_deref() {
                    Some(native) => self.rpc.resume_session(&self.workspace, native)?,
                    None => self.rpc.create_session(&self.workspace)?,
                };
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
            actual_fd: self.actual_fd,
        })
    }
}

pub struct ReadyCodex {
    _metadata_authority: MetadataAuthority,
    child: ReadyMetadataChild,
    channel: BrokerChannel,
    rpc: CodexRpc,
    actual_fd: bool,
}

#[path = "setup_retirement.rs"]
mod setup_retirement;

impl ReadyCodex {
    /// Check only this retained broker while waiting for input. An exit closes
    /// local authority and schedules owned reaping; it never authorizes recovery.
    pub fn check_broker_liveness(&self) -> Result<(), crate::containment::Error> {
        self.child.check_broker_liveness()
    }

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
        let raw = super::turn_frame(&capability, request_id);
        let native_model = self.rpc.reported_model().map(str::to_owned);
        let uses_default_model = raw.pointer("/params/model").is_none();
        let writing = if self.actual_fd {
            Some(
                super::provider_write::PendingWrite::new(&raw)
                    .map_err(SubmissionFailure::Protocol)?,
            )
        } else {
            None
        };
        let envelope = self
            .channel
            .reserve_execution(request_id)
            .map_err(SubmissionFailure::Protocol)?;
        #[cfg(all(test, feature = "fixture-test-controls"))]
        let mut test_fence = None;
        let (authority, child) = self
            .child
            .attach_and_enqueue(capability, |cap| {
                let fence =
                    std::sync::Arc::new(super::fence::StoreFence::from_consumed(store, &cap)?);
                #[cfg(all(test, feature = "fixture-test-controls"))]
                {
                    test_fence = Some(fence.clone());
                }
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
        let pump = super::pump::CodexPump::new(child, scope, provider, stream)
            .with_native_model(native_model, uses_default_model)
            .with_broker(self.channel)
            .with_provider_write(writing);
        #[cfg(all(test, feature = "fixture-test-controls"))]
        let pump = pump.with_test_fence(test_fence.unwrap());
        Ok((authority, pump))
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
