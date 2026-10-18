//! Opt-in owned-child transaction probes; never armed by server bootstrap.
use super::*;
/// Exact transaction boundaries; no caller-supplied SQL or arbitrary callback.
#[derive(Clone, Copy)]
pub enum ProductionCheckpoint {
    RecoveryRestoreBeforeCommit,
    RecoveryRestoreAfterCommit,
    RecoveryRollbackBeforeCommit,
    RecoveryRollbackAfterCommit,
    HistoryImportBeforeCommit,
    HistoryImportAfterCommit,
    HistoryRollbackBeforeCommit,
    HistoryRollbackAfterCommit,
    ExecutionFenceAfterActionRollback,
    AdmitBeforeAck,
    AdmitBeforeCommit,
    AdmitAfterCommit,
    ReserveBeforeCommit,
    ReserveAfterCommit,
    ConsumeBeforeCommit,
    ConsumeAfterCommit,
    ObservationBeforeCommit,
    ObservationAfterCommit,
    CancelBeforeCommit,
    CancelAfterCommit,
    StoppedBeforeCommit,
    StoppedAfterCommit,
    StopAfterAuthentication,
    AcceptanceAfterAuthentication,
    AcceptanceBeforeCommit,
    AcceptanceAfterCommit,
}
impl ProductionCheckpoint {
    fn name(self) -> &'static str {
        match self {
            Self::RecoveryRestoreBeforeCommit => "recovery-restore-before-commit",
            Self::RecoveryRestoreAfterCommit => "recovery-restore-after-commit",
            Self::RecoveryRollbackBeforeCommit => "recovery-rollback-before-commit",
            Self::RecoveryRollbackAfterCommit => "recovery-rollback-after-commit",
            Self::HistoryImportBeforeCommit => "history-import-before-commit",
            Self::HistoryImportAfterCommit => "history-import-after-commit",
            Self::HistoryRollbackBeforeCommit => "history-rollback-before-commit",
            Self::HistoryRollbackAfterCommit => "history-rollback-after-commit",
            Self::ExecutionFenceAfterActionRollback => "execution-fence-after-action-rollback",
            Self::AdmitBeforeAck => "admit-before-ack",
            Self::AdmitBeforeCommit => "admit-before-commit",
            Self::AdmitAfterCommit => "admit-after-commit",
            Self::ReserveBeforeCommit => "reserve-before-commit",
            Self::ReserveAfterCommit => "reserve-after-commit",
            Self::ConsumeBeforeCommit => "consume-before-commit",
            Self::ConsumeAfterCommit => "consume-after-commit",
            Self::ObservationBeforeCommit => "observation-before-commit",
            Self::ObservationAfterCommit => "observation-after-commit",
            Self::CancelBeforeCommit => "cancel-before-commit",
            Self::CancelAfterCommit => "cancel-after-commit",
            Self::StoppedBeforeCommit => "stopped-before-commit",
            Self::StoppedAfterCommit => "stopped-after-commit",
            Self::StopAfterAuthentication => "stop-after-authentication",
            Self::AcceptanceAfterAuthentication => "acceptance-after-authentication",
            Self::AcceptanceBeforeCommit => "acceptance-before-commit",
            Self::AcceptanceAfterCommit => "acceptance-after-commit",
        }
    }
}
pub(crate) struct ArmedCheckpoint {
    stage: ProductionCheckpoint,
    marker: std::path::PathBuf,
}
impl Store {
    /// Arm only an owned test child. Parent must provide a fresh marker in its
    /// controlled directory, wait for exact stage bytes, then kill/reap child.
    /// Reattached handles never inherit this hook. No locator is written.
    pub async fn production_arm_checkpoint(
        &mut self,
        stage: ProductionCheckpoint,
        marker: std::path::PathBuf,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        self.context()?.validate(&mut tx).await?;
        tx.commit().await.map_err(db)?;
        if marker.file_name().is_none()
            || marker.parent().is_none_or(|p| !p.is_dir())
            || std::fs::symlink_metadata(&marker).is_ok()
            || self.production_checkpoint.is_some()
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        self.production_checkpoint = Some(std::sync::Arc::new(ArmedCheckpoint { stage, marker }));
        Ok(())
    }
    /// Test-only owner decision probe. Never grants provider or owner identity;
    /// the harness supplies the same authenticated owner context as the server.
    pub async fn production_arm_owner_checkpoint(
        &mut self,
        owner: &OwnerId,
        conversation: &orkestr_v2_contracts::ConversationId,
        stage: ProductionCheckpoint,
        marker: std::path::PathBuf,
    ) -> Result<()> {
        if self.authority.is_some()
            || !matches!(
                stage,
                ProductionCheckpoint::AcceptanceAfterAuthentication
                    | ProductionCheckpoint::AcceptanceBeforeCommit
                    | ProductionCheckpoint::AcceptanceAfterCommit
            )
        {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        crate::runtime::scope(&mut tx, owner, conversation).await?;
        tx.commit().await.map_err(db)?;
        if marker.file_name().is_none()
            || marker.parent().is_none_or(|p| !p.is_dir())
            || std::fs::symlink_metadata(&marker).is_ok()
            || self.production_checkpoint.is_some()
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        self.production_checkpoint = Some(std::sync::Arc::new(ArmedCheckpoint { stage, marker }));
        Ok(())
    }
    /// Test-only dormant history probe. No target conversation or provider grant
    /// is created. Import/rollback still authenticate inside their own write TX.
    pub async fn production_arm_history_checkpoint(
        &mut self,
        credential: &str,
        owner: &OwnerId,
        stage: ProductionCheckpoint,
        marker: std::path::PathBuf,
    ) -> Result<()> {
        if self.authority.is_some()
            || !matches!(
                stage,
                ProductionCheckpoint::RecoveryRestoreBeforeCommit
                    | ProductionCheckpoint::RecoveryRestoreAfterCommit
                    | ProductionCheckpoint::RecoveryRollbackBeforeCommit
                    | ProductionCheckpoint::RecoveryRollbackAfterCommit
                    | ProductionCheckpoint::HistoryImportBeforeCommit
                    | ProductionCheckpoint::HistoryImportAfterCommit
                    | ProductionCheckpoint::HistoryRollbackBeforeCommit
                    | ProductionCheckpoint::HistoryRollbackAfterCommit
            )
        {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let authorized: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(crate::digest(credential)).bind(owner.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        if authorized != 1 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        tx.commit().await.map_err(db)?;
        if marker.file_name().is_none()
            || marker.parent().is_none_or(|p| !p.is_dir())
            || std::fs::symlink_metadata(&marker).is_ok()
            || self.production_checkpoint.is_some()
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        self.production_checkpoint = Some(std::sync::Arc::new(ArmedCheckpoint { stage, marker }));
        Ok(())
    }
    pub(crate) async fn production_checkpoint(&self, name: &str) -> Result<()> {
        let Some(armed) = &self.production_checkpoint else {
            return Ok(());
        };
        if armed.stage.name() != name {
            return Ok(());
        }
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut marker = options.open(&armed.marker).map_err(db)?;
        marker.write_all(name.as_bytes()).map_err(db)?;
        marker.sync_all().map_err(db)?;
        drop(marker);
        if matches!(
            armed.stage,
            ProductionCheckpoint::ExecutionFenceAfterActionRollback
        ) {
            return Err(RuntimeStoreError::Unavailable);
        }
        // This pre-transaction interleaving probe can resume after the parent
        // commits revocation and removes its owned marker. No write lock is held.
        if matches!(
            armed.stage,
            ProductionCheckpoint::AcceptanceAfterAuthentication
                | ProductionCheckpoint::StopAfterAuthentication
        ) {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
            while tokio::time::Instant::now() < deadline {
                if !armed.marker.try_exists().map_err(db)? {
                    return Ok(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            return Err(RuntimeStoreError::Unavailable);
        }
        // A missing parent cannot hang the harness indefinitely. Before COMMIT
        // timeout rolls back; after COMMIT it reports an unknown reply outcome.
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        Err(RuntimeStoreError::Unavailable)
    }
}
