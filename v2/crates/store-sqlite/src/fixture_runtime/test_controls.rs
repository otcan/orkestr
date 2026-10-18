//! Explicit opt-in offline harness controls. No HTTP or production bootstrap.
//! These only shorten authority or discard a reply; they cannot mint authority.
use super::*;
use orkestr_v2_application::runtime::{DispatchClaim, RuntimeStore};

impl FixtureSupervisorStore {
    /// Persist consume normally, then deliberately discard even DispatchNow.
    /// Models an unavailable reply, not a subprocess crash or actual transport.
    pub async fn fixture_consume_without_reply(&self, claim: &DispatchClaim) -> Result<()> {
        let _ = self.consume_provider_dispatch(claim).await?;
        Err(RuntimeStoreError::Unavailable)
    }

    /// Expire this exact live incarnation using store time. Never extends a
    /// deadline and never targets another owner/key/namespace/incarnation.
    /// The handle becomes expired; exact-predecessor takeover is then required.
    pub async fn fixture_expire_context(&self) -> Result<()> {
        let mut tx = self
            .store
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        self.validate_in(&mut tx).await?;
        let clock = now(&mut tx).await?;
        sqlx::query("UPDATE fixture_supervisors SET lease_deadline_ms=MIN(lease_deadline_ms,?) WHERE context_id=? AND incarnation_id=? AND generation=?")
            .bind(clock).bind(self.context_id.to_string()).bind(self.incarnation_id.to_string())
            .bind(self.generation).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)
    }
}

/// Exact transaction boundaries; no caller-supplied SQL or arbitrary callback.
#[derive(Clone, Copy)]
pub enum FixtureCheckpoint {
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
}
impl FixtureCheckpoint {
    fn name(self) -> &'static str {
        match self {
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
        }
    }
}
pub(super) struct ArmedCheckpoint {
    stage: FixtureCheckpoint,
    marker: std::path::PathBuf,
}
impl FixtureSupervisorStore {
    /// Arm only an owned test child. Parent must provide a fresh marker in its
    /// controlled directory, wait for exact stage bytes, then kill/reap child.
    /// Reattached handles never inherit this hook. No locator is written.
    pub async fn fixture_arm_checkpoint(
        &mut self,
        stage: FixtureCheckpoint,
        marker: std::path::PathBuf,
    ) -> Result<()> {
        self.validate_context().await?;
        if marker.file_name().is_none()
            || marker.parent().is_none_or(|p| !p.is_dir())
            || std::fs::symlink_metadata(&marker).is_ok()
            || self.checkpoint.is_some()
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        self.checkpoint = Some(ArmedCheckpoint { stage, marker });
        Ok(())
    }
    pub(super) async fn fixture_checkpoint(&self, name: &str) -> Result<()> {
        let Some(armed) = &self.checkpoint else {
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
