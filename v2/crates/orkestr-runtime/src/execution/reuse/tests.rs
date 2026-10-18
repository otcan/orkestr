//! Actual broker/FD transport with a fixed synthetic executable and ordinary Core.
use super::*;
use crate::containment::ChildDirectories;
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{
    ConversationId, ExecutionAcceptanceRequest, ExecutionPhase, MessageInput, OwnerId,
};
use orkestr_v2_store_sqlite::ExecutionConsumption;
use std::{
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    time::{Duration, Instant},
};

struct Case {
    root: PathBuf,
    store: Store,
    bound: Store,
    owner: OwnerId,
    conversation: ConversationId,
}
impl Case {
    async fn new(label: &str) -> Self {
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(format!("owned-reuse-{}-{label}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for name in ["workspace", "home", "tmp"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        let root = root.canonicalize().unwrap();
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
        let token = "ab".repeat(32);
        store.save_session(&token, &owner).await.unwrap();
        let bound = store
            .authorize_supervisor(
                &token,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: "subscription:synthetic".into(),
                    supervisor_key: "synthetic-reuse".into(),
                    takeover: ProductionTakeover::First,
                },
            )
            .await
            .unwrap();
        Self {
            root,
            store,
            bound,
            owner,
            conversation,
        }
    }
    async fn ready(&self) -> ReadyCodex {
        let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap();
        let native = self.root.join("synthetic-native");
        std::fs::copy(repository.join("tests/owned_execution_peer.py"), &native).unwrap();
        std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = self.root.join("synthetic-private.json");
        std::fs::write(
            &config,
            json!({"codex_executable":native,"codex_home":self.root.join("home"),
            "workspace":self.root.join("workspace"),"home":self.root.join("home"),
            "temporary":self.root.join("tmp")})
            .to_string(),
        )
        .unwrap();
        let launcher = self.root.join("synthetic-launcher");
        std::fs::write(&launcher, format!("#!/usr/bin/python3\nimport sys\nsys.path.insert(0,{})\nfrom server import main\nraise SystemExit(main({}))\n",
            serde_json::to_string(&repository.join("provider-broker")).unwrap(), serde_json::to_string(&config).unwrap())).unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
        let binding = self
            .bound
            .ensure_role_bindings(&self.owner, &self.conversation)
            .await
            .unwrap()
            .deep;
        let grant = self
            .bound
            .authorize_session_metadata(&binding)
            .await
            .unwrap();
        let directories = ChildDirectories::new(
            &self.root.join("workspace"),
            &self.root.join("home"),
            &self.root.join("tmp"),
        )
        .unwrap();
        let mut preparing = PreparingCodex::open(
            self.bound.clone(),
            grant,
            &launcher,
            &self.root.join("workspace"),
            directories,
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !preparing.poll().unwrap() {
            assert!(
                Instant::now() < deadline,
                "bounded synthetic metadata setup"
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        preparing.confirm().await.unwrap()
    }
    async fn claim(&self, number: u8) -> (Binding, InboxClaim) {
        self.store
            .admit(
                &self.owner,
                &self.conversation,
                &MessageInput {
                    client_message_id: format!("synthetic:{number}"),
                    text: format!(
                        "synthetic ordinary HTTP input{}",
                        if number == 1 {
                            String::new()
                        } else {
                            format!(" {number}")
                        }
                    ),
                },
            )
            .await
            .unwrap();
        let binding = self
            .bound
            .ensure_role_bindings(&self.owner, &self.conversation)
            .await
            .unwrap()
            .deep;
        let claim = self
            .bound
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
    async fn consume(
        &self,
        binding: &Binding,
        claim: &InboxClaim,
        number: u8,
    ) -> Box<ConsumedProviderDispatch> {
        let key = format!("synthetic-run:{number}");
        let candidate = self
            .bound
            .admit_run(claim, &binding.session_id, binding.generation, &key)
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(reservation) = self
            .bound
            .claim_provider_dispatch(&candidate, &key)
            .await
            .unwrap()
        else {
            panic!("fresh reservation");
        };
        let ExecutionConsumption::Dispatch(capability) =
            self.bound.consume_execution(&reservation).await.unwrap()
        else {
            panic!("fresh consumption");
        };
        assert!(matches!(
            self.bound.consume_execution(&reservation).await.unwrap(),
            ExecutionConsumption::ReconciliationRequired
        ));
        capability
    }
    async fn complete(&self, pump: &mut CodexPump) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            pump.flush().unwrap();
            pump.step(&self.bound).await.unwrap();
            let status = self
                .store
                .execution_status(&self.owner, &self.conversation)
                .await
                .unwrap()
                .unwrap();
            if status.phase == ExecutionPhase::AwaitingAcceptance {
                break;
            }
            assert!(Instant::now() < deadline, "bounded synthetic completion");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        assert!(pump.pending().is_none());
    }
    async fn accept(&self, number: u8) {
        let status = self
            .store
            .execution_status(&self.owner, &self.conversation)
            .await
            .unwrap()
            .unwrap();
        let candidate = status.acceptance_candidate.unwrap();
        self.store
            .accept_execution(
                &self.owner,
                &self.conversation,
                &ExecutionAcceptanceRequest {
                    run_id: candidate.run_id,
                    completion_event_id: candidate.completion_event_id,
                    expected_revision: status.revision,
                    request_key: format!("synthetic-accept:{number}"),
                },
            )
            .await
            .unwrap();
    }
    fn trace(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(self.root.join("workspace/synthetic-peer.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    async fn cleanup(self) {
        let pid = self.trace()[0]["pid"].as_u64().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while std::path::Path::new(&format!("/proc/{pid}")).exists() {
            assert!(
                Instant::now() < deadline,
                "owned synthetic child must be reaped"
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        drop(self.bound);
        drop(self.store);
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

async fn exercise(cancel_before_transfer: bool) {
    let case = Case::new(if cancel_before_transfer {
        "cancel"
    } else {
        "accepted"
    })
    .await;
    let ready = case.ready().await;
    let (binding, claim) = case.claim(1).await;
    let capability = case.consume(&binding, &claim, 1).await;
    let (old_authority, mut pump) = ready.attach(case.bound.clone(), capability).unwrap();
    case.complete(&mut pump).await;

    // A completion proposal cannot issue a later run before owner acceptance.
    let (busy, next_claim) = case.claim(2).await;
    assert_eq!(busy.state, SessionState::Busy);
    assert!(case
        .bound
        .admit_run(
            &next_claim,
            &busy.session_id,
            busy.generation,
            "premature-run"
        )
        .await
        .is_err());
    case.accept(1).await;
    let next_binding = case
        .bound
        .ensure_role_bindings(&case.owner, &case.conversation)
        .await
        .unwrap()
        .deep;
    assert_eq!(next_binding.generation, busy.generation + 1);
    let capability = case.consume(&next_binding, &next_claim, 2).await;
    if cancel_before_transfer {
        case.bound
            .request_cancel(
                &case.owner,
                &capability.provider().run.run_id,
                "synthetic-before-transfer",
            )
            .await
            .unwrap();
        assert!(pump.attach_next(case.bound.clone(), capability).is_err());
        assert_eq!(
            case.trace()
                .iter()
                .filter(|row| row["kind"] == "turn")
                .count(),
            1
        );
    } else {
        let (authority, mut next) = pump.attach_next(case.bound.clone(), capability).unwrap();
        // A retained authority for the completed turn must never kill this turn.
        old_authority.revoke().unwrap();
        old_authority.revoke().unwrap();
        case.complete(&mut next).await;
        case.accept(2).await;
        let trace = case.trace();
        assert_eq!(trace.iter().filter(|row| row["kind"] == "spawn").count(), 1);
        assert_eq!(trace.iter().filter(|row| row["kind"] == "ready").count(), 1);
        assert_eq!(trace.iter().filter(|row| row["kind"] == "turn").count(), 2);
        assert!(trace.iter().all(|row| row["pid"] == trace[0]["pid"]));
        authority.revoke().unwrap();
        drop(next);
    }
    drop(old_authority);
    case.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_new_capability_transfers_same_child_and_retires_old_authority() {
    exercise(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_before_transfer_refuses_new_bytes_and_quarantines_owned_child() {
    exercise(true).await;
}
