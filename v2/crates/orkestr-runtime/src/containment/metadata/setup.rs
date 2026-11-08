//! Fence observations leave every metadata, process and SQLite lock first.
use super::*;
use orkestr_v2_store_sqlite::MetadataFenceDiagnostics;

impl MetadataShared {
    // Lock order: metadata gate -> Core durable fence -> execution gate -> child.
    // No caller may enter metadata methods from a durable fence callback.
    pub(super) fn setup<T>(&self, action: impl FnOnce() -> Result<T, Error>) -> Result<T, Error> {
        self.setup_observed(action, MetadataFenceDiagnostics::emit)
    }

    pub(super) fn setup_observed<T>(
        &self,
        action: impl FnOnce() -> Result<T, Error>,
        observe: impl FnOnce(&MetadataFenceDiagnostics),
    ) -> Result<T, Error> {
        let (result, diagnostics) = {
            let state = self.state.lock().map_err(|_| Error::Revoked)?;
            if state.phase != Phase::Setup {
                return Err(Error::Revoked);
            }
            let grant = state.grant.as_ref().ok_or(Error::Revoked)?;
            self.store.with_metadata_fence_diagnostics(grant, action)
        };
        // Setup polls frequently. Keep successful polls silent; preserve the
        // closed stage chain on Store refusal before collapsing it to Revoked.
        if result.is_err() {
            observe(&diagnostics);
        }
        crate::store_diagnostics::observe(
            crate::store_diagnostics::Operation::MetadataSetupFence,
            None,
            result,
        )
        .map_err(|_| Error::Revoked)?
    }
}
