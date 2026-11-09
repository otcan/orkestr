//! Source-bound result delivery over the pinned authority-to-manager channel.
use super::*;
use orkestr_v2_store_sqlite::{ManagedOperationParent, Store};
impl ManagerClient {
    pub(crate) async fn reply_native_worker(
        &self,
        store: &Store,
        credential: &str,
        window: &Window,
        parent: &ManagedOperationParent,
        result: Value,
        deadline: Instant,
    ) -> Result<()> {
        self.native_worker_exchange(
            "managed_worker_reply",
            store,
            credential,
            window,
            parent,
            result,
            deadline,
        )
        .await
    }
    pub(crate) async fn bind_native_worker(
        &self,
        store: &Store,
        credential: &str,
        window: &Window,
        parent: &ManagedOperationParent,
        result: Value,
        deadline: Instant,
    ) -> Result<()> {
        self.native_worker_exchange(
            "managed_worker_bind",
            store,
            credential,
            window,
            parent,
            result,
            deadline,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)] // Same fixed authority envelope as existing managed calls.
    async fn native_worker_exchange(
        &self,
        operation: &str,
        store: &Store,
        credential: &str,
        window: &Window,
        parent: &ManagedOperationParent,
        result: Value,
        deadline: Instant,
    ) -> Result<()> {
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let workspace = tokio::time::timeout_at(
            deadline.into(),
            store.preflight_workspace(&self.owner, &self.conversation),
        )
        .await
        .map_err(|_| ManagerError::Deadline)?
        .map_err(|_| ManagerError::Refused)?;
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let store = &*workspace;
        let id = result["operation_id"]
            .as_str()
            .ok_or(ManagerError::InvalidRequest)?;
        let mut request = self.request(
            operation,
            &format!("native-worker-result:{id}"),
            Some(window),
        )?;
        request["result"] = result.clone();
        let value = self
            .managed_fenced_exchange(request, deadline, |stream, frame| {
                store
                    .with_managed_run_fence(credential, parent, || {
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
        success_fields(&value, Some(operation))?;
        self.window_receipt(&value["receipt"], window)?;
        let observed = &value[operation];
        if !fields(observed, &["operation_id", "run_id", "authorized"])
            || observed["operation_id"] != result["operation_id"]
            || observed["run_id"] != result["run_id"]
            || observed["authorized"] != true
        {
            return Err(ManagerError::Protocol);
        }
        Ok(())
    }
}
