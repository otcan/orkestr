//! Trusted Worker tool integration; received calls are correlation, never grants.
use super::{offline_result::ToolResultWrite, CodexPump};
use crate::{broker::offline_tool::PendingOfflinePythonCall, ports::Blocker};
use orkestr_v2_store_sqlite::{CompletedToolDelivery, Store};
impl CodexPump {
    pub fn pending_offline_python(&self) -> Option<&PendingOfflinePythonCall> {
        self.source.broker.as_ref()?.pending_offline_python()
    }
    /// Consume the sealed Core delivery exactly once. No caller response JSON.
    pub fn write_tool_result(
        &mut self,
        _store: &Store,
        _credential: &str,
        delivery: CompletedToolDelivery,
    ) -> Result<(), Blocker> {
        let result = (|| {
            if self.source.tool_write.is_some() || self.source.workspace_write.is_some()
                || self.cursor.pending().is_some()
                || self.source.failed.is_some()
            {
                return Err(Blocker::Protocol);
            }
            let call = self.pending_offline_python().ok_or(Blocker::Protocol)?;
            let write = ToolResultWrite::new(call, &self.admission, delivery)?;
            write.enqueue(
                self.source.broker.as_mut().ok_or(Blocker::Protocol)?,
                &self.source.child,
                &self.source.scope,
            )?;
            self.source.tool_write = Some(write);
            Ok(())
        })();
        if result.is_err() {
            self.source.child.quarantine();
            self.source.failed = Some(Blocker::Protocol);
        }
        result
    }
    /// One bounded actual suffix under the dedicated current result fence.
    /// The private credential never enters the broker or native JSON.
    pub async fn poll_tool_result(
        &mut self,
        store: &Store,
        credential: &str,
    ) -> Result<bool, Blocker> {
        let result = self.poll_tool_result_inner(store, credential).await;
        if result.is_err() {
            self.source.child.quarantine();
            self.source.failed = Some(Blocker::Protocol);
        }
        result
    }
    async fn poll_tool_result_inner(
        &mut self,
        store: &Store,
        credential: &str,
    ) -> Result<bool, Blocker> {
        let Some(write) = self.source.tool_write.as_mut() else {
            return Ok(false);
        };
        let channel = self.source.broker.as_mut().ok_or(Blocker::Protocol)?;
        if write.finished() {
            if channel.pending_offline_python().is_none() {
                self.source.tool_write = None;
                return Ok(true);
            }
            return Ok(false);
        }
        // Borrow the retained call separately from the mutable channel. The
        // call is moved back before any future polling can observe the state.
        let call = channel
            .take_pending_offline_python()
            .ok_or(Blocker::Protocol)?;
        let result = write
            .poll(
                store,
                credential,
                &self.source.child,
                &self.source.scope,
                &call,
                &self.admission,
                channel,
            )
            .await;
        channel.restore_pending_offline_python(call)?;
        result.map(|_| false)
    }
}
