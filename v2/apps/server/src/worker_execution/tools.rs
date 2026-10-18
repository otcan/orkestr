//! One owned tool job per ordinary Worker. No provider wait holds a scheduling
//! lock, and abort retains the physical sandbox reaper's resource ownership.
use crate::offline_python::{
    offline_python_controls, OfflinePythonDispatcher, OfflinePythonResult,
};
use crate::owned_children::ChildSet;
use orkestr_v2_store_sqlite::{
    CompletedToolDelivery, ConsumedProviderDispatch, OfflinePythonAdmission,
    OfflinePythonNativeCall, OfflinePythonParent, OfflinePythonResultConsumption, Store,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::task::JoinSet;

pub(super) struct WorkerTools {
    parent: Arc<OfflinePythonParent>,
    dispatcher: Arc<OfflinePythonDispatcher>,
    store: Store,
    credential: Arc<str>,
    children: ChildSet,
    active: Option<Active>,
}
struct Active {
    call: OfflinePythonNativeCall,
    source: String,
    jobs: JoinSet<Result<CompletedToolDelivery, &'static str>>,
    cleanup: ToolCleanup,
    delivering: bool,
}

/// Negative cleanup condition only; it cannot authorize any provider event.
pub(super) struct ToolCleanup(Arc<AtomicBool>);
struct Reaped(Arc<AtomicBool>);
impl Drop for Reaped {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
impl ToolCleanup {
    pub fn is_reaped(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

impl WorkerTools {
    pub async fn prepare(
        store: Store,
        credential: String,
        consumed: &ConsumedProviderDispatch,
        dispatcher: Arc<OfflinePythonDispatcher>,
        children: ChildSet,
    ) -> Result<Self, &'static str> {
        let parent = store
            .authorize_offline_python_parent(&credential, consumed)
            .await
            .map_err(|_| "Worker tool lineage refused")?;
        Ok(Self {
            parent: Arc::new(parent),
            dispatcher,
            store,
            credential: credential.into(),
            children,
            active: None,
        })
    }

    /// Called only with a descriptor copied from Runtime's exact sealed pending
    /// call. Core revalidates retained lineage at delegation, spawn and delivery.
    pub fn begin(
        &mut self,
        call: OfflinePythonNativeCall,
        source: String,
    ) -> Result<(), &'static str> {
        if self.active.is_some() {
            return Err("Worker already has an outstanding tool call");
        }
        let (store, credential, parent, dispatcher) = (
            self.store.clone(),
            self.credential.clone(),
            self.parent.clone(),
            self.dispatcher.clone(),
        );
        let reaped = Arc::new(AtomicBool::new(false));
        let retained: Box<dyn Send> = Box::new((self.children.retain(), Reaped(reaped.clone())));
        let submitted = call.clone();
        let exact_source = source.clone();
        let mut jobs = JoinSet::new();
        jobs.spawn(async move {
            let admission = store
                .delegate_native_offline_python(&credential, &parent, &submitted, &source, 10_000)
                .await
                .map_err(|_| "Worker tool delegation refused")?;
            let OfflinePythonAdmission::Fresh(grant) = admission else {
                return Err("Worker tool replay requires reconciliation");
            };
            let (_, signals) = offline_python_controls();
            let OfflinePythonResult::Prepared(reservation) =
                dispatcher.run_native(grant, signals, retained).await
            else {
                return Err("Worker tool execution requires reconciliation");
            };
            match store
                .consume_offline_python_result(&credential, reservation)
                .await
            {
                Ok(OfflinePythonResultConsumption::Deliver(delivery)) => Ok(delivery),
                _ => Err("Worker tool result requires reconciliation"),
            }
        });
        self.active = Some(Active {
            call,
            source: exact_source,
            jobs,
            cleanup: ToolCleanup(reaped),
            delivering: false,
        });
        Ok(())
    }

    /// No sandbox/provider wait. One bounded result suffix and one job poll.
    pub async fn poll(
        &mut self,
        pump: &mut orkestr_runtime::execution::CodexPump,
    ) -> Result<(), &'static str> {
        if pump
            .poll_tool_result(&self.store, &self.credential)
            .await
            .map_err(|_| "Worker tool result fence refused")?
        {
            self.delivered()?;
        }
        let Some(pending) = pump.pending_offline_python() else {
            return if self.active.is_some() {
                Err("Worker pending tool correlation disappeared")
            } else {
                Ok(())
            };
        };
        let call = OfflinePythonNativeCall {
            request_id: pending.request_id().clone(),
            call_id: pending.call_id().into(),
            thread_id: pending.thread_id().into(),
            turn_id: pending.turn_id().into(),
        };
        if let Some(active) = &self.active {
            if active.call != call || active.source != pending.source() {
                return Err("Worker pending tool source or correlation changed");
            }
        } else if pump.pending().is_none() {
            self.begin(call, pending.source().into())?;
        }
        // Retain completed output while a preceding observation is uncommitted.
        // Stop remains gated by the same existing observation rule.
        if pump.pending().is_none() {
            if let Some(delivery) = self.take_delivery()? {
                pump.write_tool_result(&self.store, &self.credential, delivery)
                    .map_err(|_| "Worker native tool response refused")?;
            }
        }
        Ok(())
    }

    /// Nonblocking collection only. Native result I/O remains Runtime-owned.
    pub fn take_delivery(&mut self) -> Result<Option<CompletedToolDelivery>, &'static str> {
        let Some(active) = &mut self.active else {
            return Ok(None);
        };
        if active.delivering {
            return Ok(None);
        }
        match active.jobs.try_join_next() {
            None => Ok(None),
            Some(Ok(Ok(delivery))) => {
                active.delivering = true;
                Ok(Some(delivery))
            }
            Some(_) => Err("Worker tool job requires reconciliation"),
        }
    }

    /// Runtime has removed its pending call only after its whole result frame
    /// and dedicated Core delivery finish have succeeded.
    pub fn delivered(&mut self) -> Result<(), &'static str> {
        if self
            .active
            .as_ref()
            .is_none_or(|a| !a.delivering || !a.cleanup.is_reaped())
        {
            return Err("Worker tool delivery is not complete");
        }
        self.active = None;
        Ok(())
    }

    /// Drop of JoinSet aborts its owned future; the dispatcher's CancelOnDrop
    /// stops Python. The returned condition turns true only after actual wait.
    pub fn cancel(mut self) -> Option<ToolCleanup> {
        self.active.take().map(|active| {
            let Active { jobs, cleanup, .. } = active;
            drop(jobs);
            cleanup
        })
    }
}
