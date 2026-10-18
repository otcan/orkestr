//! Independent real Store-issued dispatch + owned synthetic child race oracle.
//! Registered only in disposable test copies; no production adapter or routes.
//!
//! Review base: Runtime 1ac5b079 (Core 4d66e605, consumed bridge 3fc675bc,
//! namespace-only colon correction 884cf08e). Overlay this file in a disposable
//! copy and append `mod durable_races;` to containment/tests/mod.rs there only.
//! Run with authorized wrapper and isolated home/target:
//! `test --locked --offline -p orkestr-runtime --lib containment::tests::durable_races`
//! and `clippy --locked --offline -p orkestr-runtime --all-targets -- -D warnings`.
//! Natural expiry waits once for the real issued deadline (approximately 60s).
//! It does not adjust SQLite, supervisor clocks, or lease rows. The private
//! independent fence adapter below always calls the actual Core durable fence;
//! turn frames enter only through Runtime submit_codex with an ordinary cap.
//! Metadata/readiness attachment and live providers are outside this oracle.
use super::*;
use crate::{codex_rpc::CodexRpc, execution::submit_codex};
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::MessageInput;
use orkestr_v2_store_sqlite::{ConsumedProviderDispatch, ExecutionConsumption, Store};
use std::sync::Barrier;

