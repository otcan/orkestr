//! Serialized private admission-to-task handoff; receipts alone never launch.
use super::{
    context::Context,
    handles::Handles,
    initial::{InitialAuthority, WindowAuthority},
    manager_client::{Admission, ManagerClient, Window},
};
use crate::{
    beta_config::BetaConfig,
    owned_execution::{ConfiguredExecution, WindowTask},
};
use orkestr_v2_application::runtime::{
    ProductionSupervisorConfig, ProductionTakeover, ProviderKind,
};
use orkestr_v2_contracts::{ExecutionWindowAdmission, ExecutionWindowRequest};
use orkestr_v2_store_sqlite::Store;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub(super) struct ConversationController {
    config: BetaConfig,
    home: PathBuf,
    store: Store,
    initial: Arc<InitialAuthority>,
    manager: ManagerClient,
    handles: Handles,
    state: Mutex<State>,
    operation: Mutex<()>,
}
enum State {
    Idle,
    Starting,
    Running(WindowTask),
    Uncertain,
}
impl ConversationController {
    pub(super) fn handles(&self) -> &Handles {
        &self.handles
    }
    pub(crate) fn configured_scope(
        &self,
    ) -> (
        &orkestr_v2_contracts::OwnerId,
        &orkestr_v2_contracts::ConversationId,
    ) {
        (&self.config.owner_id, &self.config.conversation_id)
    }

