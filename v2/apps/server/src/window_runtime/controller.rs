//! Concurrent conversation windows under one owner-wide live capacity.
//!
//! Each conversation owns its own retained controller, private authority,
//! local handles and manager scope; one conversation never shuts down, steers
//! or stops another. Fresh windows open one at a time under `opening`, after
//! Core's live-window count leaves room. Other fresh-window intents queue
//! durably in Core and the dispatcher admits them in FIFO order.
use super::{
    conversation::ConversationController, dispatch::QueueState, handles::Handles,
    initial::InitialAuthority, manager_client::ManagerClient,
};
use crate::{beta_config::BetaConfig, execution_registry::ExecutionScope};
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::{
    ConversationId, ExecutionWindowAdmission, ExecutionWindowQueue, ExecutionWindowQueued,
    ExecutionWindowRequest, ExecutionWindowState, ExecutionWindowStatus, OwnerId,
};
use orkestr_v2_store_sqlite::Store;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

/// Retained per-process conversation controllers. Entries are never evicted:
/// each keeps its handle generation and one-shot authority history.
const MAX_CONVERSATIONS: usize = 1024;

pub(crate) enum WindowOutcome {
    Admitted(ExecutionWindowAdmission),
    Queued(ExecutionWindowQueued),
}

pub(crate) struct Controller {
    pub(super) config: BetaConfig,
    home: PathBuf,
    pub(super) store: Store,
    manager: ManagerClient,
    pub(super) capacity: u32,
    conversations: Mutex<HashMap<ConversationId, Arc<ConversationController>>>,
    pub(super) opening: tokio::sync::Mutex<()>,
    pub(super) queue: QueueState,
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
        let configured = Arc::new(ConversationController::new(
            config.clone(),
            home.clone(),
            store.clone(),
            initial,
            handles,
            manager.clone(),
        ));
        let mut conversations = HashMap::new();
        conversations.insert(config.conversation_id.clone(), configured);
        Self {
            capacity: config.active_windows(),
            config,
            home,
            store,
            manager,
            conversations: Mutex::new(conversations),
            opening: tokio::sync::Mutex::new(()),
            queue: QueueState::default(),
        }
    }

    pub(crate) fn configured_scope(&self) -> (&OwnerId, &ConversationId) {
        (&self.config.owner_id, &self.config.conversation_id)
    }

    pub(crate) fn roles_configured(&self, owner: &OwnerId, conversation: &ConversationId) -> bool {
        owner == &self.config.owner_id && !conversation.0.is_nil() && self.config.roles.is_some()
    }

    pub(super) fn existing(
        &self,
        conversation: &ConversationId,
    ) -> Option<Arc<ConversationController>> {
        self.conversations.lock().ok()?.get(conversation).cloned()
    }

    /// Retained controller for an authenticated conversation. Construction
    /// derives only trusted namespace identities; it never admits or resumes.
    pub(super) fn entry(
        &self,
        conversation: &ConversationId,
    ) -> Result<Arc<ConversationController>, &'static str> {
        let mut conversations = self
            .conversations
            .lock()
            .map_err(|_| "window registry poisoned")?;
        if let Some(entry) = conversations.get(conversation) {
            return Ok(entry.clone());
        }
        if conversations.len() >= MAX_CONVERSATIONS {
            return Err("window registry capacity exhausted");
        }
        let config = selected_config(&self.config, conversation)?;
        let handles = Handles::new(self.config.owner_id.clone(), conversation.clone())?;
        let initial = Arc::new(InitialAuthority::new(&config)?);
        let manager = self
            .manager
            .for_conversation(conversation.clone())
            .map_err(|_| "selected manager scope refused")?;
        let entry = Arc::new(ConversationController::new(
            config,
            self.home.clone(),
            self.store.clone(),
            initial,
            handles,
            manager,
        ));
        conversations.insert(conversation.clone(), entry.clone());
        Ok(entry)
    }

    /// Drop a retained controller whose window was closed by reconciliation.
    /// Only called when it holds no local task (checked under `opening`).
    pub(super) fn forget(&self, conversation: &ConversationId) -> Result<(), &'static str> {
        self.conversations
            .lock()
            .map_err(|_| "window registry poisoned")?
            .remove(conversation);
        Ok(())
    }

    /// Retained controllers with their conversations (no Core access).
    pub(super) fn entries_by_conversation(
        &self,
    ) -> Vec<(ConversationId, Arc<ConversationController>)> {
        self.conversations
            .lock()
            .map(|entries| {
                entries
                    .iter()
                    .map(|(id, entry)| (id.clone(), entry.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn entries(&self) -> Vec<Arc<ConversationController>> {
        self.conversations
            .lock()
            .map(|entries| entries.values().cloned().collect())
            .unwrap_or_default()
    }

    pub(crate) fn snapshot(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Option<ExecutionScope> {
        self.existing(conversation)?
            .handles()
            .snapshot(owner, conversation)
    }

    pub(crate) fn fast_snapshot(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Option<ExecutionScope> {
        self.existing(conversation)?
            .handles()
            .fast_snapshot(owner, conversation)
    }

    pub(crate) async fn process(
        &self,
        browser: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<WindowOutcome, &'static str> {
        if owner != &self.config.owner_id || !input.is_valid() {
            return Err("configured owner or window input mismatch");
        }
        if self.queue.is_closed() {
            return Err("window controller stopped");
        }
        // Authenticate the requested conversation and replay BEFORE touching
        // any task. A foreign/stale cookie cannot create or change a scope.
        let unavailable = |_| "selected conversation or intent unavailable";
        if let Some(queued) = self
            .store
            .queued_execution_window_authenticated(browser, conversation, input)
            .await
            .map_err(unavailable)?
        {
            self.queue.remember(browser);
            return Ok(WindowOutcome::Queued(queued));
        }
        if let Some(replay) = self
            .store
            .inspect_execution_window_request_authenticated(browser, conversation, input)
            .await
            .map_err(unavailable)?
        {
            return Ok(WindowOutcome::Admitted(replay));
        }
        self.queue.remember(browser);
        let entry = self.entry(conversation)?;
        if input.window_id.is_some() && !self.waiting(browser, conversation).await? {
            if self.joinable(browser, conversation, input).await? {
                // A follow-up joins this conversation's live window; no new slot.
                return entry
                    .process(browser, owner, conversation, input)
                    .await
                    .map(WindowOutcome::Admitted);
            }
            // Under ten minutes of work time left even with extension: queue
            // durably. The dispatcher opens the successor window, which
            // resumes the same native session, once this one closes.
            return self.enqueue(browser, conversation, input).await;
        }
        let _opening = self.opening.lock().await;
        self.sweep(browser).await;
        // Windows stranded by a previous process past their hard deadline are
        // abandoned (audited) so their conversations can open again, and
        // this conversation's failed open (for example a refused broker bind)
        // is closed as failed by the owner's new message.
        self.reconcile_expired_locked(browser).await;
        self.reconcile_failed_open_locked(browser, conversation)
            .await;
        // Reconciliation drops this conversation's poisoned controller; take
        // the fresh one so this very attempt opens the next window.
        let entry = self.entry(conversation)?;
        // Earlier durable intents (any conversation) take free slots first.
        self.drain_locked(browser).await;
        let mut room = input.window_id.is_some() || self.live(browser).await? < self.capacity;
        if !room && !self.waiting(browser, conversation).await? {
            // Retire another conversation's idle window rather than queue.
            let keep = std::iter::once(conversation.clone()).collect();
            room = self.reclaim_idle(browser, &keep).await
                && self.live(browser).await? < self.capacity;
        }
        if room && !self.waiting(browser, conversation).await? {
            return entry
                .process(browser, owner, conversation, input)
                .await
                .map(WindowOutcome::Admitted);
        }
        self.enqueue(browser, conversation, input).await
    }

    async fn enqueue(
        &self,
        browser: &str,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<WindowOutcome, &'static str> {
        let queued = self
            .store
            .enqueue_execution_window_authenticated(browser, conversation, input)
            .await
            .map_err(|_| "window queue unavailable")?;
        self.queue.wake();
        Ok(WindowOutcome::Queued(queued))
    }

    /// Whether the live window this follow-up names still leaves it enough
    /// work time. Any other state is left to Core admission, unchanged.
    async fn joinable(
        &self,
        browser: &str,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<bool, &'static str> {
        let status = self
            .store
            .execution_window_status_authenticated(browser, conversation)
            .await
            .map_err(|_| "selected conversation or intent unavailable")?;
        Ok(match status {
            Some(status)
                if Some(status.window_id) == input.window_id
                    && status.state == orkestr_v2_contracts::ExecutionWindowState::Active =>
            {
                super::dispatch::joinable(
                    &status,
                    super::dispatch::now_ms(),
                    self.config.window_max_lifetime_ms_for(conversation),
                )
            }
            _ => true,
        })
    }

    async fn live(&self, browser: &str) -> Result<u32, &'static str> {
        self.store
            .live_execution_windows_authenticated(browser)
            .await
            .map_err(|_| "window capacity unavailable")
    }

    /// Whether this conversation already has queued intents (per-conversation order).
    async fn waiting(
        &self,
        browser: &str,
        conversation: &ConversationId,
    ) -> Result<bool, &'static str> {
        self.store
            .execution_window_queue_authenticated(browser, Some(conversation))
            .await
            .map(|rows| !rows.is_empty())
            .map_err(|_| "window queue unavailable")
    }

    pub(crate) async fn status(
        &self,
        browser: &str,
        conversation: &ConversationId,
    ) -> Result<Option<ExecutionWindowStatus>, RuntimeStoreError> {
        // Never wait behind an opening window just to poll status.
        if let Ok(_opening) = self.opening.try_lock() {
            self.sweep(browser).await;
            self.reconcile_expired_locked(browser).await;
        }
        let result = self.status_inner(browser, conversation).await;
        if result.is_ok() {
            self.queue.remember(browser);
        }
        result
    }

    async fn status_inner(
        &self,
        browser: &str,
        conversation: &ConversationId,
    ) -> Result<Option<ExecutionWindowStatus>, RuntimeStoreError> {
        if let Some(entry) = self.existing(conversation) {
            return entry.status(browser, conversation).await;
        }
        let status = self
            .store
            .execution_window_status_authenticated(browser, conversation)
            .await?;
        let Some(status) = status else {
            return Ok(None);
        };
        if status.state == ExecutionWindowState::Closed {
            return Ok(Some(status));
        }
        // An opener inserts its entry before admitting, so a window seen here
        // with an entry present may be live in this process: ask its owner.
        if let Some(entry) = self.existing(conversation) {
            return entry.status(browser, conversation).await;
        }
        // A durable unfinished scope without its original local owner remains
        // uncertain. Reading another thread cannot reconstruct a live handle.
        self.store
            .reconcile_execution_window_authenticated(
                browser,
                conversation,
                status.window_id,
                status.generation,
            )
            .await
            .map(Some)
    }

    pub(crate) async fn queue_status(
        &self,
        browser: &str,
        conversation: &ConversationId,
    ) -> Result<ExecutionWindowQueue, RuntimeStoreError> {
        let entries = self
            .store
            .execution_window_queue_authenticated(browser, Some(conversation))
            .await?;
        let total = self
            .store
            .execution_window_queue_authenticated(browser, None)
            .await?
            .len();
        let active = self
            .store
            .live_execution_windows_authenticated(browser)
            .await?;
        self.queue.remember(browser);
        Ok(ExecutionWindowQueue {
            conversation_id: conversation.clone(),
            capacity: self.capacity,
            active,
            queued_total: u32::try_from(total).map_err(|_| RuntimeStoreError::Unavailable)?,
            entries,
        })
    }

    /// Stop dispatching, then stop every conversation concurrently so all
    /// windows share the manager's single shutdown margin.
    pub(crate) async fn shutdown(&self) -> Result<(), &'static str> {
        self.queue.close().await;
        let _opening = self.opening.lock().await;
        let mut tasks = tokio::task::JoinSet::new();
        for entry in self.entries() {
            tasks.spawn(async move { entry.shutdown().await });
        }
        let mut result = Ok(());
        while let Some(outcome) = tasks.join_next().await {
            match outcome {
                Ok(Ok(())) => {}
                Ok(Err(error)) => result = Err(error),
                Err(_) => result = Err("window shutdown task lost"),
            }
        }
        result
    }
}

pub(super) fn selected_config(
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
            for part in ["orkestr-native-conversation-v1", kind, value, &id] {
                digest.update(part.as_bytes());
                digest.update([0]);
            }
            format!("conversation:{:x}", digest.finalize())
        };
        config.namespace = derive("namespace", &base.namespace);
        config.supervisor_key = derive("supervisor", &base.supervisor_key);
        config.conversation_id = conversation.clone();
    }
    // A configured per-conversation directory replaces the Codex and Claude
    // Deep and Fast working directory of this conversation only. Workers keep
    // their own configured workspaces. The Claude launcher accepts it only as
    // one of the same operator-pinned directories (host full access).
    if let Some(workspace) = base.conversation_workspaces.get(conversation) {
        config.workspace = workspace.clone();
        if let Some(roles) = config.roles.as_mut() {
            roles.fast.workspace = workspace.clone();
        }
        if let Some(claude) = config.claude.as_mut() {
            claude.workspace = workspace.clone();
        }
    }
    config.validate()?;
    Ok(config)
}

#[path = "stranded.rs"]
mod stranded;
pub(crate) use stranded::ReconcileError;

#[cfg(test)]
#[path = "controller_tests.rs"]
mod tests;
