//! One bounded local Root write, serialized against Stop and durable revocation.
use super::*;
impl Store {
    pub async fn managed_operation_live(
        &self,
        credential: &str,
        operation: &ConsumedManagedOperation,
    ) -> Result<()> {
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let workspace = self
            .check_binding_before_writer(&operation.parent.binding)
            .await?;
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let store = &*workspace;
        #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
        let store = self;
        let mut tx = store.pool.begin().await.map_err(db)?;
        checked(store, &mut tx, credential, operation).await
    }
    pub fn with_managed_operation_launch_fence<E>(
        &self,
        credential: &str,
        operation: &ConsumedManagedOperation,
        action: impl FnOnce() -> std::result::Result<usize, E>,
    ) -> Result<std::result::Result<usize, E>> {
        if operation
            .attempted
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let future = async {
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            let workspace = self
                .check_binding_before_writer(&operation.parent.binding)
                .await?;
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            let store = &*workspace;
            #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
            let store = self;
            let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
            checked(store, &mut tx, credential, operation).await?;
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            store.workspace_effect_once()?;
            let result = action();
            tx.commit().await.map_err(db)?;
            Ok(result)
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
pub(super) async fn checked(
    store: &Store,
    tx: &mut SqliteConnection,
    credential: &str,
    operation: &ConsumedManagedOperation,
) -> Result<()> {
    let source: ManagedCallerEvidence =
        serde_json::from_value(operation.evidence["source"].clone()).map_err(db)?;
    current(store, tx, credential, &operation.parent, &source).await?;
    let c = store.context()?;
    let found:i64=sqlx::query_scalar("SELECT count(*) FROM managed_operations WHERE id=? AND context_id=? AND incarnation_id=? AND state='delivery_unknown' AND expires_at_ms=? AND json_extract(request_json,'$.hard_deadline_ms')=? AND expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)")
        .bind(operation.id.to_string()).bind(&operation.context).bind(&operation.incarnation).bind(operation.expires).bind(operation.hard_deadline)
        .fetch_one(&mut *tx).await.map_err(db)?;
    if found != 1 || c.id != operation.context || c.incarnation != operation.incarnation {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}
