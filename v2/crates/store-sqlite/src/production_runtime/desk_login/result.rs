//! Fixed result from an authenticated Root cleanup receipt, never helper output.
use super::*;
pub enum DeskLoginOutcome {
    HelperCompleted,
    Failed,
}
/// No constructor, Clone or serialization. Core consumes the operation to mint
/// one immutable response after Root's owned anchor proves actual cleanup.
pub struct CompletedDeskLogin {
    operation: ConsumedDeskLogin,
    bytes: Vec<u8>,
    offset: usize,
    poisoned: bool,
}
impl CompletedDeskLogin {
    pub fn parent(&self) -> &ProviderAdmission {
        &self.operation.parent
    }
    pub fn native_call(&self) -> &DeskLoginNativeCall {
        &self.operation.call
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn written_bytes(&self) -> usize {
        self.offset
    }
}
async fn current(
    store: &Store,
    tx: &mut SqliteConnection,
    credential: &str,
    delivery: &CompletedDeskLogin,
) -> Result<()> {
    live(store, tx, credential, &delivery.operation.parent).await?;
    let valid:i64=sqlx::query_scalar("SELECT count(*) FROM deep_desk_results WHERE operation_id=? AND payload_sha256=? AND written_bytes=? AND state='delivery_unknown'")
        .bind(delivery.operation.id.to_string()).bind(crate::digest(std::str::from_utf8(&delivery.bytes).map_err(db)?))
        .bind(delivery.offset as i64).fetch_one(&mut *tx).await.map_err(db)?;
    if valid != 1 {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}
impl Store {
    /// Trusted Root dispatcher only: it must first validate the exact manager
    /// peer, operation/run/window and cleanup receipt. No raw helper text or
    /// caller-supplied response body can enter the native result.
    pub async fn prepare_desk_login_result(
        &self,
        credential: &str,
        operation: ConsumedDeskLogin,
        outcome: DeskLoginOutcome,
    ) -> Result<CompletedDeskLogin> {
        self.desk_login_live(credential, &operation).await?;
        let (state,text,success)=match outcome {
            DeskLoginOutcome::HelperCompleted=>("helper_completed","The approved desk helper finished and its process tree was reaped. This receipt does not assert that the website accepted a login.",true),
            DeskLoginOutcome::Failed=>("failed","The approved desk helper failed and its process tree was reaped.",false),
        };
        let mut bytes=serde_json::to_vec(&json!({"id":operation.call.request_id,"result":{"contentItems":[{"type":"inputText","text":text}],"success":success}})).map_err(db)?;
        bytes.push(b'\n');
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        live(self, &mut tx, credential, &operation.parent).await?;
        let changed=sqlx::query("UPDATE deep_desk_operations SET state=? WHERE id=? AND state='delivery_unknown' AND expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)")
            .bind(state).bind(operation.id.to_string()).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        sqlx::query("INSERT INTO deep_desk_results(operation_id,payload_sha256,state) VALUES(?,?,'delivery_unknown')")
            .bind(operation.id.to_string()).bind(crate::digest(std::str::from_utf8(&bytes).map_err(db)?)).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(CompletedDeskLogin {
            operation,
            bytes,
            offset: 0,
            poisoned: false,
        })
    }
    /// One bounded nonblocking actual native-stdin suffix; no provider wait.
    /// Any uncertain local/commit outcome permanently poisons this capability.
    pub fn with_desk_login_result_fence<E>(
        &self,
        credential: &str,
        delivery: &mut CompletedDeskLogin,
        offset: usize,
        offered: usize,
        action: impl FnOnce() -> std::result::Result<usize, E>,
    ) -> Result<std::result::Result<usize, E>> {
        let invalid = delivery.poisoned
            || delivery.offset != offset
            || offered == 0
            || offered > 16384
            || offset
                .checked_add(offered)
                .is_none_or(|end| end > delivery.bytes.len());
        delivery.poisoned = true;
        if invalid {
            return Err(RuntimeStoreError::Fenced);
        }
        let result = {
            let operation = async {
                let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
                current(self, &mut tx, credential, delivery).await?;
                let result = action();
                if result.as_ref().is_ok_and(|n| *n > offered) {
                    return Err(RuntimeStoreError::Conflict);
                }
                if let Ok(written) = &result {
                    sqlx::query("UPDATE deep_desk_results SET written_bytes=? WHERE operation_id=? AND state='delivery_unknown'")
                        .bind((offset+written) as i64).bind(delivery.operation.id.to_string()).execute(&mut *tx).await.map_err(db)?;
                }
                tx.commit().await.map_err(db)?;
                Ok(result)
            };
            match tokio::runtime::Handle::try_current() {
                Ok(handle)
                    if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread =>
                {
                    tokio::task::block_in_place(|| handle.block_on(operation))
                }
                Ok(_) => Err(RuntimeStoreError::Unavailable),
                Err(_) => tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(db)?
                    .block_on(operation),
            }
        };
        if let Ok(Ok(written)) = &result {
            delivery.offset += written;
            delivery.poisoned = false;
        }
        result
    }
    pub async fn finish_desk_login_result(
        &self,
        credential: &str,
        delivery: CompletedDeskLogin,
    ) -> Result<()> {
        if delivery.poisoned || delivery.offset != delivery.bytes.len() {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        current(self, &mut tx, credential, &delivery).await?;
        sqlx::query("UPDATE deep_desk_results SET state='delivered' WHERE operation_id=? AND state='delivery_unknown'")
            .bind(delivery.operation.id.to_string()).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(())
    }
}
