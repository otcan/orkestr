//! Provider-reported model metadata, separate from canonical run transitions.
use super::*;
use crate::runtime::ledger::hash;
use orkestr_v2_contracts::ExecutionModelObservation;

impl Store {
    /// The exact issued provider envelope authenticates this metadata. It grants
    /// no dispatch, cancellation, acceptance, native continuity or cleanup proof.
    pub async fn observe_provider_model(
        &self,
        provider: &ProviderAdmission,
        observation: &ExecutionModelObservation,
        request_key: &str,
    ) -> Result<()> {
        if !observation.is_valid()
            || request_key.is_empty()
            || request_key.len() > 128
            || !request_key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
            || provider.run.purpose != AdmissionPurpose::Execution
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let context = self.context()?;
        if provider.run.owner_id != context.owner {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        context.authenticate(&mut tx).await?;
        let row =
            sqlx::query("SELECT * FROM production_runs WHERE id=? AND owner_id=? AND context_id=?")
                .bind(provider.run.run_id.to_string())
                .bind(context.owner.to_string())
                .bind(&context.id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .ok_or(RuntimeStoreError::NotFound)?;
        super::leases::authenticate(&mut tx, &row, provider).await?;
        let digest = hash(
            "production-model-evidence-v1",
            &[
                &provider.run.run_id.to_string(),
                &provider.run.session_id.to_string(),
                &provider.run.lease_generation.to_string(),
                &provider.run.dispatch_fence.to_string(),
                observation.source_name(),
                &observation.model,
                request_key,
            ],
        );
        if let Some(prior) = sqlx::query_scalar::<_, String>(
            "SELECT semantic_digest FROM production_run_models WHERE run_id=? AND request_key=?",
        )
        .bind(provider.run.run_id.to_string())
        .bind(request_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        {
            return if prior == digest {
                Ok(())
            } else {
                Err(RuntimeStoreError::Conflict)
            };
        }
        let row = self.production_authorized_run(&mut tx, provider).await?;
        if !matches!(row.get::<&str, _>("state"), "starting" | "running") {
            return Err(RuntimeStoreError::Fenced);
        }
        self.require_observed_native(&mut tx, provider).await?;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM production_run_models WHERE run_id=?")
                .bind(provider.run.run_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if count >= 64 {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let observed_at = now(&mut tx).await?;
        sqlx::query("INSERT INTO production_run_models(id,run_id,source,model,request_key,semantic_digest,sequence,observed_at_ms) VALUES(?,?,?,?,?,?,?,?)")
            .bind(Uuid::new_v4().to_string()).bind(provider.run.run_id.to_string()).bind(observation.source_name())
            .bind(&observation.model).bind(request_key).bind(digest).bind(count+1).bind(observed_at)
            .execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(())
    }
}
