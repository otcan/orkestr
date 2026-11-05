//! Live Root project custody, separate from provider/command dispatch.
use super::*;
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_store_sqlite::{
    RootWorkspaceCustody, WorkspaceDirectoryIdentity, WorkspaceInstallation,
    WorkspaceOperatorAllowlist,
};
use rustix::net::{recvmsg, RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, ReturnFlags};
use std::{
    io::{IoSliceMut, Read},
    mem::MaybeUninit,
    os::fd::OwnedFd,
    os::unix::net::UnixStream as LocalStream,
    sync::Arc,
    time::Duration,
};

const MAX_ATTESTATION: usize = 16384;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    format: String,
    request_id: String,
    owner_id: OwnerId,
    conversation_id: ConversationId,
    project_id: Uuid,
    paths: [PathBuf; 3],
    identities: [(u64, u64, u32); 3],
}

#[derive(Clone)]
struct Custody {
    manager: ManagerClient,
    project: Uuid,
}

impl Custody {
    fn fetch(&self) -> Result<(Snapshot, [OwnedFd; 3])> {
        let operation = || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| ManagerError::Unavailable)?;
            runtime.block_on(self.manager.workspace_snapshot(self.project))
        };
        match tokio::runtime::Handle::try_current() {
            Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                tokio::task::block_in_place(operation)
            }
            Ok(_) => Err(ManagerError::Unavailable),
            Err(_) => operation(),
        }
    }
}

