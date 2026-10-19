//! Same owned native writer, guarded by Core's dedicated steering authority.
use super::{Error, ExecutionScope, OwnedChild};
use orkestr_v2_application::runtime::ProviderAdmission;
use orkestr_v2_store_sqlite::{ConsumedSteering, Store};
use std::sync::Arc;
impl OwnedChild {
    pub(crate) fn enqueue_steering(
        &self,
        scope: &ExecutionScope,
        lineage: &Arc<()>,
        bytes: &[u8],
    ) -> Result<(), Error> {
        if !Arc::ptr_eq(lineage, &self.process.broker_lineage) || bytes.len() > 65536 {
            self.quarantine();
            return Err(Error::AuthorityProtocol);
        }
        self.shared.dispatch(scope, |_| {
            self.process
                .live
                .lock()
                .map_err(|_| Error::Revoked)?
                .framing
                .enqueue(bytes)
        })
    }
    pub(crate) fn write_steering_suffix(
        &self,
        store: &Store,
        scope: &ExecutionScope,
        original: &ProviderAdmission,
        lineage: &Arc<()>,
        delivery: &mut ConsumedSteering,
        bytes: &[u8],
    ) -> Result<usize, Error> {
        if delivery.provider() != original
            || !Arc::ptr_eq(lineage, &self.process.broker_lineage)
            || scope.owner() != original.run.owner_id.to_string()
            || scope.session() != original.run.session_id.to_string()
            || scope.run() != original.run.run_id.to_string()
            || scope.generation() != original.run.dispatch_fence
            || original.binding.native_session_id.as_deref() != Some(delivery.thread_id())
        {
            self.quarantine();
            return Err(Error::AuthorityProtocol);
        }
        let offset = delivery.written_bytes();
        let result = store
            .with_codex_steering_fence(delivery, offset, bytes.len(), || {
                let state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
                self.shared.check(scope, &state)?;
                self.process
                    .live
                    .lock()
                    .map_err(|_| Error::Revoked)?
                    .provider_writer
                    .as_mut()
                    .ok_or(Error::AuthorityProtocol)?
                    .write_suffix(bytes)
            })
            .map_err(|_| Error::Revoked)
            .and_then(|r| r);
        if result.is_err() {
            self.quarantine();
        }
        result
    }
}
