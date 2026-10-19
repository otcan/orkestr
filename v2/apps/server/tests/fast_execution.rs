//! Actual ordinary Store + owned synthetic Fast process, no credential access.
#[path = "../src/fast_execution/mod.rs"]
#[allow(
    dead_code,
    reason = "persistent lifecycle is exercised by fast_persistent_execution"
)]
mod fast_execution;
use fast_execution::{FastFailure, FastStart, LiveFast, PreparingFast, ReadyFast};
use orkestr_v2_server::control_dispatch;
const _: Option<FastFailure> = None;
const _: Option<LiveFast> = None;
const _: Option<ReadyFast> = None;
use orkestr_v2_application::runtime::ProviderKind;
use orkestr_v2_application::{
    runtime::{ProductionSupervisorConfig, ProductionTakeover, RuntimeStore},
    IntakeStore,
};
use orkestr_v2_contracts::MessageInput;
use orkestr_v2_store_sqlite::Store;
use std::{
    os::unix::fs::PermissionsExt,
    time::{Duration, Instant},
};

async fn exercise() {
    let root = std::path::PathBuf::from(std::env::var("ORKESTR_V2_HOME").unwrap())
        .join(format!("fast-server-owned-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    for dir in ["workspace", "home", "tmp", "account"] {
        std::fs::create_dir_all(root.join(dir)).unwrap();
    }
    let root = root.canonicalize().unwrap();
    let native = root.join("native");
    let source = r#"#!/usr/bin/python3
import sys,json,os
def emit(v): print(json.dumps(v),flush=True)
for line in sys.stdin:
 f=json.loads(line);m=f['method'];reply=None
 if m=='initialize': reply={'id':f['id'],'result':{'userAgent':'synthetic','platformFamily':'unix','platformOs':'linux','codexHome':'private'}}
 elif m=='account/read': reply={'id':f['id'],'result':{'requiresOpenaiAuth':True,'account':{'type':'chatgpt'}}}
 elif m=='thread/start':
  reply={'id':f['id'],'result':{'modelProvider':'openai','thread':{'modelProvider':'openai','id':'synthetic-fast-native','ephemeral':False,'cwd':os.getcwd()},'cwd':os.getcwd(),'approvalPolicy':'never','sandbox':{'type':'readOnly'}}}
 elif m=='turn/start':
  assert f['params']['input'][0]['text']=='synthetic isolated input'
  with open('turns.log','a') as log: log.write('turn\n')
  reply={'id':f['id'],'result':{'turn':{'id':'fast-turn','status':'inProgress'}}}
 elif m!='initialized': raise RuntimeError('unexpected method')
 if reply is not None: emit(reply)
 if m=='turn/start':
  emit({'method':'turn/started','params':{'threadId':'synthetic-fast-native','turn':{'id':'fast-turn','status':'inProgress'}}})
  emit({'method':'item/agentMessage/delta','params':{'threadId':'synthetic-fast-native','turnId':'fast-turn','delta':'synthetic output'}})
  emit({'method':'turn/completed','params':{'threadId':'synthetic-fast-native','turn':{'id':'fast-turn','status':'completed'}}})
"#;
    std::fs::write(&native, source).unwrap();
    std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o700)).unwrap();
    let config = root.join("config.json");
    std::fs::write(&config,serde_json::json!({"codex_executable":native,"codex_home":root.join("home"),"workspace":root.join("workspace"),"home":root.join("home"),"temporary":root.join("tmp")}).to_string()).unwrap();
    let modules = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../provider-broker")
        .canonicalize()
        .unwrap();
    let launcher = root.join("launcher");
    std::fs::write(&launcher,format!("#!/usr/bin/python3\nimport sys\nsys.path.insert(0,{:?})\nfrom server import main\nraise SystemExit(main({:?}))\n",modules.to_str().unwrap(),config.to_str().unwrap())).unwrap();
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
                provider: ProviderKind::Codex,
                namespace: "subscription:synthetic".into(),
                supervisor_key: "synthetic-fast".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let binding = bound
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap()
        .fast;
    let grant = bound.authorize_session_metadata(&binding).await.unwrap();
    let dirs = orkestr_runtime::containment::ChildDirectories::new(
        &root.join("workspace"),
        &root.join("home"),
        &root.join("tmp"),
    )
    .unwrap();
    let mut preparing = PreparingFast::open_retained(
        bound.clone(),
        grant,
        &launcher,
        &root.join("workspace"),
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
        .fast;
    let source = store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "fast-input:1".into(),
                text: "synthetic isolated input".into(),
            },
        )
        .await
        .unwrap();
    let input = orkestr_v2_store_sqlite::FastAdmissionInput {
        source_message_id: source.receipt.message_id.clone(),
        source_event_id: source.receipt.event_id.clone(),
        fast_binding_id: binding.session_id.clone(),
        expected_binding_generation: binding.generation,
        request_key: "fast-input:1".into(),
    };
    let FastStart::Live(mut pump) = ready.dispatch(&token, &input).await.unwrap() else {
        panic!("fresh Fast grant required")
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        pump.tick().await.unwrap();
        let events = store.events(&owner, &conversation, 0, 100).await.unwrap();
        if events.iter().any(|event| {
            serde_json::to_value(event)
                .unwrap()
                .to_string()
                .contains("completed_proposal")
        }) {
            break;
        }
        assert!(Instant::now() < deadline, "completion timeout");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let deep_status = store
        .execution_status(&owner, &conversation)
        .await
        .unwrap()
        .unwrap();
    assert!(
        deep_status.run_id.is_none(),
        "Fast must not replace Deep projection"
    );
    assert_eq!(
        deep_status.phase,
        orkestr_v2_contracts::ExecutionPhase::Queued
    );
    assert!(matches!(
        super_fast_replay(&bound, &token, &input).await,
        FastDispatchResult::NoDispatch
    ));
    assert_eq!(
        std::fs::read_to_string(root.join("workspace/turns.log")).unwrap(),
        "turn\n"
    );
    // Fast does not consume or acknowledge the Deep inbox entry.
    let deep = bound
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap()
        .deep;
    let claim = bound
        .claim_next(
            &owner,
            &conversation,
            &deep.session_id,
            Duration::from_secs(10),
        )
        .await
        .unwrap()
        .expect("Deep inbox remains available");
    assert_eq!(claim.event_id, source.receipt.event_id);
    pump.quarantine();
    drop(pump);
    drop(bound);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
enum FastDispatchResult {
    NoDispatch,
}
async fn super_fast_replay(
    store: &Store,
    credential: &str,
    input: &orkestr_v2_store_sqlite::FastAdmissionInput,
) -> FastDispatchResult {
    match fast_execution::consume_fast(store, credential, input)
        .await
        .unwrap()
    {
        fast_execution::FastDispatch::Replay
        | fast_execution::FastDispatch::ReconciliationRequired => FastDispatchResult::NoDispatch,
        fast_execution::FastDispatch::Consumed(_) => {
            panic!("replayed Fast input reissued inference capability")
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn distinct_fast_native_dispatch_preserves_deep_inbox_and_never_replays() {
    exercise().await;
}
