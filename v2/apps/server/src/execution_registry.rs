//! Trusted startup scope selection. This registry never creates authority and
//! never falls back to another conversation's Store, controls or task scheduler.
use crate::{control_registry::ControlRegistry, worker_tasks::WorkerTaskAccess, AppState, Error};
use axum::http::StatusCode;
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::{ConversationId, OwnerId};
use orkestr_v2_store_sqlite::Store;
use std::{collections::HashMap, sync::Arc};

pub(crate) const MAX_EXECUTION_SCOPES: usize = 16;

#[derive(Clone)]
pub(crate) struct ExecutionScope {
    pub store: Store,
    pub control: Option<ControlRegistry>,
    pub tasks: Option<WorkerTaskAccess>,
}

#[derive(Clone, Default)]
pub(crate) struct ExecutionRegistry {
    scopes: Arc<HashMap<(OwnerId, ConversationId), ExecutionScope>>,
}

impl ExecutionRegistry {
    fn insert(
        &mut self,
        owner: OwnerId,
        conversation: ConversationId,
        scope: ExecutionScope,
    ) -> Result<(), &'static str> {
        if owner.0.is_nil() || conversation.0.is_nil() {
            return Err("execution registry requires an exact owner and conversation");
        }
        if scope
            .control
            .as_ref()
            .is_some_and(|control| !control.matches_scope(&owner, &conversation))
            || scope
                .tasks
                .as_ref()
                .is_some_and(|tasks| !tasks.matches_scope(&owner, &conversation))
        {
            return Err("execution registry handle scope mismatch");
        }
        let key = (owner, conversation);
        if self.scopes.contains_key(&key) {
            return Err("execution scope already registered");
        }
        if self.scopes.len() >= MAX_EXECUTION_SCOPES {
            return Err("execution registry capacity exhausted");
        }
        Arc::make_mut(&mut self.scopes).insert(key, scope);
        Ok(())
    }

    fn get(&self, owner: &OwnerId, conversation: &ConversationId) -> Option<&ExecutionScope> {
        self.scopes.get(&(owner.clone(), conversation.clone()))
    }
}

impl AppState {
    /// Trusted bootstrap only. HTTP inputs cannot install or replace a scope.
    pub fn with_execution_store(
        mut self,
        owner: OwnerId,
        conversation: ConversationId,
        store: Store,
    ) -> Result<Self, &'static str> {
        self.executions.insert(
            owner,
            conversation,
            ExecutionScope {
                store,
                control: None,
                tasks: None,
            },
        )?;
        Ok(self)
    }

    pub(crate) fn with_execution_scope(
        mut self,
        owner: OwnerId,
        conversation: ConversationId,
        scope: ExecutionScope,
    ) -> Result<Self, &'static str> {
        self.executions.insert(owner, conversation, scope)?;
        Ok(self)
    }

    pub(crate) async fn execution_scope(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<Option<ExecutionScope>, Error> {
        if let Some(controller) = &self.window_controller {
            if let Some(scope) = controller.snapshot(owner, conversation) {
                return Ok(Some(scope));
            }
        }
        if let Some(handles) = &self.window_handles {
            if handles.matches(owner, conversation) {
                return Ok(handles.snapshot(owner, conversation));
            }
        }
        if let Some(scope) = self.executions.get(owner, conversation) {
            return Ok(Some(scope.clone()));
        }
        // Preserve unknown/foreign scope refusal without looking up any other
        // runtime handle. A known but unconfigured conversation stays unavailable.
        self.store
            .execution_status(owner, conversation)
            .await
            .map_err(|error| match error {
                RuntimeStoreError::NotFound | RuntimeStoreError::Unauthorized => {
                    Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
                }
                _ => Error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "store_unavailable",
                    "Execution status unavailable",
                ),
            })?;
        Ok(None)
    }

    pub(crate) fn with_fast_execution_scope(
        mut self,
        owner: OwnerId,
        conversation: ConversationId,
        scope: ExecutionScope,
    ) -> Result<Self, &'static str> {
        if scope.tasks.is_some() {
            return Err("Fast scope cannot own Worker task authority");
        }
        self.fast_executions.insert(owner, conversation, scope)?;
        Ok(self)
    }

    pub(crate) async fn fast_execution_scope(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<Option<ExecutionScope>, Error> {
        if let Some(scope) = self.fast_executions.get(owner, conversation) {
            return Ok(Some(scope.clone()));
        }
        // Authenticate the canonical conversation without selecting a Deep
        // runtime as a fallback for an unconfigured Fast role.
        self.execution_scope(owner, conversation).await?;
        Ok(None)
    }
}
