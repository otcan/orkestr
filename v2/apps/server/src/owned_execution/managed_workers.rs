//! One bounded Native waiter advances through ordinary parent/scheduler ticks.
use super::*;
use crate::window_runtime::manager_client::ObservedManagedRequest;
use orkestr_v2_application::runtime::RunAdmission;
use orkestr_v2_store_sqlite::{NativeWorkerAvailability, NativeWorkerCall};

pub(super) struct NativeWorkers {
    access: crate::worker_tasks::WorkerTaskAccess,
    parent: RunAdmission,
    configured: bool,
    execution_budget_ms: Option<u32>,
    calls: std::collections::VecDeque<(NativeWorkerCall, Instant)>,
}
impl NativeWorkers {
    pub(super) fn new(
        access: crate::worker_tasks::WorkerTaskAccess,
        parent: RunAdmission,
        configured: bool,
        execution_budget_ms: Option<u32>,
    ) -> Self {
        Self {
            access,
            parent,
            configured,
            execution_budget_ms,
            calls: std::collections::VecDeque::new(),
        }
    }
    pub(super) fn pending(&self) -> bool {
        !self.calls.is_empty()
    }
    fn availability(&self) -> NativeWorkerAvailability {
        NativeWorkerAvailability {
            configured: self.configured,
            execution_budget_ms: self.execution_budget_ms,
            scheduler_available: self.calls.len() < 4
                && self.access.available(
                    &self.parent.owner_id,
                    &self.parent.conversation_id,
                    &self.parent.run_id,
                ),
        }
    }
}
impl ManagedTools {
    pub(super) async fn begin_native_worker(
        &mut self,
        request: ObservedManagedRequest,
    ) -> Result<(), &'static str> {
        let call = self
            .store
            .begin_native_worker_call(
                &self.credential,
                &self.parent,
                request.request_id,
                &request.source,
                &request.request,
                self.workers.availability(),
            )
            .await
            .map_err(|_| "native Worker admission refused; outcome must be reconciled")?;
        // The Native request itself remains pending while the existing schedule
        // advances. No child terminal wait can hold the parent's controller.
        let deadline = (Instant::now() + Duration::from_secs(25)).min(self.context.work_deadline());
        if call.waits() {
            self.context
                .manager
                .bind_native_worker(
                    &self.store,
                    &self.credential,
                    &self.context.window,
                    &self.parent,
                    call.root_binding(&self.parent),
                    self.control_deadline()?,
                )
                .await
                .map_err(|_| "native Worker binding delivery unknown; do not resubmit")?;
        }
        if call.waits() {
            self.workers.calls.push_back((call, deadline));
        } else {
            let observation = self
                .store
                .observe_native_worker_call(&self.credential, &self.parent, &call)
                .await
                .map_err(|_| "native Worker observation refused")?;
            self.context
                .manager
                .reply_native_worker(
                    &self.store,
                    &self.credential,
                    &self.context.window,
                    &self.parent,
                    call.root_reply(&observation, &self.parent),
                    self.control_deadline()?,
                )
                .await
                .map_err(|_| "native Worker result delivery unknown; do not resubmit")?;
        }
        Ok(())
    }
    pub(super) async fn poll_native_worker(&mut self) -> Result<(), &'static str> {
        let Some((call, deadline)) = self.workers.calls.pop_front() else {
            return Ok(());
        };
        let observation = self
            .store
            .observe_native_worker_call(&self.credential, &self.parent, &call)
            .await
            .map_err(|_| "native Worker observation fenced; replay refused")?;
        if call.waits() && !observation.terminal() && Instant::now() < deadline {
            self.workers.calls.push_back((call, deadline));
            return Ok(());
        }
        let reply = call.root_reply(&observation, &self.parent);
        self.context
            .manager
            .reply_native_worker(
                &self.store,
                &self.credential,
                &self.context.window,
                &self.parent,
                reply,
                self.control_deadline()?,
            )
            .await
            .map_err(|_| "native Worker result delivery unknown; do not resubmit")?;
        Ok(())
    }
}
