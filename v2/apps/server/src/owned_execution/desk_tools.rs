//! Native correlation -> sealed Core Deep grant -> fixed Root operation.
//! No general Root executor, ambient bearer or caller-authored role/owner proof.
use super::*;
use orkestr_runtime::execution::CodexPump;
use orkestr_v2_store_sqlite::{
    ConsumedDeskLogin, ConsumedProviderDispatch, DeskLoginConsumption, DeskLoginParent,
};
use std::time::Instant;

pub(super) struct DeskTools {
    store: Store,
    credential: String,
    parent: DeskLoginParent,
    context: std::sync::Arc<crate::window_runtime::context::Context>,
    operation: Option<ConsumedDeskLogin>,
    delivering: bool,
}
impl ConfiguredExecution {
    pub(super) fn desk_enabled(&self) -> bool {
        self.window.is_some()
            && self.config.role == config::ExecutionRole::Deep
            && self.config.provider == config::Provider::Codex
            && std::env::var("ORKESTR_V2_DESK_LOGIN_ENABLED").as_deref() == Ok("1")
    }
    pub(super) async fn prepare_desk(
        &self,
        consumed: &ConsumedProviderDispatch,
    ) -> Result<Option<DeskTools>, &'static str> {
        if !self.desk_enabled() {
            return Ok(None);
        }
        let source = self
            .desk_setup
            .lock()
            .map_err(|_| "desk source unavailable")?
            .clone()
            .ok_or("desk source missing")?;
        let parent = self
            .store
            .authorize_desk_login_parent(&self.token, consumed, &source)
            .await
            .map_err(|_| "desk Deep parent refused")?;
        Ok(Some(DeskTools {
            store: self.store.clone(),
            credential: self.token.clone(),
            parent,
            context: self.window.clone().ok_or("desk window missing")?,
            operation: None,
            delivering: false,
        }))
    }
}
impl DeskTools {
    pub(super) async fn poll(&mut self, pump: &mut CodexPump) -> Result<(), &'static str> {
        if pump
            .poll_desk_login_result(&self.store, &self.credential)
            .await
            .map_err(|_| "desk result delivery uncertain")?
        {
            self.delivering = false;
        }
        if self.delivering {
            return Ok(());
        }
        let Some(pending) = pump.pending_desk_login() else {
            return if self.operation.is_some() {
                Err("desk native correlation lost")
            } else {
                Ok(())
            };
        };
        if self.operation.is_none() {
            let call = pending.native_call();
            let result = self
                .store
                .consume_native_desk_login(&self.credential, &self.parent, &call, 30000)
                .await
                .map_err(|_| "desk Core admission refused")?;
            let DeskLoginConsumption::Operation(operation) = result else {
                return Err("desk call already consumed; reconciliation required");
            };
            self.operation = Some(operation);
            let operation = self.operation.as_ref().ok_or("desk operation lost")?;
            if self
                .context
                .manager
                .start_desk(
                    &self.store,
                    &self.credential,
                    &self.context.window,
                    operation,
                    Instant::now() + Duration::from_secs(1),
                )
                .await
                .is_err()
            {
                let _ = self.cancel().await;
                return Err("desk Root delivery unknown; replay refused");
            }
        }
        let operation = self.operation.as_ref().ok_or("desk operation lost")?;
        if self
            .store
            .desk_login_live(&self.credential, operation)
            .await
            .is_err()
        {
            self.cancel().await?;
            return Err("desk run fence closed");
        }
        let receipt = self
            .context
            .manager
            .query_desk(
                &self.context.window,
                operation,
                false,
                Instant::now() + Duration::from_secs(1),
            )
            .await
            .map_err(|_| "desk Root receipt unknown")?;
        if let Some(outcome) = receipt
            .outcome()
            .map_err(|_| "desk Root effect unknown; reconciliation required")?
        {
            let delivery = self
                .store
                .prepare_desk_login_result(
                    &self.credential,
                    self.operation.take().ok_or("desk operation lost")?,
                    outcome,
                )
                .await
                .map_err(|_| "desk result preparation uncertain")?;
            pump.write_desk_login_result(delivery)
                .map_err(|_| "desk result correlation refused")?;
            self.delivering = true;
        }
        Ok(())
    }
    pub(super) async fn cancel(&mut self) -> Result<(), &'static str> {
        let Some(operation) = self.operation.as_ref() else {
            return Ok(());
        };
        let until = Instant::now() + Duration::from_secs(4);
        let mut cancel = true;
        loop {
            let receipt = self
                .context
                .manager
                .query_desk(
                    &self.context.window,
                    operation,
                    cancel,
                    Instant::now() + Duration::from_secs(1),
                )
                .await
                .map_err(|_| "desk cancellation cleanup unknown")?;
            if receipt.cleanup {
                self.operation = None;
                return Ok(());
            }
            if Instant::now() >= until {
                return Err("desk cancellation cleanup timed out");
            }
            cancel = false;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
