//! Actual native result bytes use only the dedicated issued tool fence.
use super::{Error, ExecutionScope, OwnedChild};
use crate::broker::offline_tool::PendingOfflinePythonCall;
use orkestr_v2_application::runtime::ProviderAdmission;
use orkestr_v2_store_sqlite::{CompletedToolDelivery, Store};

impl OwnedChild {
    pub(crate) fn enqueue_tool_result(
        &self,
        scope: &ExecutionScope,
        lineage: &std::sync::Arc<()>,
        envelope: &[u8],
    ) -> Result<(), Error> {
        if !std::sync::Arc::ptr_eq(lineage, &self.process.broker_lineage) || envelope.len() > 65536
        {
            self.quarantine();
            return Err(Error::AuthorityProtocol);
        }
        self.shared.dispatch(scope, |_| {
            self.process
                .live
                .lock()
                .map_err(|_| Error::Revoked)?
                .framing
                .enqueue(envelope)
        })
    }
    #[allow(clippy::too_many_arguments)] // Exact child, call and issuer identities remain explicit.
    pub(crate) fn write_tool_result_suffix(
        &self,
        store: &Store,
        credential: &str,
        scope: &ExecutionScope,
        pending: &PendingOfflinePythonCall,
        original: &ProviderAdmission,
        delivery: &mut CompletedToolDelivery,
        bytes: &[u8],
    ) -> Result<usize, Error> {
        let call = delivery.native_call();
        if scope.owner() != original.run.owner_id.to_string()
            || scope.session() != original.run.session_id.to_string()
            || scope.run() != original.run.run_id.to_string()
            || scope.generation() != original.run.dispatch_fence
            || !pending.matches_lineage(&self.process.broker_lineage)
            || delivery.parent() != original
            || !delivery.matches_source(pending.source())
            || call.request_id != *pending.request_id()
            || call.call_id != pending.call_id()
            || call.thread_id != pending.thread_id()
            || call.turn_id != pending.turn_id()
        {
            self.quarantine();
            return Err(Error::AuthorityProtocol);
        }
        let offset = delivery.written_bytes();
        // Core transaction -> local authority -> actual provider writer.
        // Do not nest the ordinary inference fence around this callback.
        let result = store
            .with_offline_python_result_fence(credential, delivery, offset, bytes.len(), || {
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
            .and_then(|result| result);
        if result.is_err() {
            self.quarantine();
        }
        result
    }
}
