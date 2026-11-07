//! One fixed result release after authenticated Root cleanup/intake evidence.
use super::*;
pub struct CompletedManagedOperation {
    operation: ConsumedManagedOperation,
    state: &'static str,
    sha: String,
    attempted: std::sync::atomic::AtomicBool,
}
impl CompletedManagedOperation {
    pub fn id(&self) -> Uuid {
        self.operation.id
    }
    pub fn root_request(&self) -> Value {
        json!({"operation_id":self.operation.id,"run_id":self.operation.parent.run.run_id.to_string(),
            "lease_generation":self.operation.parent.run.lease_generation,"dispatch_fence":self.operation.parent.run.dispatch_fence,
            "expires_at_ms":self.operation.expires,"result_sha256":self.sha})
    }
}
impl Store {
    /// Trusted exact Root receipt only. The returned value releases a fixed
    /// result; it cannot launch an operation or mint another input/dispatch.
    pub async fn complete_managed_operation(
        &self,
        credential: &str,
        operation: ConsumedManagedOperation,
        outcome: ManagedOperationOutcome,
    ) -> Result<CompletedManagedOperation> {
        let (state, result) = match outcome {
            ManagedOperationOutcome::Submitted => (
                "submitted",
                json!({"kind":"protected_root_intake",
                "request_id":operation.id.to_string(),"owner_approval":false,"owner_delivery":"unconfirmed"}),
            ),
            ManagedOperationOutcome::HelperCompleted => {
                ("helper_completed", desk("helper_completed"))
            }
            ManagedOperationOutcome::Failed => ("failed", desk("failed")),
            ManagedOperationOutcome::Cancelled => ("cancelled", desk("cancelled")),
        };
        if (state == "submitted"
            && operation.evidence["request"]["operation"] != "root_request_submit")
            || (state != "submitted" && operation.evidence["request"]["operation"] != "desk_login")
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let sha = crate::digest(
            &serde_json::to_string(&json!({"state":"completed","result":result})).map_err(db)?,
        );
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let workspace = self
            .check_binding_before_writer(&operation.parent.binding)
            .await?;
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let store = &*workspace;
        #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
        let store = self;
        let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        launch_fence::checked(store, &mut tx, credential, &operation).await?;
        let changed = sqlx::query(
            "UPDATE managed_operations SET state=? WHERE id=? AND state='delivery_unknown'",
        )
        .bind(state)
        .bind(operation.id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(db)?
        .rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        tx.commit().await.map_err(db)?;
        Ok(CompletedManagedOperation {
            operation,
            state,
            sha,
            attempted: std::sync::atomic::AtomicBool::new(false),
        })
    }
    pub fn with_managed_result_fence<E>(
        &self,
        credential: &str,
        result: &CompletedManagedOperation,
        action: impl FnOnce() -> std::result::Result<usize, E>,
    ) -> Result<std::result::Result<usize, E>> {
        if result
            .attempted
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let future = async {
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            let workspace = self
                .check_binding_before_writer(&result.operation.parent.binding)
                .await?;
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            let store = &*workspace;
            #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
            let store = self;
            let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
            let source: ManagedCallerEvidence =
                serde_json::from_value(result.operation.evidence["source"].clone()).map_err(db)?;
            current(
                store,
                &mut tx,
                credential,
                &result.operation.parent,
                &source,
            )
            .await?;
            let found:i64=sqlx::query_scalar("SELECT count(*) FROM managed_operations WHERE id=? AND context_id=? AND incarnation_id=? AND state=? AND expires_at_ms=? AND expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)")
                .bind(result.operation.id.to_string()).bind(&result.operation.context).bind(&result.operation.incarnation)
                .bind(result.state).bind(result.operation.expires).fetch_one(&mut *tx).await.map_err(db)?;
            if found != 1 {
                return Err(RuntimeStoreError::Fenced);
            }
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            store.workspace_effect_once()?;
            let value = action();
            tx.commit().await.map_err(db)?;
            Ok(value)
        };
        match tokio::runtime::Handle::try_current() {
            Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                tokio::task::block_in_place(|| handle.block_on(future))
            }
            Ok(_) => Err(RuntimeStoreError::Unavailable),
            Err(_) => tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(db)?
                .block_on(future),
        }
    }
}
fn desk(state: &str) -> Value {
    json!({"kind":"desk_helper","state":state,"cleanup":true,"website_login":"unconfirmed"})
}
