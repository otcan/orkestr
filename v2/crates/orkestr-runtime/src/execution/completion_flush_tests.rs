//! Completed stdout must not depend on an unnecessary empty input write.
use super::*;
use crate::containment::{DispatchFence, ExecutionScope};
use orkestr_v2_contracts::{ConversationId, ExecutionPhase, OwnerId, RunId};
use std::sync::atomic::AtomicBool;

struct WriteGate {
    actual: crate::execution::fence::StoreFence,
    available: AtomicBool,
    calls: AtomicU64,
}
impl DispatchFence for WriteGate {
    fn dispatch(
        &self,
        scope: &ExecutionScope,
        action: &mut dyn FnMut() -> std::result::Result<(), Error>,
    ) -> std::result::Result<(), Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if !self.available.load(Ordering::SeqCst) {
            return Err(Error::Io);
        }
        self.actual.dispatch(scope, action)
    }
}

struct Case {
    root: std::path::PathBuf,
    store: Store,
    bound: Store,
    token: String,
    owner: OwnerId,
    conversation: ConversationId,
    run: RunId,
    reservation: Box<DispatchClaim>,
    authority: Authority,
    gate: Arc<WriteGate>,
    pump: CodexPump,
}

impl Case {
    async fn new(chunk: Option<usize>) -> Self {
        let root = std::env::temp_dir().join(format!(
            "completion-flush-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        for name in ["workspace", "home", "tmp"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        let root = root.canonicalize().unwrap();
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
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
                    supervisor_key: "synthetic-completion".into(),
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
        let binding = bound
            .confirm_native_session(NativeSessionConfirmation {
                session_id: binding.session_id,
                expected_generation: binding.generation,
                native_session_id: "synthetic-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "ready:1".into(),
            })
            .await
            .unwrap();
        store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: "synthetic-completion-input".into(),
                    text: "Synthetic completion request.".into(),
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
        let candidate = bound
            .admit_run(
                &claim,
                &binding.session_id,
                binding.generation,
                "completion-run",
            )
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(reservation) = bound
            .claim_provider_dispatch(&candidate, "completion-reservation")
            .await
            .unwrap()
        else {
            panic!("fresh reservation")
        };
        let ExecutionConsumption::Dispatch(cap) =
            bound.consume_execution(&reservation).await.unwrap()
        else {
            panic!("one consumed turn")
        };
        let provider = cap.provider().clone();
        let scope = execution_scope(&cap).unwrap();
        let gate = Arc::new(WriteGate {
            actual: crate::execution::fence::StoreFence::from_consumed(bound.clone(), &cap)
                .unwrap(),
            available: AtomicBool::new(true),
            calls: AtomicU64::new(0),
        });
        let authority = Authority::new(scope.clone(), gate.clone(), 1).unwrap();
        let dirs = ChildDirectories::new(
            &root.join("workspace"),
            &root.join("home"),
            &root.join("tmp"),
        )
        .unwrap();
        let script = r#"import sys,json,pathlib
r=json.loads(sys.stdin.readline())
def emit(method,params): print(json.dumps({'method':method,'params':params}),flush=True)
print(json.dumps({'id':r['id'],'result':{'turn':{'id':'synthetic-turn','status':'inProgress'}}}),flush=True)
emit('turn/started',{'threadId':'synthetic-native','turn':{'id':'synthetic-turn','status':'inProgress'}})
pathlib.Path('saved-result').write_text('Synthetic completed effect.')
item={'type':'agentMessage','id':'answer','text':'Synthetic completed answer.','phase':'final_answer'}
emit('item/completed',{'threadId':'synthetic-native','turnId':'synthetic-turn','item':item})
emit('turn/completed',{'threadId':'synthetic-native','turn':{'id':'synthetic-turn','status':'completed','itemsView':'summary','items':[item]}})
pathlib.Path('completion-ready').write_text('ready')
sys.stdin.read()
"#;
        let args = [
            std::ffi::OsString::from("-u"),
            std::ffi::OsString::from("-c"),
            std::ffi::OsString::from(script),
        ];
        let bounds = TransportBounds {
            io_bytes_per_poll: chunk.unwrap_or(65536).max(1),
            ..TransportBounds::default()
        };
        let child = authority
            .issue_executor(&scope, Path::new("/usr/bin/python3"), &args, dirs, bounds)
            .unwrap()
            .spawn(&scope)
            .unwrap();
        submit_codex(cap, &mut ready_rpc("synthetic-native"), &child).unwrap();
        if chunk != Some(0) {
            let written = child.flush_stdin(&scope).unwrap();
            if let Some(chunk) = chunk {
                assert_eq!(written.written, chunk);
                assert_eq!(written.pending_frames, 1);
            } else {
                assert_eq!(written.pending_frames, 0);
                let deadline = Instant::now() + Duration::from_secs(3);
                while !root.join("workspace/completion-ready").exists() {
                    assert!(Instant::now() < deadline);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }
        }
        let run = provider.run.run_id.clone();
        let pump = CodexPump::new(
            child,
            scope,
            provider,
            crate::codex_rpc::TurnStream::new("synthetic-native", 4).unwrap(),
        );
        Self {
            root,
            store,
            bound,
            token,
            owner,
            conversation,
            run,
            reservation,
            authority,
            gate,
            pump,
        }
    }

    async fn close(self) {
        let _ = self.authority.revoke();
        drop(self.pump);
        self.store.close().await;
        drop(self.bound);
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn buffered_completion_survives_an_unavailable_idle_write_fence() {
    let mut c = Case::new(None).await;
    assert_eq!(
        std::fs::read_to_string(c.root.join("workspace/saved-result")).unwrap(),
        "Synthetic completed effect."
    );
    let before = c.gate.calls.load(Ordering::SeqCst);
    c.gate.available.store(false, Ordering::SeqCst);
    assert!(
        c.pump.flush().is_ok(),
        "no pending input must not require a fresh write grant before reading completed output"
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        c.pump.flush().unwrap();
        c.pump.step(&c.bound).await.unwrap();
        let status = c
            .bound
            .execution_run_status(&c.token, &c.owner, &c.conversation, &c.run)
            .await
            .unwrap()
            .unwrap();
        if status.phase == ExecutionPhase::AwaitingAcceptance {
            break status;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    assert_eq!(
        c.gate.calls.load(Ordering::SeqCst),
        before,
        "no unnecessary write callback ran"
    );
    let candidate = status.acceptance_candidate.unwrap();
    c.store
        .accept_execution_authenticated(
            &c.token,
            &c.conversation,
            &orkestr_v2_contracts::ExecutionAcceptanceRequest {
                run_id: c.run.clone(),
                completion_event_id: candidate.completion_event_id,
                expected_revision: status.revision,
                request_key: "synthetic-accept".into(),
            },
        )
        .await
        .unwrap();
    let results = c
        .store
        .accepted_results_authenticated(&c.token, &c.conversation, 0, 10)
        .await
        .unwrap();
    assert_eq!(results.results.len(), 1);
    assert_eq!(results.results[0].run_id, c.run);
    assert!(!matches!(
        c.bound.consume_execution(&c.reservation).await,
        Ok(ExecutionConsumption::Dispatch(_))
    ));
    c.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_and_partially_written_input_still_requires_the_write_fence() {
    for chunk in [0, 7] {
        let mut c = Case::new(Some(chunk)).await;
        c.gate.available.store(false, Ordering::SeqCst);
        let before = c.gate.calls.load(Ordering::SeqCst);
        assert_eq!(c.pump.flush(), Err(Error::Io));
        assert_eq!(c.gate.calls.load(Ordering::SeqCst), before + 1);
        assert!(!c.root.join("workspace/saved-result").exists());
        c.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_empty_input_queue_does_not_bypass_local_revocation() {
    let mut c = Case::new(None).await;
    c.authority.revoke().unwrap();
    assert_eq!(c.pump.flush(), Err(Error::Revoked));
    assert!(c.pump.step(&c.bound).await.is_err());
    c.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_empty_input_queue_does_not_bypass_scope_checks() {
    let mut c = Case::new(None).await;
    c.pump.source.scope = ExecutionScope::new(
        "subscription:synthetic",
        "synthetic-other-incarnation",
        "synthetic-other-owner",
        "synthetic-other-session",
        "synthetic-other-run",
        1,
    )
    .unwrap();
    assert_eq!(c.pump.flush(), Err(Error::WrongScope));
    c.close().await;
}