// Independent adapter: every callback is serialized by Core's real SQLite fence.
struct DurableFence {
    store: Store,
    provider: ProviderAdmission,
}
impl DispatchFence for DurableFence {
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
struct Case {
    fixture: Fixture,
    store: Store,
    bound: Store,
    token: String,
    reservation: Box<DispatchClaim>,
    cap: Option<Box<ConsumedProviderDispatch>>,
    scope: ExecutionScope,
    authority: Arc<Authority>,
    child: Arc<OwnedChild>,
    provider: ProviderAdmission,
}
impl Case {
    async fn new(text: &str, code: &str, bounds: TransportBounds) -> Self {
        let fixture = Fixture::new();
        let root = &fixture.0;
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
        let roles = bound
            .ensure_role_bindings(&owner, &conversation)
            .await
            .unwrap();
        assert_ne!(roles.fast.session_id, roles.deep.session_id);
        let binding = bound
            .confirm_native_session(NativeSessionConfirmation {
                session_id: roles.deep.session_id,
                expected_generation: roles.deep.generation,
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
                    client_message_id: "input:1".into(),
                    text: text.into(),
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
            .admit_run(&claim, &binding.session_id, binding.generation, "run:1")
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(reservation) = bound
            .claim_provider_dispatch(&candidate, "reserve:1")
            .await
            .unwrap()
        else {
            panic!("fresh reservation")
        };
        let ExecutionConsumption::Dispatch(cap) =
            bound.consume_execution(&reservation).await.unwrap()
        else {
            panic!("unique consumption")
        };
        let provider = cap.provider().clone();
        let scope = ExecutionScope::new(
            cap.namespace(),
            cap.incarnation_id(),
            &provider.run.owner_id.to_string(),
            &provider.run.session_id.to_string(),
            &provider.run.run_id.to_string(),
            provider.run.dispatch_fence,
        )
        .unwrap();
        let authority = Arc::new(
            Authority::new(
                scope.clone(),
                Arc::new(DurableFence {
                    store: bound.clone(),
                    provider: provider.clone(),
                }),
                1,
            )
            .unwrap(),
        );
        let child = Arc::new(
            fixture
                .executor(&authority, &scope, code, bounds)
                .spawn(&scope)
                .unwrap(),
        );
        Self {
            fixture,
            store,
            bound,
            token,
            reservation,
            cap: Some(cap),
            scope,
            authority,
            child,
            provider,
        }
    }
    fn submit(&mut self) {
        submit_codex(self.cap.take().unwrap(), &mut ready_rpc(), &self.child).unwrap();
    }
    async fn no_reissue(&self) {
        assert!(matches!(
            self.bound
                .consume_execution(&self.reservation)
                .await
                .unwrap(),
            ExecutionConsumption::ReconciliationRequired
        ));
        // Verify again through an ordinary newly opened handle, not just the issuer.
        let reopened = Store::open(&self.fixture.0.join("state.sqlite3"))
            .await
            .unwrap();
        let attached = self.bound.reattach_supervisor(&reopened).await.unwrap();
        assert!(matches!(
            attached.consume_execution(&self.reservation).await.unwrap(),
            ExecutionConsumption::ReconciliationRequired
        ));
        reopened.close().await;
    }
    async fn cleanup(self) {
        self.authority.revoke().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.authority.shared.active.load(Ordering::Acquire) != 0 {
            assert!(Instant::now() < deadline, "owned child must be reaped");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        self.bound.close().await;
        self.store.close().await;
    }
}
fn ready_rpc() -> CodexRpc {
    let mut rpc = CodexRpc::default();
    rpc.initialize().unwrap();
    rpc.receive(r#"{"id":1,"result":{"userAgent":"synthetic","platformFamily":"unix","platformOs":"linux","codexHome":"/synthetic"}}"#).unwrap();
    rpc.account_read().unwrap();
    rpc.receive(r#"{"id":2,"result":{"requiresOpenaiAuth":true,"account":{"type":"chatgpt"}}}"#)
        .unwrap();
    rpc.create_session(Path::new("/synthetic/workspace"))
        .unwrap();
    rpc.receive(&json!({"id":3,"result":{"thread":{"id":"synthetic-native","ephemeral":false,"cwd":"/synthetic/workspace"},"cwd":"/synthetic/workspace","approvalPolicy":"never","sandbox":{"type":"readOnly"}}}).to_string()).unwrap();
    rpc
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoke_racing_cap_enqueue_never_restores_grant() {
    let mut c = Case::new(
        "synthetic race",
        "import time; time.sleep(30)",
        TransportBounds::default(),
    )
    .await;
    let barrier = Arc::new(Barrier::new(2));
    let (authority, go) = (c.authority.clone(), barrier.clone());
    let revoke = std::thread::spawn(move || {
        go.wait();
        authority.revoke().unwrap();
    });
    barrier.wait();
    let result = submit_codex(c.cap.take().unwrap(), &mut ready_rpc(), &c.child);
    revoke.join().unwrap();
    assert!(
        result.is_ok()
            || matches!(
                result,
                Err(crate::execution::SubmissionFailure::Transport(
                    Error::Revoked
                ))
            )
    );
    assert_eq!(c.child.flush_stdin(&c.scope), Err(Error::Revoked));
    c.no_reissue().await;
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn token_revocation_racing_partial_flush_is_durably_fenced() {
    let mut c = Case::new(
        "synthetic partial",
        "import time; time.sleep(30)",
        TransportBounds {
            io_bytes_per_poll: 7,
            ..TransportBounds::default()
        },
    )
    .await;
    c.submit();
    let barrier = Arc::new(Barrier::new(2));
    let (child, scope, go) = (c.child.clone(), c.scope.clone(), barrier.clone());
    let flush = std::thread::spawn(move || {
        go.wait();
        child.flush_stdin(&scope)
    });
    barrier.wait();
    c.store.revoke_session(&c.token).await.unwrap();
    match flush.join().unwrap() {
        Ok(progress) => {
            assert!(progress.written <= 7);
            assert_eq!(progress.pending_frames, 1);
        }
        Err(error) => assert_eq!(error, Error::Revoked),
    }
    assert_eq!(c.child.flush_stdin(&c.scope), Err(Error::Revoked));
    // Re-authorizing the same machine token cannot mint a second consumed grant.
    c.store
        .save_session(&c.token, &c.provider.run.owner_id)
        .await
        .unwrap();
    c.no_reissue().await;
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renewal_fences_partially_written_old_admission_without_second_turn() {
    let mut c = Case::new(
        "synthetic unknown",
        "import time; time.sleep(30)",
        TransportBounds {
            io_bytes_per_poll: 7,
            ..TransportBounds::default()
        },
    )
    .await;
    c.submit();
    let progress = c.child.flush_stdin(&c.scope).unwrap();
    assert_eq!(progress.written, 7);
    assert_eq!(progress.pending_frames, 1);
    tokio::time::sleep(Duration::from_millis(20)).await;
    c.bound.heartbeat_supervisor().await.unwrap();
    let renewed = c
        .bound
        .renew_lease(&c.provider.run, c.provider.run.lease_generation)
        .await
        .unwrap();
    assert!(renewed.lease_generation > c.provider.run.lease_generation);
    assert_eq!(c.child.flush_stdin(&c.scope), Err(Error::Revoked));
    let mut current = c.provider.clone();
    current.run = renewed;
    let mut calls = 0;
    c.bound
        .with_execution_fence(&current, || {
            calls += 1;
            Ok::<_, Error>(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(calls, 1);
    // Renewal is freshness only: old reservation cannot become a new capability.
    assert!(c.bound.consume_execution(&c.reservation).await.is_err());
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn durable_nonreader_backpressure_is_bounded_and_cleanup_reaps() {
    let mut c = Case::new(
        &"x".repeat(30_000),
        "import fcntl,time; fcntl.fcntl(0,1031,4096); print(\"ready\",flush=True); time.sleep(30)",
        TransportBounds {
            io_bytes_per_poll: 1024,
            max_pending_frames: 1,
            ..TransportBounds::default()
        },
    )
    .await;
    assert_eq!(frame(&c.child, &c.scope).unwrap(), b"ready");
    c.submit();
    let mut total = 0;
    let mut blocked = false;
    for _ in 0..64 {
        let progress = c.child.flush_stdin(&c.scope).unwrap();
        assert!(progress.written <= 1024);
        assert_eq!(progress.pending_frames, 1);
        total += progress.written;
        if progress.written == 0 {
            blocked = true;
            break;
        }
    }
    assert!(blocked);
    assert!(total > 0 && total < 30_000);
    c.no_reissue().await;
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn child_exit_signal_reaper_and_unknown_input_never_restore_capability() {
    let mut c = Case::new(
        "synthetic exit",
        "raise SystemExit(7)",
        TransportBounds::default(),
    )
    .await;
    assert_eq!(exit(&c.child, &c.scope).code, Some(7));
    c.submit();
    assert_eq!(c.child.flush_stdin(&c.scope), Err(Error::PipeClosed));
    assert_eq!(c.child.flush_stdin(&c.scope), Err(Error::PipeClosed));
    c.child.signal(&c.scope, Signal::Kill).unwrap();
    c.no_reissue().await;
    c.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn natural_store_deadline_expiry_fences_owned_child_without_clock_override() {
    let mut c = Case::new(
        "synthetic expiry",
        "import time; time.sleep(70)",
        TransportBounds::default(),
    )
    .await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let remaining = c.provider.run.lease_deadline_ms.saturating_sub(now);
    assert!((0..=60_000).contains(&remaining));
    // One bounded real deadline wait, never a private clock/SQL mutation.
    tokio::time::sleep(Duration::from_millis(remaining as u64 + 30)).await;
    let result = submit_codex(c.cap.take().unwrap(), &mut ready_rpc(), &c.child);
    assert_eq!(
        result,
        Err(crate::execution::SubmissionFailure::Transport(
            Error::Revoked
        ))
    );
    assert_eq!(c.child.flush_stdin(&c.scope), Err(Error::Revoked));
    assert!(c.bound.consume_execution(&c.reservation).await.is_err());
    c.cleanup().await;
}
