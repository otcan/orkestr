//! Serialized private admission-to-task handoff; receipts alone never launch.
use super::{
    context::Context,
    handles::Handles,
    initial::{InitialAuthority, WindowAuthority},
    manager_client::{Admission, ManagerClient, Window},
};
use crate::{
    beta_config::BetaConfig,
    owned_execution::{ConfiguredExecution, WindowSetup, WindowTask},
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
    /// Last immediate reconciliation attempt of a released window (spacing).
    released_attempt: std::sync::Mutex<Option<Instant>>,
}
/// Spacing of immediate reconciliation attempts for one released window.
const RELEASED_RETRY: Duration = Duration::from_secs(10);
mod state;
use state::State;
impl ConversationController {
    pub(super) fn handles(&self) -> &Handles {
        &self.handles
    }
    /// This process's task for the window ended and every original child was
    /// reaped (or it never ran one): nothing local can still use the window.
    pub(super) async fn custody_released(&self) -> bool {
        matches!(&*self.state.lock().await, State::Released)
    }
    /// At most one immediate reconciliation attempt per `RELEASED_RETRY`.
    pub(super) fn released_attempt_due(&self) -> bool {
        let Ok(mut last) = self.released_attempt.lock() else {
            return false;
        };
        let now = Instant::now();
        if last.is_some_and(|at| now.saturating_duration_since(at) < RELEASED_RETRY) {
            return false;
        }
        *last = Some(now);
        true
    }
    /// A task this process started (or is starting) may still own the window.
    pub(super) async fn has_local_task(&self) -> bool {
        matches!(
            &*self.state.lock().await,
            State::Starting | State::Running(_)
        )
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
            released_attempt: std::sync::Mutex::new(None),
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
            .map_err(|error| {
                // Closed local enum only; no provider body, credential or SQL text.
                let cause = match error {
                    orkestr_v2_application::runtime::RuntimeStoreError::Busy => "capacity",
                    orkestr_v2_application::runtime::RuntimeStoreError::Fenced => "fenced",
                    orkestr_v2_application::runtime::RuntimeStoreError::Unauthorized => {
                        "unauthorized"
                    }
                    orkestr_v2_application::runtime::RuntimeStoreError::Conflict => "conflict",
                    _ => "unavailable",
                };
                eprintln!("window admission refused: conversation={conversation} cause={cause}");
                "window admission refused"
            })?;
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
                    State::Idle
                        | State::Uncertain
                        | State::Starting
                        | State::Released
                        | State::Reaping(_)
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
                let mut state = self.state.lock().await;
                if matches!(*state, State::Idle | State::Released) {
                    *state = State::Released;
                } else if !matches!(*state, State::Reaping(_)) {
                    *state = State::Uncertain;
                }
                self.handles.poison();
                return Ok(Some(status));
            }
            return Ok(Some(status));
        }
        Ok(None)
    }
    /// Capacity pressure only: retire this conversation's live window when every
    /// role is accepted and Core shows no pending input, run or descendant (the
    /// former conversation-switch precondition). The operation lock keeps any
    /// follow-up admission from interleaving between the check and the stop.
    pub(super) async fn retire_if_idle(&self, browser: &str) -> Result<bool, &'static str> {
        let _operation = self.operation.lock().await;
        self.refresh().await?;
        let mut state = self.state.lock().await;
        let State::Running(task) = &mut *state else {
            return Ok(false);
        };
        if !task.roles_ready_to_close()
            || !self
                .store
                .execution_window_switch_ready_authenticated(browser, &self.config.conversation_id)
                .await
                .unwrap_or(false)
        {
            return Ok(false);
        }
        Self::stop_task(&self.handles, &mut state).await
    }
    /// Ok(true): retired. Ok(false): not retirable (for example proposals still
    /// await acceptance) but every original child is reaped, so the window is
    /// durably left for audited reconciliation. Err: custody is uncertain.
    async fn stop_task(handles: &Handles, state: &mut State) -> Result<bool, &'static str> {
        let State::Running(task) = state else {
            return Ok(false);
        };
        let deadline = task
            .cleanup_deadline()
            .min(tokio::time::Instant::now() + Duration::from_secs(30));
        let result = task.stop_until(deadline).await;
        if result.is_ok() && task.is_closed() {
            *state = State::Idle;
            return Ok(true);
        }
        let released = task.custody_released(deadline).await;
        handles.poison();
        if released {
            *state = State::Released;
            return Ok(false);
        }
        *state = State::Reaping(task.cleanup_accounting());
        Err("window shutdown is not proven retirement")
    }
    pub(crate) async fn shutdown(&self) -> Result<(), &'static str> {
        let _operation = self.operation.lock().await;
        // Observe completed retirement before applying a live cleanup deadline.
        let _ = self.refresh().await;
        let mut state = self.state.lock().await;
        if matches!(*state, State::Running(_)) {
            return Self::stop_task(&self.handles, &mut state).await.map(|_| ());
        }
        if matches!(*state, State::Idle | State::Released) {
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
                    let released = task.custody_released(tokio::time::Instant::now()).await;
                    *state = if released {
                        State::Released
                    } else {
                        State::Reaping(task.cleanup_accounting())
                    };
                    self.handles.poison();
                }
            }
        }
        state.refresh_reaping().await;
        if matches!(
            *state,
            State::Uncertain | State::Released | State::Reaping(_)
        ) {
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
            // Core already holds this follow-up in the live window. A manager
            // answer about the follow-up never ends that window: replacing the
            // running task here would abort a healthy Deep (no cleanup, egress
            // left owned) and strand the input until the hard deadline.
            let ack = if matches!(*state, State::Running(_)) {
                join_ack(
                    self.manager
                        .admit(
                            &self.request(input, admission),
                            Instant::now() + Duration::from_secs(5),
                        )
                        .await
                        .map(|_| ()),
                )
            } else {
                JoinAck::Withdraw
            };
            drop(state);
            return match ack {
                JoinAck::Joined => Ok(()),
                // The manager may have recorded it; Core's join is durable and
                // the live Deep claims it like any other window input.
                JoinAck::KeepJoined => {
                    eprintln!("window follow-up kept without manager acknowledgement");
                    Ok(())
                }
                // Nothing here can run it: hand it back to ordinary admission
                // (the caller retries and reaches this window's successor).
                JoinAck::Withdraw => match self
                    .store
                    .withdraw_unstarted_window_join_authenticated(
                        browser,
                        &self.config.conversation_id,
                        input,
                    )
                    .await
                {
                    Ok(true) => Err("window follow-up refused; input awaits the next window"),
                    Ok(false) => Ok(()),
                    Err(_) => Err("window follow-up refused; withdrawal unavailable"),
                },
            };
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
        // Core refuses a provider change while this window exists.
        let (owner, conversation) = (&self.config.owner_id, &self.config.conversation_id);
        let launch = self
            .store
            .conversation_turn_launch(owner, conversation)
            .await
            .map_err(|_| "conversation settings unavailable")?;
        let native = self
            .store
            .conversation_native_provider(owner, conversation)
            .await
            .map_err(|_| "conversation native provider unavailable")?;
        let provider = self.config.window_provider(&launch, native)?;
        let claude = provider == ProviderKind::Claude;
        let authority = self
            .initial
            .take()
            .await
            .map_err(|_| "private window authority unavailable")?;
        let (bound, credential, metadata, workspace) = match authority {
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
                let workspace = match self.config.workspace_profile().filter(|_| !claude) {
                    Some(profile) => {
                        let installation =
                            profile.installation(&self.home, self.native_workspaces())?;
                        let workspace = bound
                            .register_workspace(
                                grant.credential(),
                                &self.config.conversation_id,
                                profile.project_id,
                                installation,
                            )
                            .await
                            .map_err(|_| "initial workspace registration refused")?;
                        bound
                            .bind_workspace_session(grant.credential(), &workspace, cap.binding())
                            .await
                            .map_err(|_| "initial workspace binding refused")?;
                        Some(Arc::new(workspace))
                    }
                    None => None,
                };
                let metadata = bound
                    .authorize_session_metadata(cap.binding())
                    .await
                    .map_err(|_| "opening metadata refused")?;
                (bound, grant, metadata, workspace)
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
                    provider,
                    namespace: self.config.namespace.clone(),
                    supervisor_key: self.config.supervisor_key.clone(),
                    takeover: ProductionTakeover::ExpiredPredecessor {
                        incarnation_id: cap.predecessor_incarnation().into(),
                    },
                };
                let (bound, metadata, workspace) =
                    match self.config.workspace_profile().filter(|_| !claude) {
                        Some(profile) => {
                            let installation =
                                profile.installation(&self.home, self.native_workspaces())?;
                            let (bound, metadata, workspace) = self
                                .store
                                .reattach_terminal_supervisor_with_workspace(
                                    grant.credential(),
                                    config,
                                    cap.prior_run_id(),
                                    profile.project_id,
                                    installation,
                                )
                                .await
                                .map_err(|_| "window workspace reattachment refused")?;
                            (bound, metadata, Some(Arc::new(workspace)))
                        }
                        None => {
                            let (bound, metadata) = self
                                .store
                                .reattach_terminal_supervisor(
                                    grant.credential(),
                                    config,
                                    cap.prior_run_id(),
                                )
                                .await
                                .map_err(|_| "window predecessor reattachment refused")?;
                            (bound, metadata, None)
                        }
                    };
                (bound, grant, metadata, workspace)
            }
        };
        let context = Arc::new(Context::new(
            self.manager.clone(),
            self.handles.clone(),
            status,
            boot,
            self.config.window_max_lifetime_ms(),
        )?);
        ConfiguredExecution::from_window(
            &self.home,
            &self.config,
            provider,
            WindowSetup {
                store: bound,
                token: credential.credential().to_owned(),
                metadata,
                workspace,
            },
            context,
        )
        .await?
        .start_window()
    }

    fn native_workspaces(&self) -> impl Iterator<Item = PathBuf> + '_ {
        std::iter::once(self.config.workspace.clone()).chain(
            self.config
                .roles
                .iter()
                .flat_map(|roles| roles.launches())
                .map(|role| role.workspace.clone()),
        )
    }
}

