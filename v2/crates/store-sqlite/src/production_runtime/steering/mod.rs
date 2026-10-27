//! Text-only Codex steering: no inference reissue, no task-to-steer conversion.
use super::*;
use crate::runtime::ledger::{hash, secret};
use orkestr_v2_contracts::{
    ConversationId, EventId, ExecutionSteeringReceipt, ExecutionSteeringRequest, MessageId,
    MessageInput, SteeringDisposition,
};
mod admission;
mod delivery;
mod refresh;
mod types;
pub use types::*;
#[cfg(test)]
mod tests;

async fn browser(conn: &mut SqliteConnection, credential: &str, owner: &OwnerId) -> Result<()> {
    if credential.is_empty() || credential.len() > 1024 {
        return Err(RuntimeStoreError::Unauthorized);
    }
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
        .bind(crate::digest(credential)).bind(owner.to_string()).fetch_one(conn).await.map_err(db)?;
    if count != 1 {
        return Err(RuntimeStoreError::Unauthorized);
    }
    Ok(())
}
async fn current(
    store: &Store,
    conn: &mut SqliteConnection,
    authority: &CodexSteeringAuthority,
) -> Result<()> {
    let c = store.context()?;
    if c.provider != ProviderKind::Codex
        || c.id != authority.context
        || c.incarnation != authority.incarnation
    {
        return Err(RuntimeStoreError::Fenced);
    }
    let row = store
        .production_authorized_run(conn, &authority.provider)
        .await?;
    if authority.provider.run.role != Role::Deep
        || authority.provider.run.purpose != AdmissionPurpose::Execution
        || row.get::<&str, _>("state") != "running"
        || row.get::<&str, _>("dispatch_state") != "delivery_unknown"
    {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}
impl Store {
    /// Capture before Runtime moves the genuine inference cap. No dispatch right.
    pub async fn authorize_codex_steering(
        &self,
        cap: &ConsumedProviderDispatch,
    ) -> Result<CodexSteeringAuthority> {
        let c = self.context()?;
        if c.provider != ProviderKind::Codex || cap.provider().run.role != Role::Deep {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let row = self
            .production_authorized_run(&mut tx, cap.provider())
            .await?;
        if row.get::<&str, _>("dispatch_state") != "delivery_unknown"
            || cap.provider().run.purpose != AdmissionPurpose::Execution
        {
            return Err(RuntimeStoreError::Fenced);
        }
        // Owner messages steer only the canonical lineage, never a read-only
        // parallel turn.
        if super::parallel_deep::is_slot(&mut tx, &cap.provider().run.session_id.to_string())
            .await?
        {
            return Err(RuntimeStoreError::Fenced);
        }
        tx.commit().await.map_err(db)?;
        Ok(CodexSteeringAuthority {
            provider: cap.provider().clone(),
            context: c.id.clone(),
            incarnation: c.incarnation.clone(),
        })
    }
    /// Trusted actual correlated turn/started evidence only; browser IDs cannot
    /// call this without the original private issuer. A different turn conflicts.
    pub async fn bind_codex_steering_turn(
        &self,
        authority: &CodexSteeringAuthority,
        native_turn_id: &str,
    ) -> Result<()> {
        if !valid(native_turn_id) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        current(self, &mut tx, authority).await?;
        let prior: Option<String> = sqlx::query_scalar(
            "SELECT native_turn_id FROM production_steering_turns WHERE run_id=?",
        )
        .bind(authority.provider.run.run_id.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        match prior {
            Some(v) if v != native_turn_id => return Err(RuntimeStoreError::Conflict),
            Some(_) => {}
            None => {
                sqlx::query("INSERT INTO production_steering_turns VALUES(?,?)")
                    .bind(authority.provider.run.run_id.to_string())
                    .bind(native_turn_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
            }
        }
        tx.commit().await.map_err(db)
    }
}
