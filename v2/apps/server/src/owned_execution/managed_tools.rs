//! Poll only the Root-observed channel, then issue through the current Deep run.
use super::*;
use orkestr_v2_store_sqlite::{
    ConsumedManagedOperation, ConsumedProviderDispatch, ManagedOperationConsumption,
    ManagedOperationParent, ManagedOperationSetup,
};
use std::time::Instant;

pub(super) struct ManagedTools {
    store: Store,
    credential: String,
    parent: ManagedOperationParent,
    context: std::sync::Arc<crate::window_runtime::context::Context>,
    operation: Option<ConsumedManagedOperation>,
    run_closed: bool,
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
        context
            .manager
            .open_managed_run(
                &self.store,
                &self.token,
                &context.window,
                &parent,
                Instant::now() + Duration::from_secs(1),
            )
            .await
            .map_err(|_| "managed run observation uncertain")?;
        Ok(Some(ManagedTools {
            store: self.store.clone(),
            credential: self.token.clone(),
            parent,
            context,
            operation: None,
            run_closed: false,
        }))
    }
}
impl ManagedTools {
    pub(super) async fn refresh_lease(
        &mut self,
        authority: &orkestr_v2_store_sqlite::RunRenewalAuthority,
    ) -> Result<(), &'static str> {
        if let Some(operation) = self.operation.as_mut() {
            let renewal = self
                .store
                .renew_managed_operation(&self.credential, operation, authority)
                .await
                .map_err(|_| "managed scope renewal refused")?;
            self.context
                .manager
                .renew_managed(
                    &self.store,
                    &self.credential,
                    &self.context.window,
                    operation,
                    &renewal,
                    Instant::now() + Duration::from_secs(1),
                )
                .await
                .map_err(|_| "managed renewal delivery unknown")?;
        }
        self.store
            .refresh_managed_operation_parent(&self.credential, &mut self.parent, authority)
            .await
            .map_err(|_| "managed parent lease transfer refused")
    }
    pub(super) async fn poll(&mut self) -> Result<(), &'static str> {
        if self.operation.is_none() {
            let Some(request) = self
                .context
                .manager
                .pending_managed(
                    &self.context.window,
                    Instant::now() + Duration::from_secs(1),
                )
                .await
                .map_err(|_| "managed Root source unavailable")?
            else {
                return Ok(());
            };
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
            self.context
                .manager
                .start_managed(
                    &self.store,
                    &self.credential,
                    &self.context.window,
                    self.operation.as_ref().ok_or("managed operation lost")?,
                    Instant::now() + Duration::from_secs(1),
                )
                .await
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
        let receipt = self
            .context
            .manager
            .query_managed(
                &self.context.window,
                operation,
                false,
                Instant::now() + Duration::from_secs(1),
            )
            .await
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
            self.context
                .manager
                .release_managed_result(
                    &self.store,
                    &self.credential,
                    &self.context.window,
                    &result,
                    Instant::now() + Duration::from_secs(1),
                )
                .await
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
