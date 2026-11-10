//! Independent ordinary-store authority tests; no fixture bootstrap or private context.
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{ConversationId, MessageInput, OwnerId};
use orkestr_v2_store_sqlite::{ExecutionConsumption, Store};

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_browser_acceptance_http_matrix() {
    let (c, h, p) = active().await;
    let completion = h
        .append_provider_event(
            &c.owner,
            &p,
            &event(&p, 2, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    let status = c
        .store
        .execution_status(&c.owner, &c.conversation)
        .await
        .unwrap()
        .unwrap();
    let cookie = "ef".repeat(32);
    c.store
        .save_session(&format!("browser:{cookie}"), &c.owner)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:47140")
        .await
        .unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let state = orkestr_v2_server::AppState::new(
        c.store.clone(),
        "synthetic-bootstrap-at-least-32-bytes".into(),
        origin.clone(),
    )
    .unwrap()
    .with_execution_store(h);
    let task = tokio::spawn(async move {
        axum::serve(listener, orkestr_v2_server::router(state))
            .await
            .unwrap();
    });
    let config = serde_json::json!({"origin":origin,"database":c.root.join("core.sqlite3"),"cookie":cookie,"conversation":c.conversation,"run":p.run.run_id,"completion":completion.event_id,"revision":status.revision});
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../acceptance/production_acceptance_http.py");
    let result = tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let mut child = std::process::Command::new("python3")
            .arg(script)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(config.to_string().as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    })
    .await
    .unwrap();
    task.abort();
    let _ = task.await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    println!("{}", String::from_utf8_lossy(&result.stdout));
    c.store.close().await;
}
