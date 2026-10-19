//! One retained aggregate window, selected by an authenticated native conversation.
//! Switching retires the original task before creating another private context.
use super::{
    conversation::ConversationController, handles::Handles, initial::InitialAuthority,
    manager_client::ManagerClient,
};
use crate::{beta_config::BetaConfig, execution_registry::ExecutionScope};
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::{
    ConversationId, ExecutionWindowAdmission, ExecutionWindowRequest, ExecutionWindowState,
    ExecutionWindowStatus, OwnerId,
};
use orkestr_v2_store_sqlite::Store;
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub(crate) struct Controller {
    config: BetaConfig,
    home: PathBuf,
    store: Store,
    manager: ManagerClient,
    current: Mutex<Arc<ConversationController>>,
    operation: tokio::sync::Mutex<()>,
}

impl Controller {
    pub(crate) fn new(
        config: BetaConfig,
        home: PathBuf,
        store: Store,
        initial: Arc<InitialAuthority>,
        handles: Handles,
        manager: ManagerClient,
    ) -> Self {
        let current = Arc::new(ConversationController::new(
            config.clone(),
            home.clone(),
            store.clone(),
            initial,
            handles,
            manager.clone(),
        ));
        Self {
            config,
            home,
            store,
            manager,
            current: Mutex::new(current),
            operation: tokio::sync::Mutex::new(()),
        }
    }

    pub(crate) fn configured_scope(&self) -> (&OwnerId, &ConversationId) {
        (&self.config.owner_id, &self.config.conversation_id)
    }

    fn current(&self) -> Result<Arc<ConversationController>, &'static str> {
        self.current
            .lock()
            .map(|value| value.clone())
            .map_err(|_| "window registry poisoned")
    }

    pub(crate) fn snapshot(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Option<ExecutionScope> {
        self.current().ok()?.handles().snapshot(owner, conversation)
    }

    pub(crate) fn roles_configured(&self, owner: &OwnerId, conversation: &ConversationId) -> bool {
        owner == &self.config.owner_id && !conversation.0.is_nil() && self.config.roles.is_some()
    }

    pub(crate) async fn process(
        &self,
        browser: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<ExecutionWindowAdmission, &'static str> {
        let _operation = self.operation.lock().await;
        if owner != &self.config.owner_id || !input.is_valid() {
            return Err("configured owner or window input mismatch");
        }
        // Authenticate the requested conversation BEFORE touching another task.
        // A foreign/stale cookie cannot trigger shutdown or install a scope.
        self.store
            .execution_window_status_authenticated(browser, conversation)
            .await
            .map_err(|_| "selected conversation unavailable")?;
        let mut current = self.current()?;
        if current.configured_scope().1 != conversation {
            let previous = current.configured_scope().1.clone();
            current.refresh().await?;
            if !self
                .store
                .execution_window_switch_ready_authenticated(browser, &previous)
                .await
                .map_err(|_| "previous conversation status unavailable")?
            {
                return Err("previous conversation has unfinished work");
            }
            current.shutdown().await?;
            // Constructor derives only trusted namespace identities. It does not
            // bootstrap, resume, admit, or infer native retirement from absence.
            let config = selected_config(&self.config, conversation)?;
            let handles = Handles::new(owner.clone(), conversation.clone())?;
            let initial = Arc::new(InitialAuthority::new(&config)?);
            let manager = self
                .manager
                .for_conversation(conversation.clone())
                .map_err(|_| "selected manager scope refused")?;
            current = Arc::new(ConversationController::new(
                config,
                self.home.clone(),
                self.store.clone(),
                initial,
                handles,
                manager,
            ));
            *self
                .current
                .lock()
                .map_err(|_| "window registry poisoned")? = current.clone();
        }
        current.process(browser, owner, conversation, input).await
    }

    pub(crate) async fn status(
        &self,
        browser: &str,
        conversation: &ConversationId,
    ) -> Result<Option<ExecutionWindowStatus>, RuntimeStoreError> {
        let _operation = self.operation.lock().await;
        let current = self.current().map_err(|_| RuntimeStoreError::Unavailable)?;
        if current.configured_scope().1 == conversation {
            return current.status(browser, conversation).await;
        }
        let status = self
            .store
            .execution_window_status_authenticated(browser, conversation)
            .await?;
        // A durable unfinished scope without its original local owner remains
        // uncertain. Reading another thread cannot reconstruct a live handle.
        if let Some(status) = status {
            if status.state != ExecutionWindowState::Closed {
                return self
                    .store
                    .reconcile_execution_window_authenticated(
                        browser,
                        conversation,
                        status.window_id,
                        status.generation,
                    )
                    .await
                    .map(Some);
            }
            return Ok(Some(status));
        }
        Ok(None)
    }

    pub(crate) async fn shutdown(&self) -> Result<(), &'static str> {
        let _operation = self.operation.lock().await;
        self.current()?.shutdown().await
    }
}

fn selected_config(
    base: &BetaConfig,
    conversation: &ConversationId,
) -> Result<BetaConfig, &'static str> {
    if conversation.0.is_nil() {
        return Err("selected conversation is nil");
    }
    let mut config = base.clone();
    if conversation != &base.conversation_id {
        let derive = |kind: &str, value: &str| {
            let mut digest = Sha256::new();
            let id = conversation.to_string();
            for part in [
                "orkestr-native-conversation-v1",
                kind,
                value,
                &id,
            ] {
                digest.update(part.as_bytes());
                digest.update([0]);
            }
            format!("conversation:{:x}", digest.finalize())
        };
        config.namespace = derive("namespace", &base.namespace);
        config.supervisor_key = derive("supervisor", &base.supervisor_key);
        config.conversation_id = conversation.clone();
    }
    config.validate()?;
    Ok(config)
}

#[cfg(test)]
#[path = "controller_tests.rs"]
mod tests;
