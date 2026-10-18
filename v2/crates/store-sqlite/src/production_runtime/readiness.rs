use super::*;
use crate::runtime::ledger::hash;
pub(super) struct NativeReservation {
    pub digest_domain: &'static str,
    pub session_id: orkestr_v2_contracts::SessionId,
    pub expected_generation: u64,
    pub native_session_id: String,
    pub protocol_version: String,
    pub source_event_key: String,
}
impl From<NativeSessionConfirmation> for NativeReservation {
    fn from(v: NativeSessionConfirmation) -> Self {
        Self {
            digest_domain: "production-readiness-v1",
            session_id: v.session_id,
            expected_generation: v.expected_generation,
            native_session_id: v.native_session_id,
            protocol_version: v.protocol_version,
            source_event_key: v.source_event_key,
        }
    }
}
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
        self.context()?.validate(tx).await?;
        let pending: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM production_requested_native WHERE session_id=?",
        )
        .bind(input.session_id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if pending != 0 {
            return Err(RuntimeStoreError::Fenced);
        }
        self.register_native_reservation_in(tx, input.into(), worker_authorized)
            .await
    }
    // Shared reservation writer. Calling this does not establish observed identity;
    // the requested-Claude path records that distinction in the same transaction.
    pub(super) async fn register_native_reservation_in(
        &self,
        tx: &mut SqliteConnection,
        input: NativeReservation,
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
            input.digest_domain,
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
