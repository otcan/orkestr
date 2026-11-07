//! Authenticated Root-observed requests; no provider-supplied caller claims.
use super::*;
use orkestr_runtime::store_diagnostics::{observe, Operation};
use orkestr_v2_store_sqlite::{
    CompletedManagedOperation, ConsumedManagedOperation, ManagedCallerEvidence,
    ManagedOperationOutcome, ManagedOperationParent, ManagedOperationRenewal,
    ManagedOperationRequest, Store,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ObservedManagedRequest {
    pub request_id: Uuid,
    pub source: ManagedCallerEvidence,
    pub request: ManagedOperationRequest,
    payload_sha256: String,
    created_at_ms: u64,
    state: String,
}
pub(crate) struct ManagedReceipt {
    pub terminal: Option<ManagedOperationOutcome>,
}
impl ManagerClient {
    pub(crate) async fn release_managed_result(
        &self,
        store: &Store,
        credential: &str,
        window: &Window,
        result: &CompletedManagedOperation,
        deadline: Instant,
    ) -> Result<()> {
        let mut request = self.request(
            "managed_result",
            &format!("managed-result:{}", result.id()),
            Some(window),
        )?;
        request["result"] = result.root_request();
        let value = self
            .managed_fenced_exchange(request, deadline, |stream, frame| {
                store
                    .with_managed_result_fence(credential, result, || {
                        if Instant::now() >= deadline {
                            return Err(ManagerError::Deadline);
                        }
                        self.parent()?;
                        stream
                            .try_write(frame)
                            .map_err(|_| ManagerError::Unavailable)
                    })
                    .map_err(|_| ManagerError::Refused)?
            })
            .await?;
        success_fields(&value, Some("managed_result"))?;
        self.window_receipt(&value["receipt"], window)?;
        let expected = result.root_request();
        let observed = &value["managed_result"];
        if !fields(observed, &["operation_id", "run_id", "authorized"])
            || observed["operation_id"] != expected["operation_id"]
            || observed["run_id"] != expected["run_id"]
            || observed["authorized"] != true
        {
            return Err(ManagerError::Protocol);
        }
        Ok(())
    }
    pub(crate) async fn renew_managed(
        &self,
        store: &Store,
        credential: &str,
        window: &Window,
        operation: &ConsumedManagedOperation,
        renewal: &ManagedOperationRenewal,
        deadline: Instant,
    ) -> Result<ManagedReceipt> {
        let mut request = self.request(
            "managed_renew",
            &format!("managed-renew:{}", renewal.id()),
            Some(window),
        )?;
        request["capability"] = renewal.root_request();
        let value = self
            .managed_fenced_exchange(request, deadline, |stream, frame| {
                store
                    .with_managed_renewal_fence(credential, renewal, || {
                        if Instant::now() >= deadline {
                            return Err(ManagerError::Deadline);
                        }
                        self.parent()?;
                        stream
                            .try_write(frame)
                            .map_err(|_| ManagerError::Unavailable)
                    })
                    .map_err(|_| ManagerError::Refused)?
            })
            .await?;
        self.managed_receipt(value, window, operation)
    }
    pub(crate) async fn open_managed_run(
        &self,
        store: &Store,
        credential: &str,
        window: &Window,
        parent: &ManagedOperationParent,
        deadline: Instant,
    ) -> Result<()> {
        let run = parent.root_run_request();
        let mut request = self.request(
            "managed_run_open",
            &format!(
                "managed-run:{}",
                run["run_id"].as_str().ok_or(ManagerError::Protocol)?
            ),
            Some(window),
        )?;
        request["run"] = run.clone();
        let value = self
            .managed_fenced_exchange(request, deadline, |stream, frame| {
                observe(
                    Operation::ManagedRunFence,
                    None,
                    store.with_managed_run_fence(credential, parent, || {
                        if Instant::now() >= deadline {
                            return Err(ManagerError::Deadline);
                        }
                        self.parent()?;
                        stream
                            .try_write(frame)
                            .map_err(|_| ManagerError::Unavailable)
                    }),
                )
                .map_err(|_| ManagerError::Refused)?
            })
            .await?;
        success_fields(&value, Some("managed_run"))?;
        self.window_receipt(&value["receipt"], window)?;
        if !fields(&value["managed_run"], &["run_id"])
            || value["managed_run"]["run_id"] != run["run_id"]
        {
            return Err(ManagerError::Protocol);
        }
        Ok(())
    }
    pub(crate) async fn close_managed_run(
        &self,
        window: &Window,
        parent: &ManagedOperationParent,
        deadline: Instant,
    ) -> Result<()> {
        let run = parent.root_run_request()["run_id"].clone();
        let mut request = self.request(
            "managed_run_close",
            &format!(
                "managed-close:{}",
                run.as_str().ok_or(ManagerError::Protocol)?
            ),
            Some(window),
        )?;
        request["run_id"] = run.clone();
        let (value, _) = self.exchange(request, deadline).await?;
        success_fields(&value, Some("managed_run"))?;
        self.window_receipt(&value["receipt"], window)?;
        if !fields(&value["managed_run"], &["run_id"]) || value["managed_run"]["run_id"] != run {
            return Err(ManagerError::Protocol);
        }
        Ok(())
    }
    async fn managed_fenced_exchange(
        &self,
        request: Value,
        deadline: Instant,
        write: impl FnOnce(&UnixStream, &[u8]) -> Result<usize>,
    ) -> Result<Value> {
        let raw = canonical(request)?;
        if raw.is_empty() || raw.len() > MAX_FRAME {
            return Err(ManagerError::InvalidRequest);
        }
        let mut frame = (raw.len() as u32).to_be_bytes().to_vec();
        frame.extend(raw);
        tokio::time::timeout_at(deadline.into(), async {
            self.parent()?;
            let stream = UnixStream::connect(&self.socket)
                .await
                .map_err(|_| ManagerError::Unavailable)?;
            let peer = stream.peer_cred().map_err(|_| ManagerError::Peer)?;
            if peer.uid() != 0 || peer.pid() != Some(self.manager_pid as i32) {
                return Err(ManagerError::Peer);
            }
            stream
                .writable()
                .await
                .map_err(|_| ManagerError::Unavailable)?;
            if write(&stream, &frame)? != frame.len() {
                return Err(ManagerError::Protocol);
            }
            let size = u32::from_be_bytes(
                read(&stream, 4)
                    .await?
                    .try_into()
                    .map_err(|_| ManagerError::Protocol)?,
            ) as usize;
            if size == 0 || size > MAX_FRAME {
                return Err(ManagerError::Protocol);
            }
            let raw = read(&stream, size).await?;
            let value: Value = serde_json::from_slice(&raw).map_err(|_| ManagerError::Protocol)?;
            if canonical(value.clone())? != raw {
                return Err(ManagerError::Protocol);
            }
            Ok(value)
        })
        .await
        .map_err(|_| ManagerError::Deadline)?
    }
    pub(crate) async fn pending_managed(
        &self,
        window: &Window,
        deadline: Instant,
    ) -> Result<Option<ObservedManagedRequest>> {
        let request = self.request(
            "managed_pending",
            &format!("managed-poll:{}", Uuid::new_v4()),
            Some(window),
        )?;
        let (value, _) = self.exchange(request, deadline).await?;
        success_fields(&value, Some("managed_pending"))?;
        self.window_receipt(&value["receipt"], window)?;
        let mut requests: Vec<ObservedManagedRequest> =
            serde_json::from_value(value["managed_pending"].clone())
                .map_err(|_| ManagerError::Protocol)?;
        if requests.len() > 1 {
            return Err(ManagerError::Protocol);
        }
        if let Some(request) = requests.first() {
            if request.request_id.is_nil()
                || request.source.window_id != window.window_id
                || request.source.window_generation != window.generation
                || request.source.owner_id != self.owner.to_string()
                || request.source.conversation_id != self.conversation.to_string()
                || request.state != "pending"
                || request.created_at_ms == 0
                || request.created_at_ms >= INTEGER_LIMIT
                || request.payload_sha256.len() != 64
                || !request
                    .payload_sha256
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit())
            {
                return Err(ManagerError::Protocol);
            }
        }
        Ok(requests.pop())
    }
    pub(crate) async fn start_managed(
        &self,
        store: &Store,
        credential: &str,
        window: &Window,
        operation: &ConsumedManagedOperation,
        deadline: Instant,
    ) -> Result<ManagedReceipt> {
        let mut request = self.request(
            "managed_consume",
            &format!("managed:{}", operation.id()),
            Some(window),
        )?;
        request["capability"] = operation.root_request();
        let raw = canonical(request)?;
        if raw.is_empty() || raw.len() > MAX_FRAME {
            return Err(ManagerError::InvalidRequest);
        }
        let mut frame = (raw.len() as u32).to_be_bytes().to_vec();
        frame.extend(raw);
        tokio::time::timeout_at(deadline.into(), async {
            self.parent()?;
            let stream = UnixStream::connect(&self.socket)
                .await
                .map_err(|_| ManagerError::Unavailable)?;
            let peer = stream.peer_cred().map_err(|_| ManagerError::Peer)?;
            if peer.uid() != 0 || peer.pid() != Some(self.manager_pid as i32) {
                return Err(ManagerError::Peer);
            }
            stream
                .writable()
                .await
                .map_err(|_| ManagerError::Unavailable)?;
            let written = store
                .with_managed_operation_launch_fence(credential, operation, || {
                    if Instant::now() >= deadline {
                        return Err(ManagerError::Deadline);
                    }
                    self.parent()?;
                    stream
                        .try_write(&frame)
                        .map_err(|_| ManagerError::Unavailable)
                })
                .map_err(|_| ManagerError::Refused)??;
            if written != frame.len() {
                return Err(ManagerError::Protocol);
            }
            let size = u32::from_be_bytes(
                read(&stream, 4)
                    .await?
                    .try_into()
                    .map_err(|_| ManagerError::Protocol)?,
            ) as usize;
            if size == 0 || size > MAX_FRAME {
                return Err(ManagerError::Protocol);
            }
            let raw = read(&stream, size).await?;
            let value: Value = serde_json::from_slice(&raw).map_err(|_| ManagerError::Protocol)?;
            if canonical(value.clone())? != raw {
                return Err(ManagerError::Protocol);
            }
            self.managed_receipt(value, window, operation)
        })
        .await
        .map_err(|_| ManagerError::Deadline)?
    }
    pub(crate) async fn query_managed(
        &self,
        window: &Window,
        operation: &ConsumedManagedOperation,
        cancel: bool,
        deadline: Instant,
    ) -> Result<ManagedReceipt> {
        let mut request = self.request(
            if cancel {
                "managed_cancel"
            } else {
                "managed_poll"
            },
            &format!("managed:{}", operation.id()),
            Some(window),
        )?;
        request["operation_id"] = json!(operation.id());
        let (value, _) = self.exchange(request, deadline).await?;
        self.managed_receipt(value, window, operation)
    }
    fn managed_receipt(
        &self,
        value: Value,
        window: &Window,
        operation: &ConsumedManagedOperation,
    ) -> Result<ManagedReceipt> {
        success_fields(&value, Some("managed_operation"))?;
        self.window_receipt(&value["receipt"], window)?;
        let r = &value["managed_operation"];
        if !fields(
            r,
            &[
                "operation_id",
                "run_id",
                "window_id",
                "generation",
                "state",
                "result",
            ],
        ) || r["operation_id"] != operation.id().to_string()
            || r["run_id"] != operation.root_request()["run_id"]
            || r["window_id"] != window.window_id.to_string()
            || r["generation"].as_u64() != Some(window.generation)
        {
            return Err(ManagerError::Protocol);
        }
        let terminal = match r["state"].as_str() {
            Some("consumed") => None,
            Some("cancelled") => Some(ManagedOperationOutcome::Cancelled),
            Some("completed") => {
                let result = &r["result"];
                match result["kind"].as_str() {
                    Some("protected_root_intake")
                        if fields(
                            result,
                            &["kind", "request_id", "owner_approval", "owner_delivery"],
                        ) && result["request_id"] == operation.id().to_string()
                            && result["owner_approval"] == false
                            && result["owner_delivery"] == "unconfirmed" =>
                    {
                        Some(ManagedOperationOutcome::Submitted)
                    }
                    Some("desk_helper")
                        if fields(result, &["kind", "state", "cleanup", "website_login"])
                            && result["cleanup"] == true
                            && result["website_login"] == "unconfirmed" =>
                    {
                        Some(match result["state"].as_str() {
                            Some("helper_completed") => ManagedOperationOutcome::HelperCompleted,
                            Some("failed") => ManagedOperationOutcome::Failed,
                            Some("cancelled") => ManagedOperationOutcome::Cancelled,
                            _ => return Err(ManagerError::Protocol),
                        })
                    }
                    _ => return Err(ManagerError::Protocol),
                }
            }
            _ => return Err(ManagerError::Protocol),
        };
        Ok(ManagedReceipt { terminal })
    }
}
