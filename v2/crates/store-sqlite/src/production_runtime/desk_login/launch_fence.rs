//! One nonblocking local Root-control frame while Stop is serialized by Core.
use super::*;
impl Store {
    pub fn with_desk_login_launch_fence<E>(
        &self,
        credential: &str,
        operation: &ConsumedDeskLogin,
        action: impl FnOnce() -> std::result::Result<usize, E>,
    ) -> Result<std::result::Result<usize, E>> {
        if operation
            .launch_attempted
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let operation = async {
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            let workspace = self
                .check_binding_before_writer(&operation.parent.binding)
                .await?;
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            let store = &*workspace;
            #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
            let store = self;
            let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
            live(store, &mut tx, credential, &operation.parent).await?;
            let present:i64=sqlx::query_scalar("SELECT count(*) FROM deep_desk_operations WHERE id=? AND context_id=? AND incarnation_id=? AND state='delivery_unknown' AND expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)")
                .bind(operation.id.to_string()).bind(&operation.context).bind(&operation.incarnation).fetch_one(&mut *tx).await.map_err(db)?;
            if present != 1 {
                return Err(RuntimeStoreError::Fenced);
            }
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            store.workspace_effect_once()?;
            let result = action();
            tx.commit().await.map_err(db)?;
            Ok(result)
        };
        match tokio::runtime::Handle::try_current() {
            Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                tokio::task::block_in_place(|| handle.block_on(operation))
            }
            Ok(_) => Err(RuntimeStoreError::Unavailable),
            Err(_) => tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(db)?
                .block_on(operation),
        }
    }
}
