//! Core's single SQLite writer for production operations.
use super::*;

impl Store {
    /// `BEGIN IMMEDIATE`. On a Store scoped to a workspace proof, that proof's
    /// short handoff then restarts once, so the time spent queueing for the
    /// writer does not count against it (workspace/writer_handoff.rs).
    pub(in crate::production_runtime) async fn begin_writer(
        &self,
    ) -> Result<sqlx::Transaction<'static, sqlx::Sqlite>> {
        let tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        if let Some(proof) = &self.workspace_check {
            proof.rearm_under_writer();
        }
        Ok(tx)
    }
}
