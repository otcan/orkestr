use super::*;
use sqlx::sqlite::SqliteRow;
impl Store {
    pub(crate) fn worker_credential(&self, credential: &str) -> Result<()> {
        if credential.len() != 64
            || !credential.bytes().all(|b| b.is_ascii_hexdigit())
            || crate::digest(credential) != self.context()?.token_hash
        {
            return Err(RuntimeStoreError::Unauthorized);
        }
        Ok(())
    }
    /// RunId is a server-side locator, never evidence supplied by a provider.
    /// Resolve all execution identity from the sealed context and durable row.
    pub(super) async fn worker_parent_in(
        &self,
        tx: &mut SqliteConnection,
        credential: &str,
        parent_run_id: &RunId,
    ) -> Result<SqliteRow> {
        self.worker_credential(credential)?;
        self.worker_parent_current_in(tx, parent_run_id).await
    }
    pub(crate) async fn worker_parent_current_in(
        &self,
        tx: &mut SqliteConnection,
        parent_run_id: &RunId,
    ) -> Result<SqliteRow> {
        let c = self.context()?;
        c.validate(tx).await?;
        let row = sqlx::query("SELECT * FROM production_runs WHERE id=? AND owner_id=? AND context_id=? AND incarnation_id=?")
            .bind(parent_run_id.to_string()).bind(c.owner.to_string()).bind(&c.id).bind(&c.incarnation)
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::NotFound)?;
        let canonical = super::super::admission::envelope(&row)?;
        if canonical.run.role != Role::Deep
            || canonical.run.purpose != AdmissionPurpose::Execution
            || row.get::<&str, _>("state") != "running"
            || row.get::<&str, _>("dispatch_state") != "delivery_unknown"
        {
            return Err(RuntimeStoreError::Fenced);
        }
        // A read-only parallel Deep run never delegates: a Worker could act.
        if super::super::parallel_deep::is_slot(tx, row.get::<&str, _>("session_id")).await? {
            return Err(RuntimeStoreError::Fenced);
        }
        self.production_authorized_run(tx, &canonical).await
    }
}
