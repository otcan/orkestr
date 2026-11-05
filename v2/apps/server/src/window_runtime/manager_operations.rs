//! Authenticated Root-observed requests; no provider-supplied caller claims.
use super::*;
use orkestr_v2_store_sqlite::{
    ConsumedManagedOperation, ManagedCallerEvidence, ManagedOperationOutcome,
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
