//! Fixed Root operation transport. Start emits one nonblocking frame inside
//! Core's live launch fence; connection and response waits stay outside it.
use super::*;
use orkestr_v2_store_sqlite::{ConsumedDeskLogin, DeskLoginOutcome, Store};
pub(crate) struct DeskReceipt {
    state: String,
    pub cleanup: bool,
}
impl DeskReceipt {
    pub(crate) fn outcome(self) -> Result<Option<DeskLoginOutcome>> {
        match (self.state.as_str(), self.cleanup) {
            ("helper_completed", true) => Ok(Some(DeskLoginOutcome::HelperCompleted)),
            ("failed", true) => Ok(Some(DeskLoginOutcome::Failed)),
            ("claimed" | "running", false) => Ok(None),
            _ => Err(ManagerError::Protocol),
        }
    }
}
impl ManagerClient {
    pub(crate) async fn start_desk(
        &self,
        store: &Store,
        credential: &str,
        window: &Window,
        operation: &ConsumedDeskLogin,
        deadline: Instant,
    ) -> Result<DeskReceipt> {
        let mut request = self.request(
            "desk_login",
            &format!("desk:{}", operation.id()),
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
                .with_desk_login_launch_fence(credential, operation, || {
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
            loop {
                stream
                    .readable()
                    .await
                    .map_err(|_| ManagerError::Unavailable)?;
                match stream.try_read(&mut [0]) {
                    Ok(0) => break,
                    Ok(_) => return Err(ManagerError::Protocol),
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                    Err(_) => return Err(ManagerError::Unavailable),
                }
            }
            self.parent()?;
            let value: Value = serde_json::from_slice(&raw).map_err(|_| ManagerError::Protocol)?;
            if canonical(value.clone())? != raw {
                return Err(ManagerError::Protocol);
            }
            self.desk_receipt(value, window, operation)
        })
        .await
        .map_err(|_| ManagerError::Deadline)?
    }
    pub(crate) async fn query_desk(
        &self,
        window: &Window,
        operation: &ConsumedDeskLogin,
        cancel: bool,
        deadline: Instant,
    ) -> Result<DeskReceipt> {
        let mut request = self.request(
            if cancel {
                "desk_login_cancel"
            } else {
                "desk_login_poll"
            },
            &format!("desk:{}", operation.id()),
            Some(window),
        )?;
        request["operation_id"] = json!(operation.id());
        let (value, _) = self.exchange(request, deadline).await?;
        self.desk_receipt(value, window, operation)
    }
    fn desk_receipt(
        &self,
        value: Value,
        window: &Window,
        operation: &ConsumedDeskLogin,
    ) -> Result<DeskReceipt> {
        success_fields(&value, Some("desk_operation"))?;
        self.window_receipt(&value["receipt"], window)?;
        let receipt = &value["desk_operation"];
        let expected = operation.root_request();
        if !fields(
            receipt,
            &[
                "operation_id",
                "run_id",
                "window_id",
                "generation",
                "state",
                "cleanup",
            ],
        ) || receipt["operation_id"] != expected["operation_id"]
            || receipt["run_id"] != expected["run_id"]
            || receipt["window_id"] != window.window_id.to_string()
            || receipt["generation"].as_u64() != Some(window.generation)
        {
            return Err(ManagerError::Protocol);
        }
        let state = receipt["state"]
            .as_str()
            .filter(|s| {
                matches!(
                    *s,
                    "claimed" | "running" | "helper_completed" | "failed" | "cancelled" | "unknown"
                )
            })
            .ok_or(ManagerError::Protocol)?;
        let cleanup = boolean(receipt, "cleanup")?;
        if matches!(state, "claimed" | "running") && cleanup
            || matches!(state, "helper_completed" | "failed" | "cancelled") && !cleanup
        {
            return Err(ManagerError::Protocol);
        }
        Ok(DeskReceipt {
            state: state.into(),
            cleanup,
        })
    }
}
