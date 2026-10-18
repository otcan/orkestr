//! Opt-in owned-child transaction probes; never armed by server bootstrap.
use super::*;
/// Exact transaction boundaries; no caller-supplied SQL or arbitrary callback.
#[derive(Clone, Copy)]
pub enum ProductionCheckpoint {
    AdmitBeforeAck,
    AdmitBeforeCommit,
    AdmitAfterCommit,
    ReserveBeforeCommit,
    ReserveAfterCommit,
    ConsumeBeforeCommit,
    ConsumeAfterCommit,
}
impl ProductionCheckpoint {
    fn name(self) -> &'static str {
        match self {
            Self::AdmitBeforeAck => "admit-before-ack",
            Self::AdmitBeforeCommit => "admit-before-commit",
            Self::AdmitAfterCommit => "admit-after-commit",
            Self::ReserveBeforeCommit => "reserve-before-commit",
            Self::ReserveAfterCommit => "reserve-after-commit",
            Self::ConsumeBeforeCommit => "consume-before-commit",
            Self::ConsumeAfterCommit => "consume-after-commit",
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
    pub(super) async fn production_checkpoint(&self, name: &str) -> Result<()> {
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
        // A missing parent cannot hang the harness indefinitely. Before COMMIT
        // timeout rolls back; after COMMIT it reports an unknown reply outcome.
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        Err(RuntimeStoreError::Unavailable)
    }
}
