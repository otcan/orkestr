//! Independent ordinary-store authority tests; no fixture bootstrap or private context.
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{ConversationId, MessageInput, OwnerId};
use orkestr_v2_store_sqlite::{ExecutionConsumption, Store};
use sqlx::{Connection, Row};

use std::{path::PathBuf, time::Duration};
use uuid::Uuid;
struct Case {
    root: PathBuf,
    store: Store,
    owner: OwnerId,
    conversation: ConversationId,
}
fn config() -> ProductionSupervisorConfig {
    ProductionSupervisorConfig {
        provider: ProviderKind::Codex,
        namespace: "synthetic-local".into(),
        supervisor_key: "independent".into(),
        takeover: ProductionTakeover::First,
    }
}
impl Case {
    async fn new() -> Self {
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"))
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let conversation = store
            .setup("synthetic-owner", "synthetic-test-hash")
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        store.save_session(&token, &owner).await.unwrap();
        Self {
            root,
            store,
            owner,
            conversation,
        }
    }
    async fn ready_claim(&self, handle: &Store) -> (Binding, InboxClaim) {
        let roles = handle
            .ensure_role_bindings(&self.owner, &self.conversation)
            .await
            .unwrap();
        let binding = handle
            .confirm_native_session(NativeSessionConfirmation {
                session_id: roles.deep.session_id,
                expected_generation: roles.deep.generation,
                native_session_id: "synthetic-independent-native".into(),
                protocol_version: "synthetic-v1".into(),
                source_event_key: "ready:1".into(),
            })
            .await
            .unwrap();
        self.store
            .admit(
                &self.owner,
                &self.conversation,
                &MessageInput {
                    client_message_id: "input:1".into(),
                    text: "durable synthetic input".into(),
                },
            )
            .await
            .unwrap();
        let claim = handle
            .claim_next(
                &self.owner,
                &self.conversation,
                &binding.session_id,
                Duration::from_secs(60),
            )
            .await
            .unwrap()
            .unwrap();
        (binding, claim)
    }
}

const TOKEN: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
fn event(p: &ProviderAdmission, sequence: u64, event: ProviderEvent) -> ProviderEventInput {
    ProviderEventInput {
        run_id: p.run.run_id.clone(),
        session_id: p.run.session_id.clone(),
        sequence,
        lease_generation: p.run.lease_generation,
        dispatch_fence: p.run.dispatch_fence,
        event,
    }
}
async fn active() -> (Case, Store, ProviderAdmission) {
    let c = Case::new().await;
    c.store.save_session(TOKEN, &c.owner).await.unwrap();
    let h = c.store.authorize_supervisor(TOKEN, config()).await.unwrap();
    let (b, claim) = c.ready_claim(&h).await;
    let run = h
        .admit_run(&claim, &b.session_id, b.generation, "independent-payload:1")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(r) =
        h.claim_provider_dispatch(&run, "dispatch:1").await.unwrap()
    else {
        panic!("fresh dispatch")
    };
    assert!(matches!(
        h.consume_execution(&r).await.unwrap(),
        ExecutionConsumption::Dispatch(_)
    ));
    h.append_provider_event(
        &c.owner,
        &run.provider,
        &event(&run.provider, 1, ProviderEvent::Started),
    )
    .await
    .unwrap();
    (c, h, run.provider)
}

#[path = "production_owner_acceptance/cases.rs"]
mod acceptance;
#[path = "production_owner_acceptance/oracle.rs"]
mod oracle;