impl RootWorkspaceCustody for Custody {
    fn check(
        &self,
        paths: &[PathBuf; 3],
        identities: [WorkspaceDirectoryIdentity; 3],
    ) -> std::result::Result<(), RuntimeStoreError> {
        let (snapshot, _new_handles) = self.fetch().map_err(|_| RuntimeStoreError::Fenced)?;
        if &snapshot.paths != paths
            || snapshot.identities
                != identities.map(|value| (value.device(), value.inode(), value.uid()))
        {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
}

impl ManagerClient {
    /// Trusted bootstrap only. One closed operator-selected project identity;
    /// paths and directory descriptors come exclusively from the live Root.
    pub(crate) async fn workspace_installation(
        &self,
        project: Uuid,
        allowlist: WorkspaceOperatorAllowlist,
    ) -> Result<WorkspaceInstallation> {
        let custody = Arc::new(Custody {
            manager: self.clone(),
            project,
        });
        tokio::task::spawn_blocking(move || {
            let (snapshot, descriptors) = custody.fetch()?;
            allowlist
                .installation_from_root(snapshot.paths, descriptors, custody)
                .map_err(|_| ManagerError::Refused)
        })
        .await
        .map_err(|_| ManagerError::Unavailable)?
    }

    async fn workspace_snapshot(&self, project: Uuid) -> Result<(Snapshot, [OwnedFd; 3])> {
        if project.is_nil() {
            return Err(ManagerError::InvalidRequest);
        }
        let deadline = Instant::now() + Duration::from_secs(1);
        let request_id = format!("workspace:{}", Uuid::new_v4());
        let mut request = self.request("workspace_attest", &request_id, None)?;
        request["project_id"] = json!(project);
        let (mut receiver, sender) = LocalStream::pair().map_err(|_| ManagerError::Unavailable)?;
        receiver
            .set_read_timeout(Some(Duration::from_millis(100)))
            .map_err(|_| ManagerError::Unavailable)?;
        let handles = [sender.into()];
        let (value, _) = self
            .exchange_with_descriptors(request, deadline, Some(&handles))
            .await?;
        success_fields(&value, Some("workspace"))?;
        self.receipt(&value["receipt"])?;
        let proof = &value["workspace"];
        if !fields(proof, &["project_id", "attestation_sha256"])
            || proof["project_id"] != project.to_string()
        {
            return Err(ManagerError::Protocol);
        }
        let (raw, descriptors) = receive(&mut receiver)?;
        if Instant::now() >= deadline
            || proof["attestation_sha256"] != format!("{:x}", Sha256::digest(&raw))
        {
            return Err(ManagerError::Protocol);
        }
        let snapshot: Snapshot =
            serde_json::from_slice(&raw).map_err(|_| ManagerError::Protocol)?;
        if snapshot.format != "orkestr-root-project-v1"
            || snapshot.request_id != request_id
            || snapshot.owner_id != self.owner
            || snapshot.conversation_id != self.conversation
            || snapshot.project_id != project
            || snapshot.paths.iter().any(|path| {
                !path.is_absolute() || path.to_str().is_none() || path.as_os_str().len() > 4096
            })
        {
            return Err(ManagerError::Protocol);
        }
        Ok((snapshot, descriptors))
    }
}

fn receive(stream: &mut LocalStream) -> Result<(Vec<u8>, [OwnedFd; 3])> {
    let mut header = [0; 4];
    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(3))];
    let mut ancillary = RecvAncillaryBuffer::new(&mut space);
    let received = recvmsg(
        &*stream,
        &mut [IoSliceMut::new(&mut header)],
        &mut ancillary,
        RecvFlags::CMSG_CLOEXEC,
    )
    .map_err(|_| ManagerError::Unavailable)?;
    let mut descriptors = Vec::new();
    for item in ancillary.drain() {
        match item {
            RecvAncillaryMessage::ScmRights(rights) => descriptors.extend(rights),
            _ => return Err(ManagerError::Protocol),
        }
    }
    if received.bytes == 0
        || received.bytes > 4
        || received
            .flags
            .intersects(ReturnFlags::CTRUNC | ReturnFlags::TRUNC)
        || descriptors.len() != 3
    {
        return Err(ManagerError::Protocol);
    }
    stream
        .read_exact(&mut header[received.bytes..])
        .map_err(|_| ManagerError::Protocol)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_ATTESTATION {
        return Err(ManagerError::Protocol);
    }
    let mut raw = vec![0; length];
    stream
        .read_exact(&mut raw)
        .map_err(|_| ManagerError::Protocol)?;
    if stream.read(&mut [0]).map_err(|_| ManagerError::Protocol)? != 0 {
        return Err(ManagerError::Protocol);
    }
    Ok((
        raw,
        descriptors.try_into().map_err(|_| ManagerError::Protocol)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustix::net::{sendmsg, SendAncillaryBuffer, SendAncillaryMessage, SendFlags};
    use std::{fs::File, io::IoSlice, os::fd::AsFd};

    fn packet(count: usize, length: u32, body: &[u8]) -> LocalStream {
        let (sender, receiver) = LocalStream::pair().unwrap();
        let descriptors: Vec<_> = (0..count).map(|_| File::open("/").unwrap()).collect();
        let borrowed: Vec<_> = descriptors.iter().map(AsFd::as_fd).collect();
        let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(5))];
        let mut ancillary = SendAncillaryBuffer::new(&mut space);
        if count > 0 {
            assert!(ancillary.push(SendAncillaryMessage::ScmRights(&borrowed)));
        }
        let mut raw = length.to_be_bytes().to_vec();
        raw.extend(body);
        assert_eq!(
            sendmsg(
                &sender,
                &[IoSlice::new(&raw)],
                &mut ancillary,
                SendFlags::NOSIGNAL
            )
            .unwrap(),
            raw.len()
        );
        sender.shutdown(std::net::Shutdown::Write).unwrap();
        receiver
    }

    #[test]
    fn root_workspace_receive_requires_exact_rights_bound_complete_frame_and_eof() {
        let (raw, descriptors) = receive(&mut packet(3, 2, b"{}")).unwrap();
        assert_eq!(raw, b"{}");
        assert!(descriptors.iter().all(|fd| rustix::io::fcntl_getfd(fd)
            .unwrap()
            .contains(rustix::io::FdFlags::CLOEXEC)));
        for (count, length, body) in [
            (0, 2, &b"{}"[..]),
            (2, 2, b"{}"),
            (4, 2, b"{}"),
            (3, 0, b""),
            (3, 16385, b""),
            (3, 3, b"{}"),
            (3, 1, b"{}"),
        ] {
            assert!(receive(&mut packet(count, length, body)).is_err());
        }
    }
}
