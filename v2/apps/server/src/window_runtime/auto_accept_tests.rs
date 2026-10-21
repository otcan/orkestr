//! The server pass holds no authority of its own: without a live local window
//! task (and so without the window-bound Core handle) nothing is accepted,
//! even with a remembered browser session. The window principal's decisions
//! are covered by the store's `auto_accept_window_proposals` tests and the
//! real-HTTP `service_auto_accept_http.py` scenario. No provider runs.
use super::*;
use crate::{
    beta_config::BetaConfig,
    window_runtime::{handles::Handles, initial::InitialAuthority, manager_client::ManagerClient},
};
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{ConversationId, ExecutionPhase, MessageInput, OwnerId};
use orkestr_v2_store_sqlite::Store;
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

const BROWSER: &str = "synthetic-auto-accept-browser";

struct Fixture {
    root: std::path::PathBuf,
    store: Store,
    owner: OwnerId,
    home: ConversationId,
}

/// One Deep run of the configured conversation, committed as a proposal.
async fn proposal() -> Fixture {
    let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(format!("auto-accept-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let home = store.setup("owner", "synthetic-hash").await.unwrap();
    let owner = store.credentials("owner").await.unwrap().unwrap().0;
    let machine = "ad".repeat(32);
    store.save_session(&machine, &owner).await.unwrap();
    store.save_session(BROWSER, &owner).await.unwrap();
    let bound = store
        .authorize_supervisor(
            &machine,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "synthetic-auto-accept".into(),
                supervisor_key: "synthetic-deep".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let binding = bound
        .ensure_role_bindings(&owner, &home)
        .await
        .unwrap()
        .deep;
    let binding = bound
        .confirm_native_session(NativeSessionConfirmation {
            session_id: binding.session_id,
            expected_generation: binding.generation,
            native_session_id: "synthetic-auto-accept-native".into(),
            protocol_version: "codex-rpc-1".into(),
            source_event_key: "ready:1".into(),
        })
        .await
        .unwrap();
    store
        .admit(
            &owner,
            &home,
            &MessageInput {
                client_message_id: "input:1".into(),
                text: "synthetic input".into(),
            },
        )
        .await
        .unwrap();
    let claim = bound
        .claim_next(&owner, &home, &binding.session_id, Duration::from_secs(60))
        .await
        .unwrap()
        .unwrap();
    let admission = bound
        .admit_run(&claim, &binding.session_id, binding.generation, "run:1")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reserved) = bound
        .claim_provider_dispatch(&admission, "reserve:1")
        .await
        .unwrap()
    else {
        panic!("fresh reservation required")
    };
    bound.consume_execution(&reserved).await.unwrap();
    let p = &admission.provider;
    for (sequence, event) in [
        (1, ProviderEvent::Started),
        (2, ProviderEvent::CompletedProposal { synthetic: false }),
    ] {
        bound
            .append_provider_event(
                &owner,
                p,
                &ProviderEventInput {
                    run_id: p.run.run_id.clone(),
                    session_id: p.run.session_id.clone(),
                    lease_generation: p.run.lease_generation,
                    dispatch_fence: p.run.dispatch_fence,
                    sequence,
                    event,
                },
            )
            .await
            .unwrap();
    }
    Fixture {
        root,
        store,
        owner,
        home,
    }
}

impl Fixture {
    fn controller(&self) -> Controller {
        let config: BetaConfig = serde_json::from_value(serde_json::json!({
            "schema_version":1,"owner_id":self.owner,"conversation_id":self.home,
            "manager_socket":self.root.join("absent-manager.sock"),"launcher":"/opt/synthetic/launcher",
            "launcher_sha256":"a".repeat(64),"workspace":"/srv/synthetic/workspace",
            "namespace":"synthetic-native","supervisor_key":"synthetic-supervisor"
        }))
        .unwrap();
        let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
        let parent = stat.rsplit_once(')').unwrap().1.split_whitespace().nth(1);
        let manager = ManagerClient::new(
            config.manager_socket.clone(),
            self.owner.clone(),
            self.home.clone(),
            parent.unwrap().parse().unwrap(),
        )
        .unwrap();
        Controller::new(
            config.clone(),
            self.root.clone(),
            self.store.clone(),
            Arc::new(InitialAuthority::new(&config).unwrap()),
            Handles::new(self.owner.clone(), self.home.clone()).unwrap(),
            manager,
        )
    }
    async fn phase(&self) -> ExecutionPhase {
        self.store
            .execution_status(&self.owner, &self.home)
            .await
            .unwrap()
            .unwrap()
            .phase
    }
    async fn finish(self) {
        self.store.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

#[tokio::test]
async fn without_a_live_local_window_nothing_is_accepted() {
    let f = proposal().await;
    let controller = f.controller();
    assert_eq!(f.phase().await, ExecutionPhase::AwaitingAcceptance);
    assert_eq!(controller.auto_accept_once().await, 0);
    // A remembered owner session grants the pass nothing either.
    controller.queue.remember(BROWSER);
    assert_eq!(controller.auto_accept_once().await, 0);
    assert_eq!(f.phase().await, ExecutionPhase::AwaitingAcceptance);
    f.finish().await;
}
