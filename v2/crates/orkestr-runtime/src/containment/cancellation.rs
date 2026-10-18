//! Private stop transport. Neither raw JSON nor an execution scope grants control.
use super::{Error, ExecutionScope, Flush, OwnedChild};
use crate::execution::cancellation_fence::CancellationFence;

impl OwnedChild {
    pub(crate) fn enqueue_cancellation(
        &self,
        scope: &ExecutionScope,
        fence: &CancellationFence,
        lineage: &std::sync::Arc<()>,
        bytes: &[u8],
    ) -> Result<(), Error> {
        let canonical = super::broker_frames::cancellation(bytes, lineage, &self.process)?;
        if canonical.len() > self.process.max_frame {
            return Err(Error::FrameTooLarge);
        }
        fence.dispatch(scope, || {
            let state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
            self.shared.check(scope, &state)?;
            self.process
                .live
                .lock()
                .map_err(|_| Error::Revoked)?
                .framing
                .enqueue(&canonical)
        })
    }
    pub(crate) fn flush_cancellation(
        &self,
        scope: &ExecutionScope,
        fence: &CancellationFence,
    ) -> Result<Flush, Error> {
        fence.dispatch(scope, || {
            let state = self.shared.state.lock().map_err(|_| Error::Revoked)?;
            self.shared.check(scope, &state)?;
            self.process
                .live
                .lock()
                .map_err(|_| Error::Revoked)?
                .framing
                .flush()
        })
    }
    pub(crate) fn write_cancellation_suffix(
        &self,
        scope: &ExecutionScope,
        fence: &CancellationFence,
        bytes: &[u8],
    ) -> Result<usize, Error> {
        fence.dispatch(scope, || {
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
    }
}
