//! Actual ordinary Store + owned synthetic Claude process, no credential access.
#[path = "../src/claude_execution/mod.rs"]
mod claude_execution;
use claude_execution::*;
use orkestr_v2_application::runtime::ProviderKind;
use orkestr_v2_application::{
    runtime::{DispatchClaimResult, ProductionSupervisorConfig, ProductionTakeover, RuntimeStore},
    IntakeStore,
};
use orkestr_v2_contracts::{ExecutionPhase, MessageInput};
use orkestr_v2_store_sqlite::{ExecutionConsumption, Store};
use std::{
    os::unix::fs::PermissionsExt,
    time::{Duration, Instant},
};

async fn exercise(failure: bool) {
    let root = std::path::PathBuf::from(std::env::var("ORKESTR_V2_HOME").unwrap()).join(format!(
        "claude-server-owned-{}-{failure}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root).unwrap();
    for dir in ["workspace", "home", "tmp", "account"] {
        std::fs::create_dir_all(root.join(dir)).unwrap();
    }
    let root = root.canonicalize().unwrap();
    let native = root.join("native");
    let source = r#"#!/usr/bin/python3
import sys,json
native=sys.argv[sys.argv.index('--session-id')+1]
print(json.dumps({'type':'system','subtype':'init','session_id':native}),flush=True)
for line in sys.stdin:
 f=json.loads(line)
 assert f['session_id']==native and f['message']['content']=='synthetic isolated input'
 print(json.dumps({'type':'assistant','session_id':native,'message':{'role':'assistant','content':[{'type':'text','text':'synthetic output'}]}}),flush=True)
 print(json.dumps({'type':'result','session_id':native,'subtype':'success','is_error':False,'result':'synthetic output'}),flush=True)
"#;
    let source = if failure {
        source
            .replace("\'is_error\':False", "\'is_error\':True")
            .replace(
                "\'subtype\':\'success\'",
                "\'subtype\':\'error_during_execution\'",
            )
    } else {
        source.into()
    };
    std::fs::write(&native, source).unwrap();
    std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o700)).unwrap();
    let config = root.join("config.json");
    std::fs::write(&config,serde_json::json!({"executable":native,"account":root.join("account"),"workspace":root.join("workspace"),"home":root.join("home"),"temporary":root.join("tmp")}).to_string()).unwrap();
    let modules = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../provider-broker")
        .canonicalize()
        .unwrap();
    let launcher = root.join("launcher");
    std::fs::write(&launcher,format!("#!/usr/bin/python3\nimport sys\nsys.path.insert(0,{:?})\nfrom claude_server import main\nraise SystemExit(main({:?}))\n",modules.to_str().unwrap(),config.to_str().unwrap())).unwrap();
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
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
    let token = "cd".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let bound = store
        .authorize_supervisor(
            &token,
            ProductionSupervisorConfig {
                provider: ProviderKind::Claude,
                namespace: "subscription:synthetic".into(),
                supervisor_key: "synthetic-claude".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let binding = bound
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap()
        .deep;
    let grant = bound.authorize_session_metadata(&binding).await.unwrap();
    let dirs = orkestr_runtime::containment::ChildDirectories::new(
        &root.join("workspace"),
        &root.join("home"),
        &root.join("tmp"),
    )
    .unwrap();
    let mut preparing = PreparingClaudeExecution::open_retained(
        bound.clone(),
        grant,
        &launcher,
        dirs,
        Box::new(()),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !preparing.poll_ready().unwrap() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let ready = preparing.confirm().await.unwrap();
    let binding = bound
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap()
        .deep;
    store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "claude-input:1".into(),
                text: "synthetic isolated input".into(),
            },
        )
        .await
        .unwrap();
    let claim = bound
        .claim_next(
            &owner,
            &conversation,
            &binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let admission = bound
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "claude-run:1",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = bound
        .claim_provider_dispatch(&admission, "claude-reserve:1")
        .await
        .unwrap()
    else {
        panic!("fresh")
    };
    let ExecutionConsumption::Dispatch(cap) = bound.consume_execution(&reservation).await.unwrap()
    else {
        panic!("unique")
    };
    let mut pump = ready.attach(cap).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        pump.tick().await.unwrap();
        let status = store
            .execution_status(&owner, &conversation)
            .await
            .unwrap()
            .unwrap();
        if failure && status.phase == ExecutionPhase::Failed {
            assert!(status.acceptance_candidate.is_none());
            break;
        }
        if !failure && status.phase == ExecutionPhase::AwaitingAcceptance {
            assert!(status.acceptance_candidate.is_some());
            let progress = status.progress.expect("durable progress reference");
            let payload = store
                .provider_payload(&owner, &conversation, &progress.payload_id)
                .await
                .unwrap();
            assert_eq!(payload.text.as_deref(), Some("synthetic output"));
            break;
        }
        assert!(Instant::now() < deadline, "completion timeout");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    pump.quarantine();
    drop(pump);

    drop(bound);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_claude_first_turn_persists_progress_and_proposal() {
    exercise(false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_claude_failed_result_never_proposes_success() {
    exercise(true).await;
}
