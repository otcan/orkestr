//! Same owned synthetic broker child from actual Core setup through durable output.
use super::*;
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::MessageInput;
use orkestr_v2_store_sqlite::{ExecutionConsumption, Store};
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};

async fn exercise(real_broker: bool, stop_mode: u8) {
    let root =
        std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap()).join(format!(
            "owned-broker-composition-{}-{real_broker}-{stop_mode}",
            std::process::id()
        ));
    std::fs::create_dir_all(&root).unwrap();
    for name in ["workspace", "home", "tmp"] {
        std::fs::create_dir_all(root.join(name)).unwrap();
    }
    let root = root.canonicalize().unwrap();
    let launcher = root.join("synthetic-broker");
    std::fs::write(&launcher, r##"#!/usr/bin/python3
import sys,json,os
assert sys.argv[1:]==['open-owned-session','--protocol','orkestr-v2-provider-broker-v1']
assert 'CODEX_HOME' not in os.environ
handle='synthetic_owned'
def emit(v): print(json.dumps(v),flush=True)
for line in sys.stdin:
 r=json.loads(line)
 if r['method']=='OpenOwnedSession':
  emit({'id':r['id'],'result':{'protocol':r['params']['protocol'],'identity':r['params']['identity'],'metadata_only':True,'owned_handle':handle}});continue
 assert r['params']['owned_handle']==handle
 f=r['params']['frame'];m=f['method'];reply=None
 if m=='initialize': reply={'id':f['id'],'result':{'userAgent':'synthetic','platformFamily':'unix','platformOs':'linux','codexHome':'broker-private'}}
 elif m=='account/read': reply={'id':f['id'],'result':{'requiresOpenaiAuth':True,'account':{'type':'chatgpt'}}}
 elif m=='thread/start':
  assert f['params']['modelProvider']=='openai'
  reply={'id':f['id'],'result':{'modelProvider':'openai','thread':{'modelProvider':'openai','id':'synthetic-native','ephemeral':False,'cwd':os.getcwd()},'cwd':os.getcwd(),'approvalPolicy':'never','sandbox':{'type':'readOnly'}}}
 elif m=='turn/start':
  assert r['method']=='CommitExecution'
  assert f['params']['input'][0]['text']=='durable synthetic broker input'
  reply={'id':f['id'],'result':{'turn':{'id':'t1','status':'inProgress'}}}
 elif m!='initialized': raise RuntimeError('unexpected setup')
 emit({'id':r['id'],'result':{'owned_handle':handle,'frame':reply}})
 if m=='turn/start':
  for frame in [
   {'method':'turn/started','params':{'threadId':'synthetic-native','turn':{'id':'t1','status':'inProgress'}}},
   {'method':'item/agentMessage/delta','params':{'threadId':'synthetic-native','turnId':'t1','delta':'synthetic durable progress'}},
   {'method':'turn/completed','params':{'threadId':'synthetic-native','turn':{'id':'t1','status':'completed'}}}]: emit({'method':'BrokerOutput','params':{'owned_handle':handle,'frame':frame}})
"##).unwrap();
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
    if real_broker {
        let provider = root.join("synthetic-provider");
        let source = std::fs::read_to_string(&launcher).unwrap();
        let source=source.replace("assert sys.argv[1:]==['open-owned-session','--protocol','orkestr-v2-provider-broker-v1']","assert sys.argv[1:]==['app-server','--listen','stdio://']")
            .replace("assert 'CODEX_HOME' not in os.environ","assert os.environ['CODEX_HOME']==os.environ['HOME']")
            .replace(" assert r['params']['owned_handle']==handle\n f=r['params']['frame'];m=f['method'];reply=None"," f=r;m=f['method'];reply=None")
            .replace("  assert r['method']=='CommitExecution'","  assert r['method']=='turn/start'")
            .replace(" emit({'id':r['id'],'result':{'owned_handle':handle,'frame':reply}})"," if reply is not None: emit(reply)")
            .replace("emit({'method':'BrokerOutput','params':{'owned_handle':handle,'frame':frame}})","emit(frame)");
        let source = source.replace(" r=json.loads(line)", " r=json.loads(line)\n with open('native-methods.log','a') as log: log.write(r['method']+'\\n')");
        let source = source.replace(
            "for line in sys.stdin:",
            r#"def frames():
 buffer=b''
 while True:
  chunk=os.read(0,4096)
  if not chunk: return
  with open('native-bytes.log','ab') as audit: audit.write(chunk)
  buffer+=chunk
  while b'\n' in buffer:
   line,buffer=buffer.split(b'\n',1)
   yield line.decode()
for line in frames():"#,
        );
        let source = if stop_mode >= 4 {
            source.replace(" elif m!='initialized':", " elif m=='turn/interrupt':\n  reply={'id':f['id'],'result':{}}\n elif m!='initialized':")
                .replace("   {'method':'turn/completed','params':{'threadId':'synthetic-native','turn':{'id':'t1','status':'completed'}}}", "")
                + "\n if m=='turn/interrupt':\n  import time\n  while not os.path.exists('release-stop'): time.sleep(0.002)\n  emit({'method':'turn/completed','params':{'threadId':'synthetic-native','turn':{'id':'t1','status':'interrupted'}}})\n"
        } else {
            source
        };
        let source = if stop_mode == 6 {
            source.replace("'status':'interrupted'", "'status':'completed'")
        } else {
            source
        };
        std::fs::write(&provider, source).unwrap();
        std::fs::set_permissions(&provider, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = root.join("synthetic-private.json");
        std::fs::write(&config,json!({"codex_executable":provider,"codex_home":root.join("home"),"workspace":root.join("workspace"),"home":root.join("home"),"temporary":root.join("tmp")}).to_string()).unwrap();
        let modules = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../provider-broker")
            .canonicalize()
            .unwrap();
        let wrapper=format!("#!/usr/bin/python3\nimport sys\nsys.path.insert(0,{})\nfrom server import main\nraise SystemExit(main({}))\n",serde_json::to_string(&modules).unwrap(),serde_json::to_string(&config).unwrap());
        std::fs::write(&launcher, wrapper).unwrap();
    }
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
                namespace: "subscription:local".into(),
                supervisor_key: "synthetic-deep".into(),
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
    let dirs = crate::containment::ChildDirectories::new(
        &root.join("workspace"),
        &root.join("home"),
        &root.join("tmp"),
    )
    .unwrap();
    let open = if real_broker {
        session::PreparingCodex::open
    } else {
        session::PreparingCodex::open_legacy
    };
    let mut setup = open(
        bound.clone(),
        grant,
        &launcher,
        &root.join("workspace"),
        dirs,
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !setup.poll().unwrap() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let ready = setup.confirm().await.unwrap();
    let binding = bound
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap()
        .deep;
    if real_broker {
        std::fs::write(root.join("workspace/native-bytes.log"), b"").unwrap();
    }
    store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "input:1".into(),
                text: if (2..=3).contains(&stop_mode) {
                    "x".repeat(30000)
                } else {
                    "durable synthetic broker input".into()
                },
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
    let result = bound
        .admit_run(&claim, &binding.session_id, binding.generation, "run:1")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = bound
        .claim_provider_dispatch(&result, "reserve:1")
        .await
        .unwrap()
    else {
        panic!("fresh reservation")
    };
    let ExecutionConsumption::Dispatch(cap) = bound.consume_execution(&reservation).await.unwrap()
    else {
        panic!("unique dispatch")
    };
    let (authority, mut pump) = ready.attach(bound.clone(), cap).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        #[cfg(feature = "fixture-test-controls")]
        if stop_mode == 3 && pump.prepared_for_provider_write() {
            let marker = root.join("after-native-write-rollback");
            pump.arm_post_action_rollback(marker.clone()).await;
            assert!(pump.step(&bound).await.is_err());
            assert_eq!(
                std::fs::read(marker).unwrap(),
                b"execution-fence-after-action-rollback"
            );
            // The callback wrote, but its offset/result never escaped rollback.
            assert_eq!(pump.provider_offset(), 0);
            assert!(pump.flush().is_err());
            assert!(pump.step(&bound).await.is_err());
            authority.revoke().unwrap();
            drop(pump);
            let bytes = std::fs::read(root.join("workspace/native-bytes.log")).unwrap();
            assert!(!bytes.is_empty());
            assert!(bytes.len() <= 16384);
            assert!(!bytes.contains(&b'\n'));
            let observed = bytes.len();
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(
                std::fs::metadata(root.join("workspace/native-bytes.log"))
                    .unwrap()
                    .len(),
                observed as u64
            );
            let reopened = Store::open(&root.join("state.sqlite3")).await.unwrap();
            let attached = bound.reattach_supervisor(&reopened).await.unwrap();
            assert!(matches!(
                attached.consume_execution(&reservation).await.unwrap(),
                ExecutionConsumption::ReconciliationRequired
            ));
            assert!(matches!(
                attached
                    .claim_provider_dispatch(&result, "no-replacement")
                    .await
                    .unwrap(),
                DispatchClaimResult::ReconciliationRequired
            ));
            let status = reopened
                .execution_status(&owner, &conversation)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(status.phase, orkestr_v2_contracts::ExecutionPhase::Starting);
            assert!(status.acceptance_candidate.is_none());
            drop(attached);
            drop(reopened);
            drop(authority);
            drop(bound);
            drop(store);
            std::fs::remove_dir_all(root).unwrap();
            return;
        }
        if (stop_mode == 1 && pump.prepared_for_provider_write())
            || (stop_mode == 2 && pump.provider_offset() > 0)
        {
            let prefix = pump.provider_offset();
            if stop_mode == 2 {
                assert!(prefix > 0 && prefix < 30000);
                while std::fs::metadata(root.join("workspace/native-bytes.log"))
                    .unwrap()
                    .len()
                    != prefix as u64
                {
                    assert!(Instant::now() < deadline);
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            }
            // Durable cancellation commits immediately before the next actual
            // provider write. The broker has registered, but owns no writer.
            let receipt = bound
                .request_cancel(&owner, &result.provider.run.run_id, "before-native-write")
                .await
                .unwrap();
            assert_eq!(receipt.state, RunState::CancelRequested);
            assert!(pump.step(&bound).await.is_err());
            assert!(
                !std::fs::read_to_string(root.join("workspace/native-methods.log"))
                    .unwrap()
                    .lines()
                    .any(|method| method == "turn/start")
            );
            if stop_mode == 2 {
                let bytes = std::fs::read(root.join("workspace/native-bytes.log")).unwrap();
                assert_eq!(bytes.len(), prefix);
                assert!(!bytes.contains(&b'\n')); // incomplete frame, never replayed
            }
            assert!(matches!(
                bound.consume_execution(&reservation).await,
                Err(RuntimeStoreError::Fenced)
            ));
            authority.revoke().unwrap();
            drop(pump);
            drop(authority);
            drop(bound);
            drop(store);
            std::fs::remove_dir_all(root).unwrap();
            return;
        }
        // The pump owns the attached child and flushes only under the issued fence.
        pump.flush().unwrap();
        pump.step(&bound).await.unwrap();
        let status = store
            .execution_status(&owner, &conversation)
            .await
            .unwrap()
            .unwrap();
        if stop_mode >= 4
            && status.phase == orkestr_v2_contracts::ExecutionPhase::Running
            && status.progress.is_some()
        {
            let receipt = bound
                .request_cancel(&owner, &result.provider.run.run_id, "native-stop")
                .await
                .unwrap();
            let mut stopping = pump.into_stopping(bound.clone(), &receipt).unwrap();
            while !stopping.acknowledged() {
                stopping.flush().unwrap();
                stopping.step(&bound).await.unwrap();
                assert!(Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            assert!(!stopping.stopped());
            assert_eq!(
                store
                    .execution_status(&owner, &conversation)
                    .await
                    .unwrap()
                    .unwrap()
                    .phase,
                orkestr_v2_contracts::ExecutionPhase::CancelRequested
            );
            if stop_mode == 5 {
                for _ in 0..10 {
                    assert!(!stopping.step(&bound).await.unwrap());
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
                assert!(!stopping.stopped());
                assert_eq!(
                    store
                        .execution_status(&owner, &conversation)
                        .await
                        .unwrap()
                        .unwrap()
                        .phase,
                    orkestr_v2_contracts::ExecutionPhase::CancelRequested
                );
                authority.revoke().unwrap();
                drop(stopping);
                drop(authority);
                drop(bound);
                drop(store);
                std::fs::remove_dir_all(root).unwrap();
                return;
            }
            std::fs::write(root.join("workspace/release-stop"), b"ok").unwrap();
            if stop_mode == 6 {
                loop {
                    if stopping.step(&bound).await.is_err() {
                        break;
                    }
                    assert!(Instant::now() < deadline);
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
                assert_eq!(
                    stopping.retained(),
                    &[ProviderEvent::CompletedProposal { synthetic: false }]
                );
                assert!(!stopping.stopped());
                assert_eq!(
                    store
                        .execution_status(&owner, &conversation)
                        .await
                        .unwrap()
                        .unwrap()
                        .phase,
                    orkestr_v2_contracts::ExecutionPhase::CancelRequested
                );
                authority.revoke().unwrap();
                drop(stopping);
                drop(authority);
                drop(bound);
                drop(store);
                std::fs::remove_dir_all(root).unwrap();
                return;
            }
            while !stopping.stopped() {
                stopping.step(&bound).await.unwrap();
                assert!(Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            assert_eq!(
                store
                    .execution_status(&owner, &conversation)
                    .await
                    .unwrap()
                    .unwrap()
                    .phase,
                orkestr_v2_contracts::ExecutionPhase::Cancelled
            );
            assert_eq!(
                std::fs::read_to_string(root.join("workspace/native-methods.log"))
                    .unwrap()
                    .lines()
                    .filter(|m| *m == "turn/interrupt")
                    .count(),
                1
            );
            authority.revoke().unwrap();
            drop(stopping);
            drop(authority);
            drop(bound);
            drop(store);
            std::fs::remove_dir_all(root).unwrap();
            return;
        }
        if status.phase == orkestr_v2_contracts::ExecutionPhase::AwaitingAcceptance {
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert!(matches!(
        bound.consume_execution(&reservation).await,
        Err(RuntimeStoreError::Fenced)
    ));
    let status = store
        .execution_status(&owner, &conversation)
        .await
        .unwrap()
        .unwrap();
    let payload = status.progress.unwrap().payload_id;
    assert_eq!(
        store
            .provider_payload(&owner, &conversation, &payload)
            .await
            .unwrap()
            .text
            .as_deref(),
        Some("synthetic durable progress")
    );
    authority.revoke().unwrap();
    drop(pump);
    drop(authority);
    drop(bound);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn same_owned_broker_setup_consume_attach_and_durable_progress() {
    exercise(false, 0).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn standalone_broker_and_ordinary_store_preserve_same_child_dispatch() {
    exercise(true, 0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_stop_after_broker_prepared_before_native_write_delivers_zero_turn_bytes() {
    exercise(true, 1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_stop_after_actual_partial_prefix_quarantines_without_suffix_or_redispatch() {
    exercise(true, 2).await;
}

#[cfg(feature = "fixture-test-controls")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn post_native_suffix_rollback_quarantines_without_offset_retry_or_reissue() {
    exercise(true, 3).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_interrupt_ack_is_not_terminal_and_only_interrupted_evidence_confirms_stop() {
    exercise(true, 4).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_interrupt_ack_alone_never_confirms_stop() {
    exercise(true, 5).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_completion_racing_stop_is_retained_without_relabel() {
    exercise(true, 6).await;
}
