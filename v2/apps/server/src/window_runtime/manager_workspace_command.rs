//! Inert Root preparation followed by an exact Core-fenced activation socket.
//! A queued manager request cannot start business work after the Store fence.
use super::*;
use orkestr_v2_store_sqlite::{ConsumedWorkspaceExec, Store};
use std::{
    fs::File,
    io::{Read, Write},
    os::{fd::OwnedFd, unix::net::UnixStream as LocalStream},
    time::Duration,
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RootCommandReceipt {
    pub operation_id: Uuid,
    pub source_sha256: String,
    pub kind: String,
    pub state: String,
    pub cleanup: bool,
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    pub cancellation: Option<String>,
}

pub(crate) struct RootCommand {
    activation: LocalStream,
    pub stdout: File,
    pub stderr: File,
}

impl RootCommand {
    /// No positive byte reaches Root before the actual consumed Store fence.
    /// Once sent, the synchronous ACK/EOF wait deliberately has no timeout:
    /// releasing the fence while a delayed spawn remains possible is unsafe.
    /// The Root anchor itself has a bounded deadline and closes after cleanup.
    pub(crate) fn activate(
        &mut self,
        manager: &ManagerClient,
        store: &Store,
        credential: &str,
        cap: &ConsumedWorkspaceExec,
    ) -> Result<()> {
        store
            .with_workspace_exec_fence(credential, cap, |_| {
                manager.parent()?;
                activate(&mut self.activation)
            })
            .map_err(|_| ManagerError::Refused)?
    }

    /// Negative-only cancellation. A dropped handle closes the same private
    /// socket; Root cancels and proves physical cleanup independently.
    pub(crate) fn cancel(&mut self) {
        let _ = self.activation.write_all(b"cancel");
    }
}

fn activate(socket: &mut LocalStream) -> Result<()> {
    socket
        .write_all(b"activate\n")
        .map_err(|_| ManagerError::Unavailable)?;
    let mut ack = [0; 8];
    socket
        .read_exact(&mut ack)
        .map_err(|_| ManagerError::Unavailable)?;
    if &ack != b"started\n" {
        return Err(ManagerError::Protocol);
    }
    Ok(())
}

fn source(cap: &ConsumedWorkspaceExec) -> Result<OwnedFd> {
    use rustix::fs::{fcntl_add_seals, memfd_create, MemfdFlags, SealFlags};
    if cap.source().is_empty()
        || cap.source().len() > 65536
        || cap.source_digest() != format!("{:x}", Sha256::digest(cap.source().as_bytes()))
    {
        return Err(ManagerError::InvalidRequest);
    }
    let fd = memfd_create(
        c"orkestr-consumed-workspace-source",
        MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING,
    )
    .map_err(|_| ManagerError::Unavailable)?;
    let mut file = File::from(fd);
    file.write_all(cap.source().as_bytes())
        .map_err(|_| ManagerError::Unavailable)?;
    fcntl_add_seals(
        &file,
        SealFlags::SEAL | SealFlags::SHRINK | SealFlags::GROW | SealFlags::WRITE,
    )
    .map_err(|_| ManagerError::Unavailable)?;
    Ok(file.into())
}

impl ManagerClient {
    /// Inert preparation only. No source strings, paths or environment appear
    /// in this RPC: the exact source crosses as an immutable consumed memfd.
    pub(crate) async fn prepare_workspace_command(
        &self,
        window: &Window,
        cap: &ConsumedWorkspaceExec,
    ) -> Result<RootCommand> {
        let parent = cap.parent();
        if parent.run.owner_id != self.owner || parent.run.conversation_id != self.conversation {
            return Err(ManagerError::InvalidRequest);
        }
        let mut request = self.request(
            "workspace_command",
            &format!("workspace-command:{}", cap.id()),
            Some(window),
        )?;
        request["capability"] = json!({
            "operation_id":cap.id(), "project_id":cap.project_id(),
            "project_generation":cap.project_generation(), "run_id":parent.run.run_id,
            "session_id":parent.run.session_id, "binding_generation":parent.binding.generation,
            "lease_generation":parent.run.lease_generation, "dispatch_fence":parent.run.dispatch_fence,
            "context_id":cap.context_id(), "incarnation":cap.incarnation(),
            "source_sha256":cap.source_digest(), "expires_at_ms":cap.expires_at_ms()
        });
        let (stdout, out) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC)
            .map_err(|_| ManagerError::Unavailable)?;
        let (stderr, err) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC)
            .map_err(|_| ManagerError::Unavailable)?;
        let (activation, endpoint) = LocalStream::pair().map_err(|_| ManagerError::Unavailable)?;
        let handles = [source(cap)?, out, err, endpoint.into()];
        let (value, _) = self
            .exchange_with_descriptors(
                request,
                Instant::now() + Duration::from_secs(1),
                Some(&handles),
            )
            .await?;
        let receipt = self.workspace_command_receipt(value, window, cap)?;
        if receipt.state != "prepared" || receipt.cleanup || receipt.exit_code.is_some() {
            return Err(ManagerError::Refused);
        }
        Ok(RootCommand {
            activation,
            stdout: stdout.into(),
            stderr: stderr.into(),
        })
    }

    pub(crate) async fn query_workspace_command(
        &self,
        window: &Window,
        cap: &ConsumedWorkspaceExec,
        cancel: bool,
    ) -> Result<RootCommandReceipt> {
        let mut request = self.request(
            if cancel {
                "workspace_command_cancel"
            } else {
                "workspace_command_receipt"
            },
            &format!("workspace-command:{}", cap.id()),
            Some(window),
        )?;
        request["operation_id"] = json!(cap.id());
        request["source_sha256"] = json!(cap.source_digest());
        let (value, _) = self
            .exchange(request, Instant::now() + Duration::from_secs(1))
            .await?;
        self.workspace_command_receipt(value, window, cap)
    }

    fn workspace_command_receipt(
        &self,
        value: Value,
        window: &Window,
        cap: &ConsumedWorkspaceExec,
    ) -> Result<RootCommandReceipt> {
        success_fields(&value, Some("command"))?;
        self.window_receipt(&value["receipt"], window)?;
        let receipt: RootCommandReceipt =
            serde_json::from_value(value["command"].clone()).map_err(|_| ManagerError::Protocol)?;
        if receipt.operation_id != cap.id()
            || receipt.source_sha256 != cap.source_digest()
            || !matches!(
                receipt.kind.as_str(),
                "command" | "start" | "status" | "wait" | "cancel"
            )
            || !matches!(
                receipt.state.as_str(),
                "claimed"
                    | "prepared"
                    | "running"
                    | "complete"
                    | "failed"
                    | "cancelled"
                    | "unknown"
            )
            || receipt
                .exit_code
                .is_some_and(|code| !(-64..=255).contains(&code))
            || receipt.cancellation.as_deref().is_some_and(|reason| {
                !matches!(
                    reason,
                    "signal"
                        | "parent_lost"
                        | "deadline"
                        | "cancelled"
                        | "parent_closed"
                        | "invalid_control"
                        | "core_lost"
                        | "core_closed"
                )
            })
            || (receipt.cancelled != receipt.cancellation.is_some())
            || (receipt.cleanup
                && matches!(receipt.state.as_str(), "claimed" | "prepared" | "running"))
        {
            return Err(ManagerError::Protocol);
        }
        Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_waits_for_exact_spawn_ack_and_never_accepts_partial_or_negative_ack() {
        for reply in [b"started\n".as_slice(), b"started", b"prepared", b""] {
            let (mut core, mut anchor) = LocalStream::pair().unwrap();
            let expected = reply.to_vec();
            let worker = std::thread::spawn(move || {
                let mut command = [0; 9];
                anchor.read_exact(&mut command).unwrap();
                assert_eq!(&command, b"activate\n");
                anchor.write_all(&expected).unwrap();
            });
            assert_eq!(activate(&mut core).is_ok(), reply == b"started\n");
            worker.join().unwrap();
        }
    }
}
