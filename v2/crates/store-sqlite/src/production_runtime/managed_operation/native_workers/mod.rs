//! Native task data enters through a current Root-observed primary, never browser auth.
use super::*;
use orkestr_v2_contracts::{TaskId, WorkerTaskCreateRequest};
mod presentation;

/// Trusted composition facts; neither provider JSON nor role text can create one.
pub struct NativeWorkerAvailability {
    pub configured: bool,
    pub scheduler_available: bool,
    pub execution_budget_ms: Option<u32>,
}
/// A bounded observation handle, not a dispatch or renewable execution grant.
pub struct NativeWorkerCall {
    id: Uuid,
    source: ManagedCallerEvidence,
    request: Value,
    task: Option<TaskId>,
    immediate: Option<Value>,
    wait: bool,
}
pub struct NativeWorkerObservation {
    result: Value,
    terminal: bool,
}
impl NativeWorkerObservation {
    pub fn terminal(&self) -> bool {
        self.terminal
    }
}
impl NativeWorkerCall {
    pub fn waits(&self) -> bool {
        self.wait && self.immediate.is_none()
    }
    pub fn root_binding(&self, parent: &ManagedOperationParent) -> Value {
        let mut value = self.root_reply(
            &NativeWorkerObservation {
                result: Value::Null,
                terminal: false,
            },
            parent,
        );
        value
            .as_object_mut()
            .expect("fixed reply object")
            .remove("result");
        value["task_id"] = json!(self.task);
        value
    }
    pub fn root_reply(
        &self,
        result: &NativeWorkerObservation,
        parent: &ManagedOperationParent,
    ) -> Value {
        json!({"operation_id":self.id,"run_id":parent.parent.run.run_id.to_string(),
            "source":self.source,"request_sha256":crate::digest(&serde_json::to_string(&self.request).expect("stored JSON value")),
            "expires_at_ms":parent.parent.run.lease_deadline_ms,"result":result.result})
    }
}
impl ManagedOperationRequest {
    pub fn is_native_worker(&self) -> bool {
        matches!(
            self.operation.as_str(),
            "worker_capability" | "worker_submit" | "worker_status" | "worker_wait"
        )
    }
    fn native_bounded(&self) -> bool {
        if self.version != 1
            || !valid(&self.request_key)
            || serde_json::to_vec(&self.arguments).map_or(true, |v| v.len() > 4096)
        {
            return false;
        }
        let Some(a) = self.arguments.as_object() else {
            return false;
        };
        match self.operation.as_str() {
            "worker_capability" => a.is_empty(),
            "worker_submit" => {
                a.len() == 2
                    && a.get("title").and_then(Value::as_str).is_some_and(|s| {
                        !s.trim().is_empty() && s.len() <= 160 && !s.chars().any(char::is_control)
                    })
                    && a.get("instructions")
                        .and_then(Value::as_str)
                        .is_some_and(|s| {
                            !s.trim().is_empty() && s.len() <= 4096 && !s.contains('\0')
                        })
            }
            "worker_status" | "worker_wait" => {
                a.len() == 1
                    && a.get("task_id")
                        .and_then(Value::as_str)
                        .and_then(|s| Uuid::parse_str(s).ok())
                        .is_some_and(|v| !v.is_nil())
            }
            _ => false,
        }
    }
}
impl Store {
    /// The current writer and Native source are checked before fresh intent AND replay.
    /// A create receipt and its Root operation key share the existing atomic task row.
    pub async fn begin_native_worker_call(
        &self,
        credential: &str,
        parent: &ManagedOperationParent,
        id: Uuid,
        source: &ManagedCallerEvidence,
        request: &ManagedOperationRequest,
        availability: NativeWorkerAvailability,
    ) -> Result<NativeWorkerCall> {
        if availability
            .execution_budget_ms
            .is_some_and(|ms| !(30_000..=3_600_000).contains(&ms))
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        if id.is_nil() || !request.native_bounded() || !parent.matches_source(source) {
            return Err(RuntimeStoreError::Fenced);
        }
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let workspace = self
            .check_binding_before_writer(&parent.parent.binding)
            .await?;
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let store = &*workspace;
        #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
        let store = self;
        let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        current(store, &mut tx, credential, &parent.parent, source).await?;
        let capability = store
            .native_worker_capability(&mut tx, parent, &availability)
            .await?;
        let mut call = NativeWorkerCall {
            id,
            source: source.clone(),
            request: serde_json::to_value(request).map_err(db)?,
            task: None,
            immediate: None,
            wait: availability.scheduler_available
                && matches!(request.operation.as_str(), "worker_submit" | "worker_wait"),
        };
        if request.operation == "worker_capability" || parent.setup.provider != ProviderKind::Codex
        {
            call.immediate = Some(capability);
        } else if request.operation == "worker_submit" {
            let key = format!("native-worker:{id}");
            let previous: Option<i64> = sqlx::query_scalar("SELECT parent_control_revision FROM worker_tasks WHERE owner_id=? AND parent_run_id=? AND request_key=?")
                .bind(source.owner_id.as_str()).bind(&source.run_id).bind(&key).fetch_optional(&mut *tx).await.map_err(db)?;
            if previous.is_none() && capability["state"] != "ready" {
                call.immediate = Some(capability);
            } else {
                let revision = match previous {
                    Some(v) => v,
                    None => sqlx::query_scalar(
                        "SELECT revision FROM production_control_revisions WHERE run_id=?",
                    )
                    .bind(&source.run_id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(db)?,
                };
                let data = WorkerTaskCreateRequest {
                    parent_run_id: parent.parent.run.run_id.clone(),
                    expected_control_revision: revision,
                    request_key: key,
                    title: request.arguments["title"]
                        .as_str()
                        .ok_or(RuntimeStoreError::InvalidInput)?
                        .into(),
                    instructions: request.arguments["instructions"]
                        .as_str()
                        .ok_or(RuntimeStoreError::InvalidInput)?
                        .into(),
                    lifetime_ms: 30_000,
                    execution_budget_ms: availability.execution_budget_ms,
                };
                let receipt = store
                    .create_worker_task_in(
                        &mut tx,
                        &parent.parent.run.conversation_id,
                        &data,
                        availability.scheduler_available,
                    )
                    .await?;
                call.task = Some(receipt.task_id);
            }
        } else {
            call.task = Some(TaskId(
                request.arguments["task_id"]
                    .as_str()
                    .and_then(|s| Uuid::parse_str(s).ok())
                    .ok_or(RuntimeStoreError::InvalidInput)?,
            ));
            // Validate the exact task scope before returning even a pending handle.
            store
                .native_worker_task(
                    &mut tx,
                    parent,
                    call.task.as_ref().ok_or(RuntimeStoreError::InvalidInput)?,
                )
                .await?;
        }
        tx.commit().await.map_err(db)?;
        Ok(call)
    }
    /// One tick reads one bounded snapshot. It never waits for a child or borrows a scheduler.
    pub async fn observe_native_worker_call(
        &self,
        credential: &str,
        parent: &ManagedOperationParent,
        call: &NativeWorkerCall,
    ) -> Result<NativeWorkerObservation> {
        if !parent.matches_source(&call.source) {
            return Err(RuntimeStoreError::Fenced);
        }
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let workspace = self
            .check_binding_before_writer(&parent.parent.binding)
            .await?;
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let store = &*workspace;
        #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
        let store = self;
        let mut tx = store.pool.begin().await.map_err(db)?;
        current(store, &mut tx, credential, &parent.parent, &call.source).await?;
        let result = match (&call.immediate, &call.task) {
            (Some(value), _) => NativeWorkerObservation {
                result: value.clone(),
                terminal: true,
            },
            (None, Some(task)) => store.native_worker_task(&mut tx, parent, task).await?,
            _ => return Err(RuntimeStoreError::InvalidInput),
        };
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
    async fn native_worker_capability(
        &self,
        tx: &mut SqliteConnection,
        parent: &ManagedOperationParent,
        availability: &NativeWorkerAvailability,
    ) -> Result<Value> {
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM worker_tasks WHERE parent_run_id=?")
                .bind(parent.parent.run.run_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        let eligible = current_authority(
            self.worker_parent_current_in(&mut *tx, &parent.parent.run.run_id)
                .await,
        )?;
        let state = if parent.setup.provider != ProviderKind::Codex {
            "not_supported"
        } else if !availability.configured {
            "setup_required"
        } else if !availability.scheduler_available {
            "unhealthy"
        } else if count >= 32 || !eligible {
            "denied"
        } else {
            "ready"
        };
        Ok(
            json!({"kind":"native_worker_capability","state":state,"provider":provider_name(parent.setup.provider)?,
            "max_active":4,"max_tasks":32,"tasks_created":count,"initial_lifetime_ms":30000,
            "extended_budget":availability.execution_budget_ms.is_some(),
            "execution_budget_ms":availability.execution_budget_ms,"queued_is_running":false}),
        )
    }
}
fn current_authority<T>(value: Result<T>) -> Result<bool> {
    match value {
        Ok(_) => Ok(true),
        Err(
            RuntimeStoreError::Unauthorized
            | RuntimeStoreError::Fenced
            | RuntimeStoreError::StaleLease
            | RuntimeStoreError::Expired
            | RuntimeStoreError::NotFound,
        ) => Ok(false),
        Err(error) => Err(error),
    }
}
#[cfg(test)]
mod tests;
