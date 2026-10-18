use super::*;
use orkestr_v2_application::runtime::{Binding, ProviderKind, Role, SessionState};
use orkestr_v2_contracts::SessionId;

impl FixtureSupervisorStore {
    /// Explicit synthetic fixture protocol confirmation, version 1 only. Returns
    /// authoritative binding. Does not accept native IDs, real providers or Lost
    /// replacement, and is never called by the server or ordinary Store.
    pub async fn confirm_fixture_readiness(
        &self,
        session: &SessionId,
        protocol_version: u32,
    ) -> Result<Binding> {
        if protocol_version != 1 {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self
            .store
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        self.validate_in(&mut tx).await?;
        let row = sqlx::query("SELECT * FROM session_bindings WHERE id=? AND owner_id=?")
            .bind(session.to_string())
            .bind(self.owner.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or(RuntimeStoreError::NotFound)?;
        let existing = crate::runtime::binding(&row)?;
        if existing.role != Role::Deep {
            return Err(RuntimeStoreError::InvalidInput);
        }
        if let Some(ready) = sqlx::query("SELECT * FROM fixture_readiness WHERE session_id=?")
            .bind(session.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
        {
            if ready.get::<String, _>("context_id") != self.context_id.to_string()
                || ready.get::<String, _>("incarnation_id") != self.incarnation_id.to_string()
            {
                return Err(RuntimeStoreError::Fenced);
            }
            if existing.state != SessionState::Ready {
                return Err(RuntimeStoreError::Busy);
            }
            tx.commit().await.map_err(db)?;
            return Ok(existing);
        }
        if existing.state != SessionState::Starting
            || existing.native_session_id.is_some()
            || existing.provider_kind != ProviderKind::Unconfigured
        {
            return Err(RuntimeStoreError::Conflict);
        }
        // Native reservation includes namespace and unique typed session, not caller text.
        let native = format!("fixture-v1:{session}");
        let updated = sqlx::query("UPDATE session_bindings SET provider_kind='explicit_fixture',provider_namespace=?,native_session_id=?,state='ready',generation=generation+1 WHERE id=? RETURNING *")
            .bind(&self.namespace).bind(native).bind(session.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO fixture_readiness(session_id,context_id,incarnation_id,protocol_version) VALUES(?,?,?,1)")
            .bind(session.to_string()).bind(self.context_id.to_string()).bind(self.incarnation_id.to_string())
            .execute(&mut *tx).await.map_err(db)?;
        let result = crate::runtime::binding(&updated)?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
}
