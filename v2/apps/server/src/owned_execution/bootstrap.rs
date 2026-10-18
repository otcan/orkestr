//! One issued metadata grant creates one owned native setup; failures never retry.
use super::*;
use orkestr_runtime::{
    containment::ChildDirectories,
    execution::{PreparingCodex, ReadyCodex},
};
use orkestr_v2_store_sqlite::BoundSessionMetadata;
use std::time::Instant;

impl ConfiguredExecution {
    pub(super) async fn prepare_session(
        &self,
        grant: BoundSessionMetadata,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<ReadyCodex>, &'static str> {
        self.maintain(heartbeat).await?;
        self.config.verify_launcher()?;
        if *shutdown.borrow() {
            return Ok(None);
        }
        let directories = ChildDirectories::new(
            &self.config.workspace,
            &self.directory.join("home"),
            &self.directory.join("tmp"),
        )
        .map_err(|_| "execution child directories unavailable")?;
        // The opaque grant selects fresh setup or exact native resume. Neither
        // caller text nor persisted status can supply a replacement identity.
        let mut setup = PreparingCodex::open_retained(
            self.store.clone(),
            grant,
            &self.config.launcher,
            &self.config.workspace,
            directories,
            self.children.retain(),
        )
        .map_err(|_| "execution broker setup refused")?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if *shutdown.borrow() {
                return Ok(None);
            }
            self.maintain(heartbeat).await?;
            if setup
                .poll()
                .map_err(|_| "execution broker readiness refused")?
            {
                break;
            }
            if Instant::now() >= deadline {
                return Err("execution broker readiness timed out");
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                _ = shutdown.changed() => return Ok(None),
            }
        }
        setup
            .confirm()
            .await
            .map(Some)
            .map_err(|_| "execution readiness commit refused")
    }
}