/// What a follow-up's manager admission means for its Core join.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JoinAck {
    Joined,
    /// The manager answered but its record is unknown: keep the durable join.
    KeepJoined,
    /// The manager certainly recorded nothing (refused, or never sent).
    Withdraw,
}
fn join_ack(result: Result<(), super::manager_client::ManagerError>) -> JoinAck {
    use super::manager_client::ManagerError;
    match result {
        Ok(()) => JoinAck::Joined,
        Err(ManagerError::Refused | ManagerError::InvalidRequest) => JoinAck::Withdraw,
        Err(_) => JoinAck::KeepJoined,
    }
}

#[cfg(test)]
mod join_ack_tests {
    use super::super::manager_client::ManagerError;
    use super::*;

    #[test]
    fn a_refused_follow_up_is_withdrawn_and_an_unknown_answer_keeps_the_join() {
        assert_eq!(join_ack(Ok(())), JoinAck::Joined);
        assert_eq!(join_ack(Err(ManagerError::Refused)), JoinAck::Withdraw);
        assert_eq!(
            join_ack(Err(ManagerError::InvalidRequest)),
            JoinAck::Withdraw
        );
        for unknown in [
            ManagerError::Deadline,
            ManagerError::Unavailable,
            ManagerError::Protocol,
            ManagerError::Peer,
        ] {
            assert_eq!(join_ack(Err(unknown)), JoinAck::KeepJoined);
        }
    }
}
