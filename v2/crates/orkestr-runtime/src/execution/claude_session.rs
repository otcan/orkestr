//! First-turn Claude setup on one owned broker child. Launcher selection is trusted
//! server configuration; init metadata does not attest subscription credentials.
use super::session::SetupFailure;
use super::*;
use crate::broker::{
    claude::{ClaudeChannel, ClaudeExecutionEnvelope},
    BrokerOpen,
};
use crate::claude_rpc::{ClaudeObservation, ClaudeRpc};
use crate::containment::{
    broker::TrustedLauncher,
    metadata::{MetadataAuthority, MetadataChild, ReadyMetadataChild},
    ChildDirectories, Output, TransportBounds,
};
use orkestr_v2_application::runtime::{Binding, NativeSessionConfirmation};
use orkestr_v2_store_sqlite::{BoundSessionMetadata, Store};
use std::path::Path;

pub struct PreparingClaude {
    authority: MetadataAuthority,
    child: Option<MetadataChild>,
    binding: Binding,
    open: Option<BrokerOpen>,
    channel: Option<ClaudeChannel>,
    rpc: Option<ClaudeRpc>,
    ready: bool,
    failed: bool,
}
impl PreparingClaude {
    pub fn open(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        directories: ChildDirectories,
    ) -> Result<Self, SetupFailure> {
        Self::open_retained(store, grant, launcher, directories, Box::new(()))
    }
    pub fn open_retained(
        store: Store,
        grant: BoundSessionMetadata,
        launcher: &Path,
        directories: ChildDirectories,
        resources: Box<dyn Send + 'static>,
    ) -> Result<Self, SetupFailure> {
        if grant.provider() != ProviderKind::Claude {
            return Err(Blocker::Protocol.into());
        }
        let binding = grant.binding().clone();
        let (authority, child) = TrustedLauncher::configured(launcher)?.open_metadata_fd_retained(
            store,
            grant,
            directories,
            TransportBounds::default(),
            resources,
        )?;
        let open = child.open_broker_metadata()?;
        Ok(Self {
            authority,
            child: Some(child),
            binding,
            open: Some(open),
            channel: None,
            rpc: None,
            ready: false,
            failed: false,
        })
    }
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
        if self.ready {
            return Ok(true);
        }
        let child = self.child.as_ref().ok_or(Blocker::Protocol)?;
        child.flush_stdin()?;
        if !child.receive_provider_writer()? {
            return Ok(false);
        }
        let bytes = match child.poll_stdout()? {
            Output::Pending => return Ok(false),
            Output::Frame(b) => b,
            Output::Eof => return Err(Blocker::Protocol.into()),
        };
        if let Some(open) = self.open.take() {
            let channel = ClaudeChannel::open(open, &bytes)?;
            self.rpc = Some(ClaudeRpc::new(channel.native(), "turn:2")?);
            self.channel = Some(channel);
        } else {
            let frame = self
                .channel
                .as_mut()
                .ok_or(Blocker::Protocol)?
                .receive(&bytes)?
                .ok_or(Blocker::Protocol)?;
            if self
                .rpc
                .as_mut()
                .ok_or(Blocker::Protocol)?
                .receive("turn:2", &frame.to_string())?
                != Some(ClaudeObservation::Initialized)
            {
                return Err(Blocker::Protocol.into());
            }
            self.ready = true;
        }
        Ok(self.ready)
    }
    pub async fn confirm(mut self) -> Result<ReadyClaude, SetupFailure> {
        if self.failed || !self.ready {
            return Err(Blocker::Protocol.into());
        }
        let channel = self.channel.take().ok_or(Blocker::Protocol)?;
        let evidence = NativeSessionConfirmation {
            session_id: self.binding.session_id.clone(),
            expected_generation: self.binding.generation,
            native_session_id: channel.native().into(),
            protocol_version: "claude-stream-1".into(),
            source_event_key: format!(
                "claude-ready:{}:{}",
                self.binding.session_id, self.binding.generation
            ),
        };
        let child = self
            .child
            .take()
            .ok_or(Blocker::Protocol)?
            .confirm(evidence)
            .await?;
        Ok(ReadyClaude {
            _authority: self.authority,
            child,
            channel,
            rpc: self.rpc.take().ok_or(Blocker::Protocol)?,
        })
    }
}

pub struct ReadyClaude {
    _authority: MetadataAuthority,
    child: ReadyMetadataChild,
    channel: ClaudeChannel,
    rpc: ClaudeRpc,
}
struct ClaudeTurn {
    cap: Box<ConsumedProviderDispatch>,
    scope: ExecutionScope,
    envelope: ClaudeExecutionEnvelope,
}
fn frame(cap: &ConsumedProviderDispatch) -> serde_json::Value {
    json!({"type":"user","session_id":cap.provider().binding.native_session_id,"parent_tool_use_id":null,"message":{"role":"user","content":cap.text()}})
}
impl ConsumedTurn for ClaudeTurn {
    fn broker_lineage(&self) -> Option<std::sync::Arc<()>> {
        Some(self.envelope.lineage())
    }
    fn into_submission(self) -> (ExecutionScope, Vec<u8>) {
        let value = self
            .envelope
            .wrap(&self.cap.message_id().to_string(), frame(&self.cap));
        (self.scope, value.to_string().into_bytes())
    }
}
impl ReadyClaude {
    pub fn attach(
        mut self,
        store: Store,
        cap: Box<ConsumedProviderDispatch>,
    ) -> Result<
        (
            crate::containment::Authority,
            super::claude_pump::ClaudePump,
        ),
        SubmissionFailure,
    > {
        let provider = cap.provider().clone();
        let run = &provider.run;
        let binding = &provider.binding;
        if binding.provider_kind != ProviderKind::Claude
            || run.purpose != AdmissionPurpose::Execution
            || run.owner_id != binding.owner_id
            || run.conversation_id != binding.conversation_id
            || run.session_id != binding.session_id
            || run.role != binding.role
            || run.native_session_id != binding.native_session_id
            || binding.native_session_id.as_deref() != Some(self.channel.native())
        {
            return Err(SubmissionFailure::Protocol(Blocker::Protocol));
        }
        let scope = execution_scope(&cap).map_err(SubmissionFailure::Transport)?;
        let mut bytes = frame(&cap).to_string().into_bytes();
        bytes.push(b'\n');
        if bytes.len() > 65536 {
            return Err(SubmissionFailure::Protocol(Blocker::Protocol));
        }
        let envelope = self
            .channel
            .reserve()
            .map_err(SubmissionFailure::Protocol)?;
        let (authority, child) = self
            .child
            .attach_and_enqueue(cap, |cap| {
                let fence =
                    std::sync::Arc::new(super::fence::StoreFence::from_consumed(store, &cap)?);
                let scope = execution_scope(&cap)?;
                Ok((
                    ClaudeTurn {
                        cap,
                        scope,
                        envelope,
                    },
                    fence as std::sync::Arc<dyn crate::containment::DispatchFence>,
                ))
            })
            .map_err(|e| SubmissionFailure::Transport(e.cause))?;
        Ok((
            authority,
            super::claude_pump::ClaudePump::new(
                child,
                scope,
                provider,
                self.channel,
                self.rpc,
                bytes,
            ),
        ))
    }
}
