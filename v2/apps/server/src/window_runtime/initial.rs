//! In-process first-login authority. Nothing in this module is an HTTP DTO.
use crate::beta_config::BetaConfig;
use orkestr_v2_application::runtime::{
    ProductionSupervisorConfig, ProductionTakeover, ProviderKind, RuntimeStoreError,
};
use orkestr_v2_contracts::{
    ConversationId, ExecutionWindowAdmission, ExecutionWindowRequest, OwnerId,
};
use orkestr_v2_store_sqlite::{ExecutionWindowBootstrap, RetiredExecutionWindowContext, Store};
use tokio::sync::Mutex;

pub(crate) struct InitialAuthority {
    owner: OwnerId,
    conversation: ConversationId,
    namespace: String,
    supervisor_key: String,
    capacity: u32,
    state: Mutex<State>,
    last_request: Mutex<Option<String>>,
}
/// Private controller handoff: each variant retains its original typed context.
/// Neither variant may be serialized or reconstructed from HTTP IDs.
pub(crate) enum WindowAuthority {
    Initial(ExecutionWindowBootstrap),
    Retired(RetiredExecutionWindowContext),
}

enum State {
    Fresh,
    // Set before the async Core call. Cancellation or a lost commit reply must
    // never invoke the initial issuer again in this process.
    Attempted,
    Ready(Box<WindowAuthority>),
    Transferred,
}
impl InitialAuthority {
    pub(crate) fn new(config: &BetaConfig) -> Result<Self, &'static str> {
        config.validate()?;
        Ok(Self {
            owner: config.owner_id.clone(),
            conversation: config.conversation_id.clone(),
            namespace: config.namespace.clone(),
            supervisor_key: config.supervisor_key.clone(),
            capacity: config.active_windows(),
            state: Mutex::new(State::Fresh),
            last_request: Mutex::new(None),
        })
    }

    /// Browser authentication is repeated by Core inside both transactions.
    /// The caller's owner is only an additional configured-scope guard.
    pub(crate) async fn admit(
        &self,
        store: &Store,
        browser: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<ExecutionWindowAdmission, RuntimeStoreError> {
        if owner != &self.owner || conversation != &self.conversation || !input.is_valid() {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut state = self.state.lock().await;
        if matches!(*state, State::Fresh)
            || (matches!(*state, State::Transferred)
                && input.window_id.is_none()
                && self.last_request.lock().await.as_deref() != Some(input.request_key.as_str()))
        {
            if input.window_id.is_some()
                || (input.expected_generation == 0) != input.predecessor_window_id.is_none()
            {
                return Err(RuntimeStoreError::Fenced);
            }
            *state = State::Attempted;
            let config = ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: self.namespace.clone(),
                supervisor_key: self.supervisor_key.clone(),
                takeover: ProductionTakeover::First,
            };
            // Request shape selects a distinct Core port. Never fall back from
            // failed recovery to fresh bootstrap, or from bootstrap to recovery.
            let authority = if input.expected_generation == 0 {
                WindowAuthority::Initial(
                    store
                        .bootstrap_execution_window_authenticated(browser, conversation, config)
                        .await?,
                )
            } else if store
                .execution_window_failed_first_open_authenticated(browser, conversation)
                .await?
            {
                // Every earlier opening was reconciled as failed before it ran
                // anything: there is no retired turn to resume, so bootstrap
                // again. Durable state selects the port, never a refusal.
                WindowAuthority::Initial(
                    store
                        .rebootstrap_execution_window_authenticated(browser, conversation, config)
                        .await?,
                )
            } else {
                WindowAuthority::Retired(
                    store
                        .recover_retired_execution_window_authenticated(
                            browser,
                            conversation,
                            config,
                        )
                        .await?,
                )
            };
            *state = State::Ready(Box::new(authority));
        }
        match &*state {
            State::Ready(_) | State::Transferred => {
                // Core re-checks the owner-wide live-window capacity atomically.
                let admission = store
                    .admit_execution_window_capped_authenticated(
                        browser,
                        conversation,
                        input,
                        self.capacity,
                    )
                    .await?;
                if !admission.duplicate && input.window_id.is_none() {
                    *self.last_request.lock().await = Some(input.request_key.clone());
                }
                Ok(admission)
            }
            _ => Err(RuntimeStoreError::Fenced),
        }
    }

    /// Move the original capability to the private controller after its manager
    /// ACK. It cannot be cloned, reconstructed on reload, or returned to HTTP.
    pub(crate) async fn take(&self) -> Result<WindowAuthority, RuntimeStoreError> {
        let mut state = self.state.lock().await;
        match std::mem::replace(&mut *state, State::Attempted) {
            State::Ready(initial) => {
                *state = State::Transferred;
                Ok(*initial)
            }
            other => {
                *state = other;
                Err(RuntimeStoreError::Fenced)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use orkestr_v2_application::IntakeStore;
    use orkestr_v2_contracts::MessageInput;
    use uuid::Uuid;

    #[tokio::test]
    async fn browser_only_first_login_retains_one_private_capability_and_replays_admission() {
        let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(format!("runtime-first-login-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::open(&root.join("state.sqlite3")).await.unwrap();
        let conversation = store
            .setup("synthetic-owner", "synthetic-hash")
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        store
            .save_session("synthetic-browser", &owner)
            .await
            .unwrap();
        let config: BetaConfig = serde_json::from_value(serde_json::json!({
            "schema_version":1,"owner_id":owner,"conversation_id":conversation,
            "manager_socket":"/run/example/control.sock","launcher":"/opt/example/launcher",
            "launcher_sha256":"a".repeat(64),"workspace":"/srv/example",
            "namespace":"synthetic-beta","supervisor_key":"synthetic-supervisor"
        }))
        .unwrap();
        let initial = InitialAuthority::new(&config).unwrap();
        let intake = store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: "synthetic-input".into(),
                    text: "synthetic input".into(),
                },
            )
            .await
            .unwrap()
            .receipt;
        let input = ExecutionWindowRequest {
            request_key: "synthetic-window".into(),
            input_message_id: intake.message_id,
            input_event_id: intake.event_id,
            input_request_key: "synthetic-input".into(),
            expected_generation: 0,
            window_id: None,
            predecessor_window_id: None,
        };
        assert!(initial
            .admit(&store, "invalid-browser", &owner, &conversation, &input)
            .await
            .is_err());
        // Failed issuance is deliberately not retried by the same local holder.
        assert!(initial
            .admit(&store, "synthetic-browser", &owner, &conversation, &input)
            .await
            .is_err());
        let initial = InitialAuthority::new(&config).unwrap();
        let first = initial
            .admit(&store, "synthetic-browser", &owner, &conversation, &input)
            .await
            .unwrap();
        let replay = initial
            .admit(&store, "synthetic-browser", &owner, &conversation, &input)
            .await
            .unwrap();
        assert!(replay.duplicate);
        assert_eq!(first.status.window_id, replay.status.window_id);
        let WindowAuthority::Initial(private) = initial.take().await.unwrap() else {
            panic!("fresh owner must use initial authority")
        };
        assert_ne!(private.credential(), "synthetic-browser");
        assert!(initial.take().await.is_err());
        assert!(
            initial
                .admit(&store, "synthetic-browser", &owner, &conversation, &input)
                .await
                .unwrap()
                .duplicate
        );
        assert!(store
            .bootstrap_execution_window_authenticated(
                "synthetic-browser",
                &conversation,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: "synthetic-beta".into(),
                    supervisor_key: "synthetic-supervisor".into(),
                    takeover: ProductionTakeover::First
                }
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn failed_first_open_bootstraps_again_instead_of_recovering() {
        use orkestr_v2_contracts::{
            ExecutionWindowReconciliationActor as Actor,
            ExecutionWindowReconciliationDecision as Decision,
        };
        use orkestr_v2_store_sqlite::StrandedExecutionWindow;
        let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(format!("runtime-failed-first-open-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::open(&root.join("state.sqlite3")).await.unwrap();
        let conversation = store
            .setup("synthetic-owner", "synthetic-hash")
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        store
            .save_session("synthetic-browser", &owner)
            .await
            .unwrap();
        let config: BetaConfig = serde_json::from_value(serde_json::json!({
            "schema_version":1,"owner_id":owner,"conversation_id":conversation,
            "manager_socket":"/run/example/control.sock","launcher":"/opt/example/launcher",
            "launcher_sha256":"a".repeat(64),"workspace":"/srv/example",
            "namespace":"synthetic-beta","supervisor_key":"synthetic-supervisor"
        }))
        .unwrap();
        let request = |key: &str, receipt: orkestr_v2_contracts::Receipt| ExecutionWindowRequest {
            request_key: format!("window:{key}"),
            input_message_id: receipt.message_id,
            input_event_id: receipt.event_id,
            input_request_key: key.into(),
            expected_generation: 0,
            window_id: None,
            predecessor_window_id: None,
        };
        let text = |key: &str| MessageInput {
            client_message_id: key.into(),
            text: "synthetic input".into(),
        };
        let first = request(
            "first",
            store
                .admit(&owner, &conversation, &text("first"))
                .await
                .unwrap()
                .receipt,
        );
        let initial = InitialAuthority::new(&config).unwrap();
        let admitted = initial
            .admit(&store, "synthetic-browser", &owner, &conversation, &first)
            .await
            .unwrap();
        let WindowAuthority::Initial(cap) = initial.take().await.unwrap() else {
            panic!("fresh owner must use initial authority")
        };
        let status = admitted.status;
        let grant = cap
            .store()
            .issue_execution_window_credential(
                cap.credential(),
                status.window_id,
                1,
                "synthetic-boot",
                status.expires_at_ms,
                &"a".repeat(64),
            )
            .await
            .unwrap();
        cap.store()
            .bind_execution_window(cap.credential(), &grant)
            .await
            .unwrap();
        // Setup (broker readiness) fails here: no run. A restart reconciles it.
        let fresh = Store::open(&root.join("state.sqlite3")).await.unwrap();
        fresh
            .reconcile_execution_window_authenticated(
                "synthetic-browser",
                &conversation,
                status.window_id,
                1,
            )
            .await
            .unwrap();
        let StrandedExecutionWindow::Pending(plan) = fresh
            .plan_stranded_execution_window_authenticated(
                "synthetic-browser",
                &conversation,
                status.window_id,
                1,
                Decision::AbandonUnaccepted,
                Actor::Owner,
            )
            .await
            .unwrap()
        else {
            panic!("failed open must plan")
        };
        fresh
            .reconcile_stranded_execution_window_authenticated(
                "synthetic-browser",
                &plan,
                Decision::AbandonUnaccepted,
                Actor::Owner,
            )
            .await
            .unwrap();
        let mut next = request(
            "second",
            fresh
                .admit(&owner, &conversation, &text("second"))
                .await
                .unwrap()
                .receipt,
        );
        next.expected_generation = 1;
        next.predecessor_window_id = Some(status.window_id);
        let initial = InitialAuthority::new(&config).unwrap();
        let admitted = initial
            .admit(&fresh, "synthetic-browser", &owner, &conversation, &next)
            .await
            .unwrap();
        assert_eq!(admitted.status.generation, 2);
        let WindowAuthority::Initial(cap) = initial.take().await.unwrap() else {
            panic!("no retired turn exists: bootstrap again, never recover")
        };
        cap.store()
            .issue_execution_window_credential(
                cap.credential(),
                admitted.status.window_id,
                2,
                "synthetic-boot-2",
                admitted.status.expires_at_ms,
                &"b".repeat(64),
            )
            .await
            .unwrap();
    }
}
