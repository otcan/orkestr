//! In-process first-login authority. Nothing in this module is an HTTP DTO.
use crate::beta_config::BetaConfig;
use orkestr_v2_application::runtime::{
    ProductionSupervisorConfig, ProductionTakeover, ProviderKind, RuntimeStoreError,
};
use orkestr_v2_contracts::{
    ConversationId, ExecutionWindowAdmission, ExecutionWindowRequest, OwnerId,
};
use orkestr_v2_store_sqlite::{ExecutionWindowBootstrap, Store};
use tokio::sync::Mutex;

pub(crate) struct InitialAuthority {
    owner: OwnerId,
    conversation: ConversationId,
    namespace: String,
    supervisor_key: String,
    state: Mutex<State>,
}
enum State {
    Fresh,
    // Set before the async Core call. Cancellation or a lost commit reply must
    // never invoke the initial issuer again in this process.
    Attempted,
    Ready(ExecutionWindowBootstrap),
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
            state: Mutex::new(State::Fresh),
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
        if matches!(*state, State::Fresh) {
            if input.expected_generation != 0
                || input.window_id.is_some()
                || input.predecessor_window_id.is_some()
            {
                return Err(RuntimeStoreError::Fenced);
            }
            *state = State::Attempted;
            let initial = store
                .bootstrap_execution_window_authenticated(
                    browser,
                    conversation,
                    ProductionSupervisorConfig {
                        provider: ProviderKind::Codex,
                        namespace: self.namespace.clone(),
                        supervisor_key: self.supervisor_key.clone(),
                        takeover: ProductionTakeover::First,
                    },
                )
                .await?;
            *state = State::Ready(initial);
        }
        match &*state {
            State::Ready(_) | State::Transferred => {
                store
                    .admit_execution_window_authenticated(browser, conversation, input)
                    .await
            }
            _ => Err(RuntimeStoreError::Fenced),
        }
    }

    /// Move the original capability to the private controller after its manager
    /// ACK. It cannot be cloned, reconstructed on reload, or returned to HTTP.
    pub(crate) async fn take(&self) -> Result<ExecutionWindowBootstrap, RuntimeStoreError> {
        let mut state = self.state.lock().await;
        match std::mem::replace(&mut *state, State::Attempted) {
            State::Ready(initial) => {
                *state = State::Transferred;
                Ok(initial)
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
        let private = initial.take().await.unwrap();
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
}
