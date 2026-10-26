//! Ordinary Core grants and owned synthetic echo children; no provider launch.
//! Validated disposable Runtime 4e77a068 + exact Core d2a1720b metadata module,
//! its exports, this module/process hook and temporary containment registration.
//! Manifests/lockfiles are unchanged. No production parent module is registered.
//! Authorized wrapper commands (isolated target/home supplied externally):
//! test --locked --offline -p orkestr-runtime --lib containment::metadata
//! clippy --locked --offline -p orkestr-runtime --all-targets -- -D warnings
#[path = "liveness_tests.rs"]
mod liveness_tests;
#[path = "retirement_tests.rs"]
mod retirement_tests;
use super::*;
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::MessageInput;
use orkestr_v2_store_sqlite::ExecutionConsumption;
use serde_json::json;
use std::sync::atomic::AtomicU64;
use std::time::{Duration, Instant};
static NEXT: AtomicU64 = AtomicU64::new(1);
struct Case {
    root: PathBuf,
    store: Store,
    bound: Store,
    binding: Binding,
    authority: MetadataAuthority,
    child: Option<MetadataChild>,
}
impl Case {
    async fn new() -> Self {
        Self::with_program(Path::new("/bin/cat"), &[]).await
    }
    async fn with_program(program: &Path, args: &[OsString]) -> Self {
        let root = std::env::temp_dir().join(format!(
            "metadata-synthetic-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        for name in ["workspace", "home", "tmp"] {
            std::fs::create_dir(root.join(name)).unwrap();
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
        let authority = MetadataAuthority::new(bound.clone(), grant).unwrap();
        let executor = authority
            .issue_executor(
                program,
                args,
                ChildDirectories::new(
                    &root.join("workspace"),
                    &root.join("home"),
                    &root.join("tmp"),
                )
                .unwrap(),
                TransportBounds::default(),
            )
            .unwrap();
        let child = Some(executor.spawn().unwrap());
        Self {
            root,
            store,
            bound,
            binding,
            authority,
            child,
        }
    }
    async fn ready(
        &mut self,
    ) -> (
        ReadyMetadataChild,
        Box<ConsumedProviderDispatch>,
        Box<DispatchClaim>,
    ) {
        let evidence = NativeSessionConfirmation {
            session_id: self.binding.session_id.clone(),
            expected_generation: self.binding.generation,
            native_session_id: "synthetic-native".into(),
            protocol_version: "codex-rpc-1".into(),
            source_event_key: "synthetic-ready".into(),
        };
        let ready = self.child.take().unwrap().confirm(evidence).await.unwrap();
        let binding = ready.transition.as_ref().unwrap().binding().clone();
        self.store
            .admit(
                &binding.owner_id,
                &binding.conversation_id,
                &MessageInput {
                    client_message_id: "input:1".into(),
                    text: "synthetic durable text".into(),
                },
            )
            .await
            .unwrap();
        let claim = self
            .bound
            .claim_next(
                &binding.owner_id,
                &binding.conversation_id,
                &binding.session_id,
                Duration::from_secs(60),
            )
            .await
            .unwrap()
            .unwrap();
        let candidate = self
            .bound
            .admit_run(&claim, &binding.session_id, binding.generation, "run:1")
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(reservation) = self
            .bound
            .claim_provider_dispatch(&candidate, "reserve:1")
            .await
            .unwrap()
        else {
            panic!("reservation")
        };
        let ExecutionConsumption::Dispatch(cap) =
            self.bound.consume_execution(&reservation).await.unwrap()
        else {
            panic!("unique grant")
        };
        (ready, cap, reservation)
    }
    async fn no_reissue(&self, reservation: &DispatchClaim) {
        assert!(matches!(
            self.bound.consume_execution(reservation).await.unwrap(),
            ExecutionConsumption::ReconciliationRequired
        ));
    }
    async fn cleanup(self) {
        self.authority.revoke().unwrap();
        drop(self.child);
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.authority.shared.active.load(Ordering::Acquire) != 0 {
            assert!(Instant::now() < deadline, "owned child must be reaped");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        self.bound.close().await;
        self.store.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
}
struct RealFence {
    store: Store,
    provider: ProviderAdmission,
}
impl DispatchFence for RealFence {
    fn dispatch(
        &self,
        _: &ExecutionScope,
        action: &mut dyn FnMut() -> std::result::Result<(), Error>,
    ) -> std::result::Result<(), Error> {
        self.store
            .with_execution_fence(&self.provider, action)
            .map_err(|_| Error::Revoked)?
    }
}
// Test wrapper owns the ordinary consumed capability; no caller scope/frame.
struct RealTurn(Box<ConsumedProviderDispatch>);
impl ConsumedTurn for RealTurn {
    fn into_submission(self) -> (ExecutionScope, Vec<u8>) {
        let cap = self.0;
        let run = &cap.provider().run;
        let scope = ExecutionScope::new(
            cap.namespace(),
            cap.incarnation_id(),
            &run.owner_id.to_string(),
            &run.session_id.to_string(),
            &run.run_id.to_string(),
            run.dispatch_fence,
        )
        .unwrap();
        (scope, json!({"id":4,"method":"turn/start","params":{"threadId":cap.provider().binding.native_session_id,
            "input":[{"type":"text","text":cap.text()}]}}).to_string().into_bytes())
    }
}
fn prepare(
    store: Store,
) -> impl FnOnce(
    Box<ConsumedProviderDispatch>,
) -> std::result::Result<(RealTurn, Arc<dyn DispatchFence>), Error> {
    move |cap| {
        let fence: Arc<dyn DispatchFence> = Arc::new(RealFence {
            store,
            provider: cap.provider().clone(),
        });
        Ok((RealTurn(cap), fence))
    }
}
fn setup_frame() -> Vec<u8> {
    json!({"id":1,"method":"account/read","params":{"refreshToken":false}})
        .to_string()
        .into_bytes()
}
fn metadata_frame(child: &MetadataChild) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.poll_stdout().unwrap() {
            Output::Frame(frame) => return frame,
            Output::Pending => {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(2));
            }
            other => panic!("unexpected output: {other:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn setup_before_run_then_attach_same_child_and_old_revoke_cannot_kill_it() {
    let mut c = Case::new().await;
    let child = c.child.as_ref().unwrap();
    let identity = Arc::as_ptr(&child.process);
    assert_eq!(
        child.enqueue_metadata(br#"{"method":"turn/start","params":{}}"#),
        Err(Error::InvalidFrame)
    );
    child.enqueue_metadata(&setup_frame()).unwrap();
    child.flush_stdin().unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&metadata_frame(child)).unwrap()["method"],
        "account/read"
    );
    let (ready, cap, reservation) = c.ready().await;
    assert!(ready.child.shared.setup(|| Ok(())).is_err());
    let (authority, execution) = ready
        .attach_and_enqueue(cap, prepare(c.bound.clone()))
        .unwrap();
    assert_eq!(identity, Arc::as_ptr(&execution.process));
    c.authority.revoke().unwrap();
    execution.flush_stdin(&authority.shared.scope).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match execution.poll_stdout(&authority.shared.scope).unwrap() {
            Output::Frame(bytes) => {
                let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(value["method"], "turn/start");
                assert_eq!(
                    value["params"]["input"][0]["text"],
                    "synthetic durable text"
                );
                break;
            }
            Output::Pending => {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(2));
            }
            other => panic!("unexpected output: {other:?}"),
        }
    }
    c.no_reissue(&reservation).await;
    authority.revoke().unwrap();
    drop(execution);
    drop(authority);
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_setup_writes_prevent_confirmation_and_owned_child_is_cleaned_up() {
    let mut c = Case::new().await;
    let child = c.child.take().unwrap();
    child.enqueue_metadata(&setup_frame()).unwrap();
    let evidence = NativeSessionConfirmation {
        session_id: c.binding.session_id.clone(),
        expected_generation: c.binding.generation,
        native_session_id: "synthetic-native".into(),
        protocol_version: "codex-rpc-1".into(),
        source_event_key: "synthetic-ready".into(),
    };
    assert!(matches!(
        child.confirm(evidence).await,
        Err(Error::Backpressure)
    ));
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn different_real_session_capability_refuses_attachment_and_quarantines() {
    let mut a = Case::new().await;
    let mut b = Case::new().await;
    let (ready, cap_a, reservation_a) = a.ready().await;
    let (ready_b, cap_b, reservation_b) = b.ready().await;
    let process = ready.child.process.clone();
    assert!(matches!(
        ready.attach_and_enqueue(cap_b, prepare(b.bound.clone())),
        Err(TurnFailure {
            cause: Error::WrongScope
        })
    ));
    assert!(process.live.lock().unwrap().child.is_none());
    a.no_reissue(&reservation_a).await;
    b.no_reissue(&reservation_b).await;
    drop(cap_a);
    drop(process);
    drop(ready_b);
    a.cleanup().await;
    b.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoked_metadata_origin_refuses_capability_and_cannot_be_retried() {
    let mut c = Case::new().await;
    let (ready, cap, reservation) = c.ready().await;
    c.authority.revoke().unwrap();
    assert!(matches!(
        ready.attach_and_enqueue(cap, prepare(c.bound.clone())),
        Err(TurnFailure {
            cause: Error::Revoked
        })
    ));
    c.no_reissue(&reservation).await;
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_private_prepare_consumes_grant_and_quarantines_child() {
    let mut c = Case::new().await;
    let (ready, cap, reservation) = c.ready().await;
    let process = ready.child.process.clone();
    assert!(ready
        .attach_and_enqueue::<RealTurn>(cap, |_| Err(Error::InvalidFrame))
        .is_err());
    assert!(process.live.lock().unwrap().child.is_none());
    c.no_reissue(&reservation).await;
    drop(process);
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_metadata_identity_is_checked_before_consuming_real_transition() {
    let mut a = Case::new().await;
    let mut b = Case::new().await;
    let (mut ready_a, cap_a, reservation_a) = a.ready().await;
    let (mut ready_b, cap_b, reservation_b) = b.ready().await;
    // Defensive corruption fixture: both links are genuinely issuer-created.
    // No production API can replace the private transition on an owned child.
    ready_a.transition = ready_b.transition.take();
    assert!(matches!(
        ready_a.attach_and_enqueue(cap_b, prepare(b.bound.clone())),
        Err(TurnFailure {
            cause: Error::WrongScope
        })
    ));
    a.no_reissue(&reservation_a).await;
    b.no_reissue(&reservation_b).await;
    drop(cap_a);
    drop(ready_b);
    a.cleanup().await;
    b.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_writes_defensively_refuse_attachment_without_returning_capability() {
    let mut c = Case::new().await;
    let (ready, cap, reservation) = c.ready().await;
    // Simulates corrupted/internal queued setup; public setup handles are moved.
    ready
        .child
        .process
        .live
        .lock()
        .unwrap()
        .framing
        .enqueue(&setup_frame())
        .unwrap();
    assert!(matches!(
        ready.attach_and_enqueue(cap, prepare(c.bound.clone())),
        Err(TurnFailure {
            cause: Error::Backpressure
        })
    ));
    c.no_reissue(&reservation).await;
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_provider_child_cannot_open_broker_metadata() {
    let case = Case::new().await;
    assert!(matches!(
        case.child.as_ref().unwrap().open_broker_metadata(),
        Err(Error::Revoked)
    ));
    assert!(matches!(
        case.child.as_ref().unwrap().flush_stdin(),
        Err(Error::Revoked)
    ));
}

// Marker injection is fixture-only; production obtains it from TrustedLauncher.
fn fixture_broker(case: &mut Case) -> crate::broker::channel::BrokerChannel {
    let child = case.child.as_mut().unwrap();
    child.broker_launcher = true;
    child.process.broker_launcher.store(true, Ordering::Release);
    let mut open = child.open_broker_metadata().unwrap();
    child.flush_stdin().unwrap();
    let request: serde_json::Value = serde_json::from_slice(&metadata_frame(child)).unwrap();
    let reply = json!({"id":1,"result":{"protocol":crate::broker::PROTOCOL,
        "identity":request["params"]["identity"],"metadata_only":true,
        "owned_handle":"synthetic_owned"}});
    open.receive(reply.to_string().as_bytes())
        .unwrap()
        .into_channel()
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_broker_setup_uses_real_metadata_fence() {
    let mut case = Case::new().await;
    let mut channel = fixture_broker(&mut case);
    let child = case.child.as_ref().unwrap();
    let request = channel
        .metadata(serde_json::from_slice(&setup_frame()).unwrap())
        .unwrap();
    child.enqueue_broker_metadata(request).unwrap();
    child.flush_stdin().unwrap();
    let frame: serde_json::Value = serde_json::from_slice(&metadata_frame(child)).unwrap();
    assert_eq!(frame["method"], "BrokerMetadata");
    assert_eq!(frame["params"]["frame"]["method"], "account/read");
    assert!(child
        .enqueue_metadata(frame.to_string().as_bytes())
        .is_err());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_broker_setup_cannot_cross_owned_child_lineage() {
    let mut first = Case::new().await;
    let mut second = Case::new().await;
    let mut channel = fixture_broker(&mut first);
    let _ = fixture_broker(&mut second);
    let request = channel
        .metadata(serde_json::from_slice(&setup_frame()).unwrap())
        .unwrap();
    assert_eq!(
        second
            .child
            .as_ref()
            .unwrap()
            .enqueue_broker_metadata(request),
        Err(Error::WrongScope)
    );
    assert_eq!(
        second.child.as_ref().unwrap().flush_stdin(),
        Err(Error::Revoked)
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_broker_setup_revoked_before_enqueue_never_queues() {
    let mut case = Case::new().await;
    let mut channel = fixture_broker(&mut case);
    let request = channel
        .metadata(serde_json::from_slice(&setup_frame()).unwrap())
        .unwrap();
    case.authority.revoke().unwrap();
    assert!(case
        .child
        .as_ref()
        .unwrap()
        .enqueue_broker_metadata(request)
        .is_err());
    assert_eq!(
        case.child.as_ref().unwrap().flush_stdin(),
        Err(Error::Revoked)
    );
}
