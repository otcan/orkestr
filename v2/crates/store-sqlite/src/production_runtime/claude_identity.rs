//! Claude initialize acknowledges process readiness, not native session identity.
use super::*;

/// Trusted adapter evidence of correlated protocol initialization. The UUID was
/// selected by the launcher; no field here claims the provider echoed it.
pub struct ClaudeProcessInitialization {
    pub requested_native_session_id: String,
    pub protocol_version: String,
    pub source_event_key: String,
}
impl Store {
    /// Consume setup authority while reserving an explicitly UNOBSERVED UUID.
    /// Only the trusted adapter may call this after validating initialize ACK.
    pub async fn initialize_claude_session(
        &self,
        grant: BoundSessionMetadata,
        input: ClaudeProcessInitialization,
    ) -> Result<ReadySessionTransition> {
        if self.context()?.provider != ProviderKind::Claude {
            return Err(RuntimeStoreError::Fenced);
        }
        if !Uuid::parse_str(&input.requested_native_session_id)
            .is_ok_and(|id| !id.is_nil() && id.to_string() == input.requested_native_session_id)
            || !valid(&input.protocol_version)
            || !valid(&input.source_event_key)
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.validate_metadata(&mut tx, &grant).await?;
        // Resume consumes the existing one-use reservation without claiming a
        // fresh observation. The exact immutable native identity must be retained.
        let ready = if grant.resume.is_some() {
            if grant.binding.native_session_id.as_ref() != Some(&input.requested_native_session_id)
            {
                return Err(RuntimeStoreError::Conflict);
            }
            self.consume_claude_resume_in(&mut tx, &grant, &input)
                .await?;
            grant.binding.clone()
        } else {
            self.register_native_reservation_in(
                &mut tx,
                super::readiness::NativeReservation {
                    digest_domain: "claude-process-initialized-v1",
                    session_id: grant.binding.session_id.clone(),
                    expected_generation: grant.binding.generation,
                    native_session_id: input.requested_native_session_id.clone(),
                    protocol_version: input.protocol_version,
                    source_event_key: input.source_event_key.clone(),
                },
                grant.parent_run.is_some(),
            )
            .await?
        };
        sqlx::query("INSERT INTO production_requested_native(session_id,binding_generation,context_id,incarnation_id,requested_native_id,initialization_key) VALUES(?,?,?,?,?,?)")
            .bind(ready.session_id.to_string()).bind(i64::try_from(ready.generation).map_err(db)?)
            .bind(&grant.context.id).bind(&grant.context.incarnation).bind(input.requested_native_session_id)
            .bind(input.source_event_key).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(ReadySessionTransition {
            metadata: grant,
            ready,
        })
    }
    /// Persist actual matching system/init from the SAME consumed native turn.
    /// No run/dispatch authority is minted, and retries preserve the original key.
    pub async fn observe_claude_session(
        &self,
        provider: &ProviderAdmission,
        native_session_id: &str,
        source_event_key: &str,
    ) -> Result<()> {
        if !valid(source_event_key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let run = self.production_authorized_run(&mut tx, provider).await?;
        if self.context()?.provider != ProviderKind::Claude
            || provider.run.purpose != AdmissionPurpose::Execution
            || run.get::<&str, _>("dispatch_state") != "delivery_unknown"
            || Some(native_session_id) != provider.run.native_session_id.as_deref()
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let row = sqlx::query("SELECT * FROM production_requested_native WHERE session_id=? AND binding_generation=? AND context_id=? AND incarnation_id=?")
            .bind(provider.run.session_id.to_string()).bind(i64::try_from(provider.binding.generation).map_err(db)?)
            .bind(&self.context()?.id).bind(&self.context()?.incarnation)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        if row.get::<&str, _>("requested_native_id") != native_session_id {
            return Err(RuntimeStoreError::Fenced);
        }
        if let Some(id) = row.get::<Option<String>, _>("observed_run_id") {
            if id != provider.run.run_id.to_string()
                || row.get::<Option<&str>, _>("observed_event_key") != Some(source_event_key)
            {
                return Err(RuntimeStoreError::Conflict);
            }
        } else {
            sqlx::query("UPDATE production_requested_native SET observed_run_id=?,observed_event_key=? WHERE session_id=? AND binding_generation=? AND context_id=? AND incarnation_id=? AND observed_run_id IS NULL")
                .bind(provider.run.run_id.to_string()).bind(source_event_key).bind(provider.run.session_id.to_string())
                .bind(i64::try_from(provider.binding.generation).map_err(db)?)
                .bind(&self.context()?.id).bind(&self.context()?.incarnation)
                .execute(&mut *tx).await.map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }
    pub(super) async fn require_observed_native(
        &self,
        tx: &mut SqliteConnection,
        p: &ProviderAdmission,
    ) -> Result<()> {
        let c = self.context()?;
        let (initialized, observed): (i64, i64) = sqlx::query_as("SELECT count(*),coalesce(sum(CASE WHEN requested_native_id=? AND observed_run_id=? AND observed_event_key IS NOT NULL THEN 1 ELSE 0 END),0) FROM production_requested_native WHERE session_id=? AND binding_generation=? AND context_id=? AND incarnation_id=?")
            .bind(p.run.native_session_id.as_deref()).bind(p.run.run_id.to_string())
            .bind(p.run.session_id.to_string()).bind(i64::try_from(p.binding.generation).map_err(db)?)
            .bind(&c.id).bind(&c.incarnation).fetch_one(tx).await.map_err(db)?;
        if initialized != observed
            || (p.binding.provider_kind == ProviderKind::Claude && observed != 1)
        {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
}