    pub(crate) fn new(
        config: BetaConfig,
        home: PathBuf,
        store: Store,
        initial: Arc<InitialAuthority>,
        handles: Handles,
        manager: ManagerClient,
    ) -> Self {
        Self {
            config,
            home,
            store,
            initial,
            handles,
            manager,
            state: Mutex::new(State::Idle),
            operation: Mutex::new(()),
        }
    }
    pub(crate) async fn process(
        &self,
        browser: &str,
        owner: &orkestr_v2_contracts::OwnerId,
        conversation: &orkestr_v2_contracts::ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<ExecutionWindowAdmission, &'static str> {
        let _operation = self.operation.lock().await;
        self.refresh().await?;
        super::integers::generation(input.expected_generation)?;
        let admission = self
            .initial
            .admit(&self.store, browser, owner, conversation, input)
            .await
            .map_err(|_| "window admission refused")?;
        super::integers::generation(admission.status.generation)?;
        super::integers::timestamp(admission.status.opened_at_ms)?;
        super::integers::timestamp(admission.status.expires_at_ms)?;
        self.admitted(browser, input, &admission).await?;
        Ok(admission)
    }
    pub(crate) async fn status(
        &self,
        browser: &str,
        conversation: &orkestr_v2_contracts::ConversationId,
    ) -> Result<
        Option<orkestr_v2_contracts::ExecutionWindowStatus>,
        orkestr_v2_application::runtime::RuntimeStoreError,
    > {
        let _operation = self.operation.lock().await;
        let _ = self.refresh().await;
        let status = self
            .store
            .execution_window_status_authenticated(browser, conversation)
            .await?;
        if let Some(status) = status {
            if status.state != orkestr_v2_contracts::ExecutionWindowState::Closed
                && matches!(
                    *self.state.lock().await,
                    State::Idle | State::Uncertain | State::Starting
                )
            {
                let status = self
                    .store
                    .reconcile_execution_window_authenticated(
                        browser,
                        conversation,
                        status.window_id,
                        status.generation,
                    )
                    .await?;
                *self.state.lock().await = State::Uncertain;
                self.handles.poison();
                return Ok(Some(status));
            }
            return Ok(Some(status));
        }
        Ok(None)
    }
    pub(crate) async fn shutdown(&self) -> Result<(), &'static str> {
        let _operation = self.operation.lock().await;
        // Observe completed retirement before applying a live cleanup deadline.
        self.refresh().await?;
        let mut state = self.state.lock().await;
        if let State::Running(task) = &mut *state {
            let deadline = task
                .cleanup_deadline()
                .min(tokio::time::Instant::now() + Duration::from_secs(30));
            let result = task.stop_until(deadline).await;
            if result.is_ok() && task.is_closed() {
                *state = State::Idle;
                return Ok(());
            }
            *state = State::Uncertain;
            self.handles.poison();
            return Err("window shutdown is not proven retirement");
        }
        if matches!(*state, State::Idle) {
            return Ok(());
        }
        let status = self
            .manager
            .status(
                &format!("shutdown:{}", uuid::Uuid::new_v4()),
                Instant::now() + Duration::from_secs(2),
            )
            .await;
        if let Ok(super::manager_client::ManagerReceipt::Window(receipt)) = status {
            let _ = self
                .manager
                .uncertain(
                    &format!("shutdown:{}", uuid::Uuid::new_v4()),
                    &Window {
                        window_id: receipt.window_id,
                        generation: receipt.generation,
                    },
                    super::manager_client::Uncertainty::ServerLost,
                    Instant::now() + Duration::from_secs(2),
                )
                .await;
        }
        Err("window shutdown requires reconciliation")
    }
    pub(crate) async fn refresh(&self) -> Result<(), &'static str> {
        let mut state = self.state.lock().await;
        if let State::Running(task) = &mut *state {
            if let Some(result) = task.poll().await {
                if result.is_ok() && task.is_closed() {
                    *state = State::Idle;
                } else {
                    *state = State::Uncertain;
                    self.handles.poison();
                }
            }
        }
        if matches!(*state, State::Uncertain) {
            return Err("window requires reconciliation");
        }
        Ok(())
    }
    pub(crate) async fn admitted(
        &self,
        browser: &str,
        input: &ExecutionWindowRequest,
        admission: &ExecutionWindowAdmission,
    ) -> Result<(), &'static str> {
        if admission.duplicate {
            return Ok(());
        }
        let mut state = self.state.lock().await;
        if input.window_id.is_some() {
            if !matches!(*state, State::Running(_)) {
                return Err("window transport is unavailable");
            }
            let result = self
                .manager
                .admit(
                    &self.request(input, admission),
                    Instant::now() + Duration::from_secs(5),
                )
                .await
                .map_err(|_| "additional window admission uncertain");
            if result.is_err() {
                *state = State::Uncertain;
                self.handles.poison();
            }
            return result.map(|_| ());
        }
        if !matches!(*state, State::Idle) {
            return Err("window replacement requires exact retirement");
        }
        *state = State::Starting;
        let result = self.open(browser, input, admission).await;
        match result {
            Ok(task) => {
                *state = State::Running(task);
                Ok(())
            }
            Err(error) => {
                *state = State::Uncertain;
                self.handles.poison();
                Err(error)
            }
        }
    }
    fn request(
        &self,
        input: &ExecutionWindowRequest,
        admission: &ExecutionWindowAdmission,
    ) -> Admission {
        let s = &admission.status;
        Admission {
            request_id: input.request_key.clone(),
            window: Window {
                window_id: s.window_id,
                generation: s.generation,
            },
            expected_generation: input.expected_generation,
            input_message_id: input.input_message_id.clone(),
            input_event_id: input.input_event_id.clone(),
            input_request_key: input.input_request_key.clone(),
            predecessor_window_id: input.predecessor_window_id,
            opened_at_ms: s.opened_at_ms,
            work_deadline_ms: s.work_deadline_ms,
            expires_at_ms: s.expires_at_ms,
        }
    }
    async fn open(
        &self,
        browser: &str,
        input: &ExecutionWindowRequest,
        admission: &ExecutionWindowAdmission,
    ) -> Result<WindowTask, &'static str> {
        match self
            .manager
            .status(
                &format!("status:{}", uuid::Uuid::new_v4()),
                Instant::now() + Duration::from_secs(5),
            )
            .await
            .map_err(|_| "manager status unavailable")?
        {
            super::manager_client::ManagerReceipt::Idle {
                owner_id,
                conversation_id,
                ..
            } if owner_id == self.config.owner_id
                && conversation_id == self.config.conversation_id => {}
            super::manager_client::ManagerReceipt::Window(receipt)
                if receipt.owner_id == self.config.owner_id
                    && receipt.conversation_id == self.config.conversation_id
                    && receipt.state == super::manager_client::WindowState::Retired => {}
            _ => return Err("manager prior window is not retired"),
        }
        let ack = self
            .manager
            .admit(
                &self.request(input, admission),
                Instant::now() + Duration::from_secs(5),
            )
            .await
            .map_err(|_| "manager admission uncertain")?;
        if !ack.fresh_window {
            return Err("fresh private issuance requires fresh manager admission");
        }
        let status = &admission.status;
        let boot = ack.receipt.boot_id.to_string();
        let authority = self
            .initial
            .take()
            .await
            .map_err(|_| "private window authority unavailable")?;
        let (bound, credential, metadata, resumed) = match authority {
            WindowAuthority::Initial(cap) => {
                let grant = cap
                    .store()
                    .issue_execution_window_credential(
                        cap.credential(),
                        status.window_id,
                        status.generation,
                        &boot,
                        status.expires_at_ms,
                        &ack.reply_sha256,
                    )
                    .await
                    .map_err(|_| "initial window credential refused")?;
                let bound = cap
                    .store()
                    .bind_execution_window(cap.credential(), &grant)
                    .await
                    .map_err(|_| "initial window binding refused")?;
                let metadata = bound
                    .authorize_session_metadata(cap.binding())
                    .await
                    .map_err(|_| "opening metadata refused")?;
                (bound, grant, metadata, false)
            }
            WindowAuthority::Retired(cap) => {
                let grant = cap
                    .store()
                    .issue_idle_execution_window_credential_authenticated(
                        browser,
                        status.window_id,
                        status.generation,
                        &boot,
                        status.expires_at_ms,
                        &ack.reply_sha256,
                    )
                    .await
                    .map_err(|_| "retired window credential refused")?;
                let config = ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: self.config.namespace.clone(),
                    supervisor_key: self.config.supervisor_key.clone(),
                    takeover: ProductionTakeover::ExpiredPredecessor {
                        incarnation_id: cap.predecessor_incarnation().into(),
                    },
                };
                let (bound, metadata) = self
                    .store
                    .reattach_terminal_supervisor(grant.credential(), config, cap.prior_run_id())
                    .await
                    .map_err(|_| "window predecessor reattachment refused")?;
                (bound, grant, metadata, true)
            }
        };
        let context = Arc::new(Context::new(
            self.manager.clone(),
            self.handles.clone(),
            status,
            boot,
        )?);
        ConfiguredExecution::from_window(
            &self.home,
            &self.config,
            bound,
            credential.credential().to_owned(),
            metadata,
            context,
            resumed,
        )?
        .start_window()
    }
}
