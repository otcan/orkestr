//! Capacity fallback through the actual broker with a synthetic native peer
//! and ordinary Core. No real provider or credentials.
use super::*;
use crate::{capacity_fallback::CapacityFallback, containment::ChildDirectories};
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{
    ConversationId, ExecutionFailureClass, ExecutionPhase, ExecutionStatus, MessageInput, OwnerId,
};
use orkestr_v2_store_sqlite::{ExecutionConsumption, Store};
use std::{
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    time::{Duration, Instant},
};

const INPUT: &str = "synthetic capacity input";

struct Case {
    root: PathBuf,
    store: Store,
    bound: Store,
    owner: OwnerId,
    conversation: ConversationId,
}

impl Case {
    async fn new(label: &str, mode: &str) -> Self {
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(format!("capacity-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for name in ["workspace", "home", "tmp"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        let root = root.canonicalize().unwrap();
        std::fs::write(root.join("workspace/capacity-mode"), mode).unwrap();
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
                    supervisor_key: "synthetic-capacity".into(),
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
        std::fs::copy(repository.join("tests/capacity_peer.py"), &native).unwrap();
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
        std::fs::write(&launcher, format!("#!/usr/bin/python3\nimport sys\nsys.dont_write_bytecode = True\nsys.path.insert(0,{})\nfrom server import main\nraise SystemExit(main({}))\n",
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
            assert!(Instant::now() < deadline, "bounded synthetic setup");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        preparing.confirm().await.unwrap()
    }

    async fn consume(&self) -> Box<ConsumedProviderDispatch> {
        self.store
            .admit(
                &self.owner,
                &self.conversation,
                &MessageInput {
                    client_message_id: "synthetic:capacity".into(),
                    text: INPUT.into(),
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
        let candidate = self
            .bound
            .admit_run(
                &claim,
                &binding.session_id,
                binding.generation,
                "run:capacity",
            )
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(reservation) = self
            .bound
            .claim_provider_dispatch(&candidate, "reserve:capacity")
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
        capability
    }

    async fn settle(&self, pump: &mut CodexPump) -> ExecutionStatus {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if pump.pending().is_none() {
                pump.flush().unwrap();
            }
            pump.step(&self.bound).await.unwrap();
            let status = self
                .store
                .execution_status(&self.owner, &self.conversation)
                .await
                .unwrap()
                .unwrap();
            if matches!(
                status.phase,
                ExecutionPhase::AwaitingAcceptance | ExecutionPhase::Failed
            ) && pump.pending().is_none()
            {
                // Model metadata may trail the terminal by one step.
                for _ in 0..8 {
                    let _ = pump.step(&self.bound).await;
                }
                return self
                    .store
                    .execution_status(&self.owner, &self.conversation)
                    .await
                    .unwrap()
                    .unwrap();
            }
            assert!(Instant::now() < deadline, "bounded synthetic run");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }

    fn turns(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(self.root.join("workspace/synthetic-peer.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .filter(|row| row["kind"] == "turn")
            .collect()
    }

    async fn run(label: &str, mode: &str, policy: CapacityFallback) -> (Self, ExecutionStatus) {
        let case = Self::new(label, mode).await;
        let ready = case.ready().await;
        let capability = case.consume().await;
        let (authority, mut pump) = ready.attach(case.bound.clone(), capability).unwrap();
        pump.set_capacity_policy(policy);
        let status = case.settle(&mut pump).await;
        authority.revoke().unwrap();
        drop(pump);
        (case, status)
    }

    fn cleanup(self) {
        drop(self.bound);
        drop(self.store);
        let _ = std::fs::remove_dir_all(self.root);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capacity_before_any_tool_call_retries_once_on_the_fallback_and_records_it() {
    let (case, status) = Case::run("clean", "clean", CapacityFallback::default()).await;
    assert_eq!(status.phase, ExecutionPhase::AwaitingAcceptance);
    let turns = case.turns();
    assert_eq!(turns.len(), 2, "exactly one retry");
    assert_eq!(turns[0]["model"], serde_json::Value::Null, "thread default");
    assert_eq!(turns[0]["text"], INPUT);
    assert_eq!(turns[1]["model"], "gpt-6-sol");
    let retried = turns[1]["text"].as_str().unwrap();
    assert!(retried.starts_with("[Orkestr retry on gpt-6-sol: gpt-6.1-sol was at capacity"));
    assert!(retried.ends_with(&format!("\n\n{INPUT}")));
    assert_ne!(turns[0]["message"], turns[1]["message"]);
    let payload = status.progress.as_ref().unwrap().payload_id.clone();
    assert_eq!(
        case.store
            .provider_payload(&case.owner, &case.conversation, &payload)
            .await
            .unwrap()
            .text
            .as_deref(),
        Some("synthetic fallback answer")
    );
    // The footer's model evidence names the fallback that actually answered.
    let models = status.models.expect("native model evidence");
    assert_eq!(models.actual_model.as_deref(), Some("gpt-6-sol"));
    assert_eq!(models.resolved_model.as_deref(), Some("gpt-6-sol"));
    assert!(status.failure.is_none());
    case.cleanup();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capacity_after_a_tool_call_is_never_retried_when_continuation_is_off() {
    let policy = CapacityFallback::default().with_continuation(false);
    let (case, status) = Case::run("tool", "tool", policy).await;
    assert_eq!(status.phase, ExecutionPhase::Failed);
    assert_eq!(
        status.failure.map(|failure| failure.class),
        Some(ExecutionFailureClass::Provider)
    );
    assert_eq!(case.turns().len(), 1);
    case.cleanup();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capacity_after_settled_tool_calls_continues_once_without_replaying_the_input() {
    let (case, status) = Case::run("tool-continue", "tool", CapacityFallback::default()).await;
    assert_eq!(status.phase, ExecutionPhase::AwaitingAcceptance);
    let turns = case.turns();
    assert_eq!(turns.len(), 2, "exactly one continuation");
    assert_eq!(turns[0]["text"], INPUT);
    assert_eq!(turns[1]["model"], "gpt-6-sol");
    let note = turns[1]["text"].as_str().unwrap();
    assert!(note.starts_with("[Orkestr continuation on gpt-6-sol"));
    assert!(note.contains("never repeat an external send"));
    assert!(
        !note.contains(INPUT),
        "the original input is never replayed"
    );
    assert_ne!(turns[0]["message"], turns[1]["message"]);
    let payload = status.progress.as_ref().unwrap().payload_id.clone();
    assert_eq!(
        case.store
            .provider_payload(&case.owner, &case.conversation, &payload)
            .await
            .unwrap()
            .text
            .as_deref(),
        Some("synthetic fallback answer")
    );
    let models = status.models.expect("native model evidence");
    assert_eq!(models.actual_model.as_deref(), Some("gpt-6-sol"));
    assert!(status.failure.is_none());
    case.cleanup();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_continuation_that_is_also_at_capacity_fails_after_exactly_one_attempt() {
    let (case, status) =
        Case::run("tool-persist", "tool-persist", CapacityFallback::default()).await;
    assert_eq!(status.phase, ExecutionPhase::Failed);
    assert_eq!(
        status.failure.map(|failure| failure.class),
        Some(ExecutionFailureClass::Provider)
    );
    let turns = case.turns();
    assert_eq!(turns.len(), 2);
    assert!(turns[1]["text"]
        .as_str()
        .unwrap()
        .starts_with("[Orkestr continuation on gpt-6-sol"));
    case.cleanup();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fallback_that_is_also_at_capacity_fails_after_exactly_one_retry() {
    let (case, status) = Case::run("persist", "persist", CapacityFallback::default()).await;
    assert_eq!(status.phase, ExecutionPhase::Failed);
    assert_eq!(
        status.failure.map(|failure| failure.class),
        Some(ExecutionFailureClass::Provider)
    );
    let turns = case.turns();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[1]["model"], "gpt-6-sol");
    case.cleanup();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabled_policy_keeps_the_single_attempt_failure() {
    let (case, status) = Case::run("disabled", "clean", CapacityFallback::disabled()).await;
    assert_eq!(status.phase, ExecutionPhase::Failed);
    assert_eq!(case.turns().len(), 1, "no retry when the policy is off");
    case.cleanup();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_silent_turn_is_interrupted_by_the_watchdog_and_retried_on_the_fallback() {
    let policy = CapacityFallback::default().with_stall(1, 1).unwrap();
    let (case, status) = Case::run("stall", "stall", policy).await;
    assert_eq!(status.phase, ExecutionPhase::AwaitingAcceptance);
    let turns = case.turns();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[1]["model"], "gpt-6-sol");
    assert!(turns[1]["text"]
        .as_str()
        .unwrap()
        .contains("was slow/overloaded"));
    let trace = std::fs::read_to_string(case.root.join("workspace/synthetic-peer.jsonl")).unwrap();
    assert_eq!(trace.matches("\"interrupt\"").count(), 1);
    let models = status.models.expect("native model evidence");
    assert_eq!(models.actual_model.as_deref(), Some("gpt-6-sol"));
    case.cleanup();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_that_is_already_producing_items_is_never_interrupted() {
    let policy = CapacityFallback::default().with_stall(1, 1).unwrap();
    let (case, status) = Case::run("busy", "busy", policy).await;
    assert_eq!(status.phase, ExecutionPhase::AwaitingAcceptance);
    assert_eq!(case.turns().len(), 1);
    let trace = std::fs::read_to_string(case.root.join("workspace/synthetic-peer.jsonl")).unwrap();
    assert!(!trace.contains("\"interrupt\""));
    case.cleanup();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_during_the_stall_interrupt_adopts_it_and_never_retries() {
    let case = Case::new("stall-stop", "stall-stop").await;
    let ready = case.ready().await;
    let capability = case.consume().await;
    let run = capability.provider().run.run_id.clone();
    let (authority, mut pump) = ready.attach(case.bound.clone(), capability).unwrap();
    pump.set_capacity_policy(CapacityFallback::default().with_stall(1, 1).unwrap());
    let trace = case.root.join("workspace/synthetic-peer.jsonl");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !std::fs::read_to_string(&trace)
        .unwrap_or_default()
        .contains("\"interrupt\"")
    {
        if pump.pending().is_none() {
            pump.flush().unwrap();
        }
        pump.step(&case.bound).await.unwrap();
        assert!(
            Instant::now() < deadline,
            "watchdog interrupt reaches the native"
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let receipt = case
        .bound
        .request_cancel(&case.owner, &run, "synthetic-stop")
        .await
        .unwrap();
    // Adopted: no second interrupt, no Busy refusal, no retry.
    let mut stopping = pump.into_stopping(case.bound.clone(), &receipt).unwrap();
    std::fs::write(case.root.join("workspace/release-stop"), "").unwrap();
    while !stopping.stopped() {
        let _ = stopping.flush();
        stopping.step(&case.bound).await.unwrap();
        assert!(
            Instant::now() < deadline,
            "adopted interrupt confirms Stopped"
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let status = case
        .store
        .execution_status(&case.owner, &case.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.phase, ExecutionPhase::Cancelled);
    assert_eq!(case.turns().len(), 1);
    let text = std::fs::read_to_string(&trace).unwrap();
    assert_eq!(text.matches("\"interrupt\"").count(), 1);
    authority.revoke().unwrap();
    drop(stopping);
    case.cleanup();
}
