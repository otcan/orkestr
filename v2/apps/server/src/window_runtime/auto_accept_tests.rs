//! Owner auto-acceptance against a real Store: a committed Deep proposal is
//! accepted unless the conversation asks to review it. No provider runs.
use super::*;
use crate::{
    beta_config::BetaConfig,
    window_runtime::{handles::Handles, initial::InitialAuthority, manager_client::ManagerClient},
};
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{
    ConversationProvider, ConversationSettingsUpdate, MessageInput, OwnerId, RunId,
};
use orkestr_v2_store_sqlite::Store;
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

const BROWSER: &str = "synthetic-auto-accept-browser";

struct Fixture {
    root: std::path::PathBuf,
    store: Store,
    owner: OwnerId,
    home: ConversationId,
    run: RunId,
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
        run: p.run.run_id.clone(),
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
    async fn review(&self) {
        let update = ConversationSettingsUpdate {
            expected_revision: 0,
            provider: ConversationProvider::Codex,
            model: None,
            reasoning_effort: None,
            honor_no_reply: true,
            reply_prefix: None,
            reply_footer: None,
            review_before_accepting: true,
        };
        self.store
            .update_conversation_settings(BROWSER, &self.owner, &self.home, &update)
            .await
            .unwrap();
    }
    async fn status(&self) -> ExecutionStatus {
        self.store
            .execution_status(&self.owner, &self.home)
            .await
            .unwrap()
            .unwrap()
    }
    async fn finish(self) {
        self.store.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

#[tokio::test]
async fn default_settings_accept_the_pending_deep_proposal_once() {
    let f = proposal().await;
    let controller = f.controller();
    let pending = f.status().await;
    assert_eq!(pending.phase, ExecutionPhase::AwaitingAcceptance);
    let expected = acceptance(&f.home, &pending).unwrap();
    assert_eq!(
        controller.auto_accept_conversation(BROWSER, &f.home).await,
        1
    );
    assert_eq!(f.phase().await, ExecutionPhase::Completed);
    // The committed decision carries the deterministic key: it replays.
    let replay = f
        .store
        .accept_execution_authenticated(BROWSER, &f.home, &expected)
        .await
        .unwrap();
    assert_eq!(replay.run_id, f.run);
    assert_eq!(replay.request_key, request_key(&f.run));
    // Nothing left to accept: a later pass is a no-op.
    assert_eq!(
        controller.auto_accept_conversation(BROWSER, &f.home).await,
        0
    );
    f.finish().await;
}

#[tokio::test]
async fn review_before_accepting_leaves_the_proposal_for_the_owner() {
    let f = proposal().await;
    f.review().await;
    let controller = f.controller();
    assert_eq!(
        controller.auto_accept_conversation(BROWSER, &f.home).await,
        0
    );
    assert_eq!(f.phase().await, ExecutionPhase::AwaitingAcceptance);
    // A manual owner decision still works.
    let manual = acceptance(&f.home, &f.status().await).unwrap();
    f.store
        .accept_execution_authenticated(BROWSER, &f.home, &manual)
        .await
        .unwrap();
    assert_eq!(f.phase().await, ExecutionPhase::Completed);
    f.finish().await;
}

#[tokio::test]
async fn without_a_remembered_or_valid_session_nothing_is_accepted() {
    let f = proposal().await;
    let controller = f.controller();
    // No browser credential remembered: the periodic pass does nothing.
    controller.auto_accept_once().await;
    assert_eq!(
        controller
            .auto_accept_conversation("synthetic-unknown-browser", &f.home)
            .await,
        0
    );
    assert_eq!(f.phase().await, ExecutionPhase::AwaitingAcceptance);
    f.finish().await;
}

#[test]
fn only_awaiting_proposals_without_failure_qualify() {
    let conversation = ConversationId(Uuid::from_u128(1));
    let run = RunId(Uuid::from_u128(2));
    let mut status: ExecutionStatus = serde_json::from_value(serde_json::json!({
        "schema_version": 1, "conversation_id": conversation, "run_id": run,
        "revision": 7, "observed_at_ms": 1, "phase": "awaiting_acceptance",
        "acceptance_candidate": {"run_id": run, "completion_event_id": Uuid::from_u128(3)},
        "queue_age_ms": null, "progress": null, "resources": null,
        "capabilities": {"stop": false, "steer": false}
    }))
    .unwrap();
    let request = acceptance(&conversation, &status).unwrap();
    assert_eq!(request.expected_revision, 7);
    assert_eq!(request.request_key, format!("auto-accept:{run}"));
    assert!(acceptance(&ConversationId(Uuid::from_u128(9)), &status).is_none());
    status.phase = ExecutionPhase::Failed;
    assert!(acceptance(&conversation, &status).is_none());
    status.phase = ExecutionPhase::Completed;
    assert!(acceptance(&conversation, &status).is_none());
}
