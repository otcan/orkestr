//! Actual result suffixes require the sealed call, child and current Core grant.
use super::{Error, ExecutionScope, OwnedChild};
use crate::broker::desk_tool::PendingDeskLoginCall;
use orkestr_v2_application::runtime::ProviderAdmission;
use orkestr_v2_store_sqlite::{CompletedDeskLogin, Store};
impl OwnedChild {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn write_desk_result_suffix(
        &self,
        store: &Store,
        credential: &str,
        scope: &ExecutionScope,
        pending: &PendingDeskLoginCall,
        original: &ProviderAdmission,
        delivery: &mut CompletedDeskLogin,
        bytes: &[u8],
    ) -> Result<usize, Error> {
        let call = pending.native_call();
        let expected = delivery.native_call();
        let offset = delivery.written_bytes();
        if scope.owner() != original.run.owner_id.to_string()
            || scope.session() != original.run.session_id.to_string()
            || scope.run() != original.run.run_id.to_string()
            || scope.generation() != original.run.dispatch_fence
            || !pending.matches_lineage(&self.process.broker_lineage)
            || delivery.parent() != original
            || expected.request_id != call.request_id
            || expected.call_id != call.call_id
            || expected.thread_id != call.thread_id
            || expected.turn_id != call.turn_id
            || expected.operation_id != call.operation_id
            || delivery
                .bytes()
                .get(offset..offset.saturating_add(bytes.len()))
                != Some(bytes)
        {
            self.quarantine();
            return Err(Error::AuthorityProtocol);
        }
        let result = store
            .with_desk_login_result_fence(credential, delivery, offset, bytes.len(), || {
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
