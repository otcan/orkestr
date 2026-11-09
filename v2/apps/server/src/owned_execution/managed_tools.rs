//! Poll only the Root-observed channel, then issue through the current Deep run.
use super::*;
use crate::window_runtime::manager_client::ManagerError;
use orkestr_v2_store_sqlite::{
    ConsumedManagedOperation, ConsumedProviderDispatch, ManagedOperationConsumption,
    ManagedOperationParent, ManagedOperationSetup,
};
use std::time::Instant;
#[path = "managed_workers.rs"]
mod workers;

#[derive(Clone, Copy, Debug)]
enum ManagedRpc {
    RunOpen,
    Pending,
    Consume,
    Query,
    Renew,
    Result,
}

// Observe only the closed error enum after the RPC has released its resources.
// The original error, deadline and caller's generic pause text remain unchanged.
fn observed_rpc<T>(
    operation: ManagedRpc,
    started: Instant,
    result: Result<T, ManagerError>,
) -> Result<T, ManagerError> {
    if let Err(error) = &result {
        use std::io::Write;
        let _ = writeln!(
            std::io::stderr().lock(),
            "owned_managed_rpc operation={operation:?} outcome={error:?} elapsed_us={}",
            started.elapsed().as_micros()
        );
    }
    result
}

pub(super) struct ManagedTools {
    store: Store,
    credential: String,
    parent: ManagedOperationParent,
    context: std::sync::Arc<crate::window_runtime::context::Context>,
    operation: Option<ConsumedManagedOperation>,
    run_closed: bool,
    workers: workers::NativeWorkers,
}
impl ConfiguredExecution {
    fn managed_enabled(&self) -> bool {
        self.window.is_some()
            && self.config.role == config::ExecutionRole::Deep
            && std::env::var("ORKESTR_V2_MANAGED_OPERATIONS_ENABLED").as_deref() == Ok("1")
    }
    pub(super) fn capture_managed_setup(
        &self,
        grant: &BoundSessionMetadata,
    ) -> Result<(), &'static str> {
        if self.managed_enabled() {
            *self
                .managed_setup
                .lock()
                .map_err(|_| "managed setup unavailable")? = Some(
                ManagedOperationSetup::from_metadata(grant).map_err(|_| "managed setup refused")?,
            );
        }
        Ok(())
    }
    pub(super) async fn prepare_managed(
        &self,
        consumed: &ConsumedProviderDispatch,
    ) -> Result<Option<ManagedTools>, &'static str> {
        if !self.managed_enabled() {
            return Ok(None);
        }
        let setup = self
            .managed_setup
            .lock()
            .map_err(|_| "managed setup unavailable")?
            .clone()
            .ok_or("managed setup missing")?;
        let parent = self
            .store
            .authorize_managed_operation_parent(&self.token, consumed, &setup)
            .await
            .map_err(|_| "managed parent refused")?;
        let context = self.window.clone().ok_or("managed window missing")?;
        let started = Instant::now();
        let result = async {
            let deadline = super::managed_observation::deadline(
                context.work_deadline(),
                parent.lease_deadline_ms(),
            )?;
            context
                .manager
                .open_managed_run(&self.store, &self.token, &context.window, &parent, deadline)
                .await
        }
        .await;
        observed_rpc(ManagedRpc::RunOpen, started, result)
            .map_err(|_| "managed run observation uncertain")?;
        let selected_budget = std::env::var("ORKESTR_V2_MANAGED_WORKER_EXECUTION_BUDGET_MS")
            .ok()
            .map(|value| {
                value
                    .parse::<u32>()
                    .ok()
                    .filter(|ms| (30_000..=3_600_000).contains(ms))
                    .ok_or("native Worker budget refused")
            })
            .transpose()?;
        let worker_budget = selected_budget.and_then(|ms| {
            self.config
                .worker
                .as_ref()
                .and_then(|policy| policy.native_execution_budget(ms))
        });
        Ok(Some(ManagedTools {
            store: self.store.clone(),
            credential: self.token.clone(),
            parent,
            context,
            operation: None,
            run_closed: false,
            workers: workers::NativeWorkers::new(
                self.tasks.clone(),
                consumed.provider().run.clone(),
                self.config
                    .worker
                    .as_ref()
                    .is_some_and(|policy| policy.owner_tasks())
                    && std::env::var("ORKESTR_V2_MANAGED_WORKERS_ENABLED").as_deref() == Ok("1"),
                worker_budget,
            ),
        }))
    }
}
impl ManagedTools {
    fn control_deadline(&self) -> Result<Instant, &'static str> {
        super::managed_observation::deadline(
            self.context.work_deadline(),
            self.parent.lease_deadline_ms(),
        )
        .map_err(|_| "managed control deadline passed")
    }

    pub(super) async fn refresh_lease(
        &mut self,
        authority: &orkestr_v2_store_sqlite::RunRenewalAuthority,
    ) -> Result<(), &'static str> {
        if self.operation.is_some() {
            let deadline = self.control_deadline()?;
            let operation = self.operation.as_mut().ok_or("managed operation lost")?;
            let renewal = self
                .store
                .renew_managed_operation(&self.credential, operation, authority)
                .await
                .map_err(|_| "managed scope renewal refused")?;
            let started = Instant::now();
            let result = self
                .context
                .manager
                .renew_managed(
                    &self.store,
                    &self.credential,
                    &self.context.window,
                    operation,
                    &renewal,
                    deadline,
                )
                .await;
            observed_rpc(ManagedRpc::Renew, started, result)
                .map_err(|_| "managed renewal delivery unknown")?;
        }
        self.store
            .refresh_managed_operation_parent(&self.credential, &mut self.parent, authority)
            .await
            .map_err(|_| "managed parent lease transfer refused")
    }
    pub(super) async fn poll(&mut self) -> Result<(), &'static str> {
        if self.workers.pending() {
            self.poll_native_worker().await?;
        }
        if self.operation.is_none() {
            let started = Instant::now();
            let result = async {
                let deadline = super::managed_observation::deadline(
                    self.context.work_deadline(),
                    self.parent.lease_deadline_ms(),
                )?;
                self.context
                    .manager
                    .pending_managed(&self.context.window, deadline)
                    .await
            }
            .await;
            let Some(request) = observed_rpc(ManagedRpc::Pending, started, result)
                .map_err(|_| "managed Root source unavailable")?
            else {
                return Ok(());
            };
            if request.request.is_native_worker() {
                self.begin_native_worker(request).await?;
                return self.poll_native_worker().await;
            }
            let consumed = self
                .store
                .consume_managed_operation(
                    &self.credential,
                    &self.parent,
                    request.request_id,
                    &request.source,
                    &request.request,
                )
                .await
                .map_err(|_| "managed Core admission refused")?;
            let ManagedOperationConsumption::Operation(operation) = consumed else {
                return Err("managed operation already consumed; reconciliation required");
            };
            self.operation = Some(operation);
            let started = Instant::now();
            let result = self
                .context
                .manager
                .start_managed(
                    &self.store,
                    &self.credential,
                    &self.context.window,
                    self.operation.as_ref().ok_or("managed operation lost")?,
                    self.control_deadline()?,
                )
                .await;
            observed_rpc(ManagedRpc::Consume, started, result)
                .map_err(|_| "managed Root delivery unknown; replay refused")?;
        }
        let operation = self.operation.as_ref().ok_or("managed operation lost")?;
        if self
            .store
            .managed_operation_live(&self.credential, operation)
            .await
            .is_err()
        {
            self.cancel().await?;
            return Err("managed operation fence closed");
        }
        let started = Instant::now();
        let result = self
            .context
            .manager
            .query_managed(
                &self.context.window,
                operation,
                false,
                self.control_deadline()?,
            )
            .await;
        let receipt = observed_rpc(ManagedRpc::Query, started, result)
            .map_err(|_| "managed Root result unknown")?;
        if let Some(outcome) = receipt.terminal {
            let result = self
                .store
                .complete_managed_operation(
                    &self.credential,
                    self.operation.take().ok_or("managed operation lost")?,
                    outcome,
                )
                .await
                .map_err(|_| "managed result persistence uncertain")?;
            let started = Instant::now();
            let result = self
                .context
                .manager
                .release_managed_result(
                    &self.store,
                    &self.credential,
                    &self.context.window,
                    &result,
                    self.control_deadline()?,
                )
                .await;
            observed_rpc(ManagedRpc::Result, started, result)
                .map_err(|_| "managed result release unknown; replay refused")?;
        }
        Ok(())
    }
    pub(super) async fn cancel(&mut self) -> Result<(), &'static str> {
        if !self.run_closed {
            self.context
                .manager
                .close_managed_run(
                    &self.context.window,
                    &self.parent,
                    Instant::now() + Duration::from_secs(1),
                )
                .await
                .map_err(|_| "managed run closure uncertain")?;
            self.run_closed = true;
        }
        let Some(operation) = self.operation.as_ref() else {
            return Ok(());
        };
        let until = Instant::now() + Duration::from_secs(4);
        let mut cancel = true;
        loop {
            let receipt = self
                .context
                .manager
                .query_managed(
                    &self.context.window,
                    operation,
                    cancel,
                    Instant::now() + Duration::from_secs(1),
                )
                .await
                .map_err(|_| "managed cancellation cleanup unknown")?;
            if receipt.terminal.is_some() {
                self.operation = None;
                return Ok(());
            }
            if Instant::now() >= until {
                return Err("managed cancellation cleanup timed out");
            }
            cancel = false;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

#[cfg(test)]
mod rpc_diagnostic_tests {
    use super::*;

    #[test]
    fn observation_preserves_each_closed_rpc_error() {
        for operation in [
            ManagedRpc::RunOpen,
            ManagedRpc::Pending,
            ManagedRpc::Consume,
            ManagedRpc::Query,
            ManagedRpc::Renew,
            ManagedRpc::Result,
        ] {
            for error in [
                ManagerError::InvalidRequest,
                ManagerError::Peer,
                ManagerError::Deadline,
                ManagerError::Unavailable,
                ManagerError::Protocol,
                ManagerError::Refused,
            ] {
                assert_eq!(
                    observed_rpc::<()>(operation, Instant::now(), Err(error)),
                    Err(error)
                );
            }
        }
    }

    #[test]
    fn observation_preserves_success_value() {
        let value = Box::new(17);
        let address = std::ptr::from_ref(value.as_ref());
        let observed = observed_rpc(ManagedRpc::Pending, Instant::now(), Ok(value)).unwrap();
        assert_eq!(std::ptr::from_ref(observed.as_ref()), address);
    }
}
