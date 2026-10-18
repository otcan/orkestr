use super::*;
use crate::runtime::ledger::hash;
impl Store {
    /// Only a trusted protocol adapter may submit native readiness evidence.
    pub async fn confirm_native_session(
        &self,
        input: NativeSessionConfirmation,
    ) -> Result<Binding> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let binding = self
            .confirm_native_session_in(&mut tx, input, false)
            .await?;
        tx.commit().await.map_err(db)?;
        Ok(binding)
    }
    pub(super) async fn confirm_native_session_in(
        &self,
        tx: &mut SqliteConnection,
        input: NativeSessionConfirmation,
        worker_authorized: bool,
    ) -> Result<Binding> {
        let c = self.context()?;
        if input.native_session_id.is_empty()
            || input.native_session_id.len() > 512
            || input.native_session_id.chars().any(char::is_control)
            || !valid(&input.protocol_version)
            || !valid(&input.source_event_key)
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let digest = hash(
            "production-readiness-v1",
            &[
                &input.session_id.to_string(),
                &input.expected_generation.to_string(),
                &input.native_session_id,
                &input.protocol_version,
                &input.source_event_key,
            ],
        );
        c.validate(tx).await?;
        let row = sqlx::query("SELECT * FROM session_bindings WHERE id=? AND owner_id=?")
            .bind(input.session_id.to_string())
            .bind(c.owner.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or(RuntimeStoreError::NotFound)?;
        let binding = crate::runtime::binding(&row)?;
        if binding.role == Role::Worker && !worker_authorized {
            return Err(RuntimeStoreError::Fenced);
        }
        if let Some(ready) = sqlx::query("SELECT * FROM production_readiness WHERE session_id=?")
            .bind(input.session_id.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
        {
            if ready.get::<String, _>("context_id") != c.id
                || ready.get::<String, _>("incarnation_id") != c.incarnation
            {
                return Err(RuntimeStoreError::Fenced);
            }
            if ready.get::<String, _>("evidence_digest") != digest {
                return Err(RuntimeStoreError::Conflict);
            }
            return Ok(binding);
        }
        if binding.generation != input.expected_generation {
            return Err(RuntimeStoreError::StaleLease);
        }
        if binding.state != SessionState::Starting
            || binding.native_session_id.is_some()
            || binding.provider_kind != ProviderKind::Unconfigured
        {
            return Err(RuntimeStoreError::Conflict);
        }
        let aliases:i64=sqlx::query_scalar("SELECT count(*) FROM session_bindings WHERE provider_kind=? AND provider_namespace=? AND native_session_id=?")
            .bind(provider_name(c.provider)?).bind(&c.namespace).bind(&input.native_session_id).fetch_one(&mut *tx).await.map_err(db)?;
        if aliases != 0 {
            return Err(RuntimeStoreError::Conflict);
        }
        let updated=sqlx::query("UPDATE session_bindings SET provider_kind=?,provider_namespace=?,native_session_id=?,state='ready',generation=generation+1 WHERE id=? RETURNING *")
            .bind(provider_name(c.provider)?).bind(&c.namespace).bind(&input.native_session_id).bind(input.session_id.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO production_readiness(session_id,context_id,incarnation_id,protocol_version,source_event_key,evidence_digest) VALUES(?,?,?,?,?,?)")
            .bind(input.session_id.to_string()).bind(&c.id).bind(&c.incarnation).bind(input.protocol_version).bind(input.source_event_key).bind(digest).execute(&mut *tx).await.map_err(db)?;
        let result = crate::runtime::binding(&updated)?;
        Ok(result)
    }
}
