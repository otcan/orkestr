//! Same-operation lease transfer. This value cannot be used for a fresh launch.
use super::*;
pub struct ManagedOperationRenewal {
    operation: ConsumedManagedOperation,
}
impl ManagedOperationRenewal {
    pub fn id(&self) -> Uuid {
        self.operation.id
    }
    pub fn root_request(&self) -> Value {
        self.operation.root_request()
    }
}
impl Store {
    pub async fn renew_managed_operation(
        &self,
        credential: &str,
        operation: &mut ConsumedManagedOperation,
        authority: &RunRenewalAuthority,
    ) -> Result<ManagedOperationRenewal> {
        let next = authority.current_provider();
        let old = &operation.parent;
        if !operation
            .attempted
            .load(std::sync::atomic::Ordering::Acquire)
            || next.run.run_id != old.run.run_id
            || next.binding != old.binding
            || next.run.dispatch_fence != old.run.dispatch_fence
            || next.run.lease_generation != old.run.lease_generation + 1
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let source: ManagedCallerEvidence =
            serde_json::from_value(operation.evidence["source"].clone()).map_err(db)?;
        current(self, &mut tx, credential, next, &source).await?;
        let now = now(&mut tx).await?;
        let expires = (now + 30000)
            .min(next.run.lease_deadline_ms)
            .min(operation.hard_deadline);
        if expires <= now || operation.expires <= now {
            return Err(RuntimeStoreError::Expired);
        }
        let changed=sqlx::query("UPDATE managed_operations SET lease_generation=?,expires_at_ms=? WHERE id=? AND context_id=? AND incarnation_id=? AND lease_generation=? AND expires_at_ms=? AND json_extract(request_json,'$.hard_deadline_ms')=? AND state='delivery_unknown'")
            .bind(i64::try_from(next.run.lease_generation).map_err(db)?).bind(expires).bind(operation.id.to_string())
            .bind(&operation.context).bind(&operation.incarnation).bind(i64::try_from(old.run.lease_generation).map_err(db)?)
            .bind(operation.expires).bind(operation.hard_deadline).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        tx.commit().await.map_err(db)?;
        *operation.parent = next.clone();
        operation.expires = expires;
        Ok(ManagedOperationRenewal {
            operation: ConsumedManagedOperation {
                id: operation.id,
                parent: operation.parent.clone(),
                evidence: operation.evidence.clone(),
                context: operation.context.clone(),
                incarnation: operation.incarnation.clone(),
                expires,
                hard_deadline: operation.hard_deadline,
                source_message_id: operation.source_message_id.clone(),
                source_event_id: operation.source_event_id.clone(),
                attempted: std::sync::atomic::AtomicBool::new(false),
            },
        })
    }
    pub fn with_managed_renewal_fence<E>(
        &self,
        credential: &str,
        renewal: &ManagedOperationRenewal,
        action: impl FnOnce() -> std::result::Result<usize, E>,
    ) -> Result<std::result::Result<usize, E>> {
        self.with_managed_operation_launch_fence(credential, &renewal.operation, action)
    }
}
