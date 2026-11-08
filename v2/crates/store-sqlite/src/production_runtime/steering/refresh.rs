//! Same-process steering continuation after a committed lease transition.
use super::*;
impl Store {
    /// Consume the old issuer only after Runtime quiesces and transfers its same
    /// owned process. This issues no input, dispatch capability or native turn.
    pub async fn refresh_codex_steering(
        &self,
        authority: CodexSteeringAuthority,
        transition: &RunLeaseTransition,
    ) -> Result<CodexSteeringAuthority> {
        if authority.provider != *transition.previous() {
            return Err(RuntimeStoreError::Fenced);
        }
        let refreshed = CodexSteeringAuthority {
            provider: transition.current().clone(),
            context: authority.context,
            incarnation: authority.incarnation,
        };
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let workspace = self
            .check_binding_before_writer(&refreshed.provider.binding)
            .await?;
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let store = &*workspace;
        #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
        let store = self;
        let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        current(store, &mut tx, &refreshed).await?;
        let bound: i64 =
            sqlx::query_scalar("SELECT count(*) FROM production_steering_turns WHERE run_id=?")
                .bind(refreshed.provider.run.run_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if bound != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        tx.commit().await.map_err(db)?;
        Ok(refreshed)
    }
}
