//! Real Core SQLite fixture transactions plus FAKE I/O. No production start path.
//! Pool reopen and discarded replies are not SIGKILL/lost-transport-ACK evidence.
use orkestr_runtime::{fake::FakeProvider, ports::Provider};
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::MessageInput;
use orkestr_v2_store_sqlite::{
    fixture_runtime::{
        bootstrap_fixture_supervisor, ExplicitFixtureSupervisorConfig, FixtureSupervisorStore,
        FixtureTakeover,
    },
    Store,
};
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Fixture {
    root: PathBuf,
    a: Store,
    b: Store,
    handle: FixtureSupervisorStore,
    binding: Binding,
    claim: InboxClaim,
}
impl Fixture {
    async fn new() -> Self {
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home")).join(
            format!(
                "runtime-dispatch-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ),
        );
        std::fs::create_dir_all(&root).unwrap();
        let a = Store::open(&root.join("fixture.sqlite3")).await.unwrap();
        let conversation = a.setup("synthetic-owner", "synthetic-hash").await.unwrap();
        let (owner, _) = a.credentials("synthetic-owner").await.unwrap().unwrap();
        let b = Store::open(&root.join("fixture.sqlite3")).await.unwrap();
        let handle = bootstrap_fixture_supervisor(
            &a,
            &owner,
            ExplicitFixtureSupervisorConfig {
                namespace: "runtime-synthetic".into(),
                supervisor_key: "runtime-dispatch".into(),
                takeover: FixtureTakeover::First,
            },
        )
        .await
        .unwrap();
        let roles = a.ensure_role_bindings(&owner, &conversation).await.unwrap();
        let binding = handle
            .confirm_fixture_readiness(&roles.deep.session_id, 1)
            .await
            .unwrap();
        a.admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "synthetic-input".into(),
                text: "Synthetic fixture input".into(),
            },
        )
        .await
        .unwrap();
        let claim = a
            .claim_next(
                &owner,
                &conversation,
                &binding.session_id,
                Duration::from_secs(60),
            )
            .await
            .unwrap()
            .unwrap();
        Self {
            root,
            a,
            b,
            handle,
            binding,
            claim,
        }
    }
    async fn admit(&self, handle: &FixtureSupervisorStore) -> RunAdmissionResult {
        handle
            .admit_run(
                &self.claim,
                &self.binding.session_id,
                self.binding.generation,
                "synthetic-run",
            )
            .await
            .unwrap()
    }
    async fn reserve(&self) -> DispatchClaim {
        match self
            .handle
            .claim_provider_dispatch(&self.admit(&self.handle).await, "synthetic-reserve")
            .await
            .unwrap()
        {
            DispatchClaimResult::Reserved(r) => *r,
            _ => panic!("initial fixture reservation required"),
        }
    }
    async fn close(&self) {
        self.a.close().await;
        self.b.close().await;
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

// Only test code can reach this boundary. Store commits before yielding DispatchNow.
async fn consume_then_fake(
    handle: &FixtureSupervisorStore,
    claim: &DispatchClaim,
    fake: &mut FakeProvider,
) -> Result<bool> {
    match handle.consume_provider_dispatch(claim).await? {
        DispatchConsumption::DispatchNow => {
            let scope = handle
                .inspect_fixture_scope(&claim.provider.run.conversation_id)
                .await?;
            assert_eq!(scope.delivery_unknown, 1);
            assert_eq!(scope.reservations, 0);
            // Test oracle: a new transaction already sees unknown BEFORE FAKE I/O.
            assert_eq!(
                handle.consume_provider_dispatch(claim).await?,
                DispatchConsumption::ReconciliationRequired
            );
            fake.start(&claim.provider.run)
                .expect("explicit synthetic start");
            Ok(true)
        }
        DispatchConsumption::ReconciliationRequired => Ok(false),
    }
}

#[cfg(feature = "fixture-test-controls")]
#[path = "fixture_dispatch/controlled.rs"]
mod controlled;

#[tokio::test]
async fn independent_admission_reservation_consumption_have_one_winner_and_one_fake_start() {
    let f = Fixture::new().await;
    let second = f.handle.reattach(&f.b).await.unwrap();
    let (left, right) = tokio::join!(f.admit(&f.handle), f.admit(&second));
    assert_eq!(left.provider, right.provider);
    let (fresh, replay) = match (left.disposition, right.disposition) {
        (AdmissionDisposition::FreshCandidate, AdmissionDisposition::Replay) => (left, right),
        (AdmissionDisposition::Replay, AdmissionDisposition::FreshCandidate) => (right, left),
        _ => panic!("one fresh admission only"),
    };
    assert!(fresh.candidate_key.is_some());
    assert!(replay.candidate_key.is_none());
    assert!(matches!(
        second
            .claim_provider_dispatch(&replay, "synthetic-reserve")
            .await
            .unwrap(),
        DispatchClaimResult::Replay
    ));
    let (a, b) = tokio::join!(
        f.handle
            .claim_provider_dispatch(&fresh, "synthetic-reserve"),
        second.claim_provider_dispatch(&fresh, "synthetic-reserve")
    );
    let reserved = match (a.unwrap(), b.unwrap()) {
        (DispatchClaimResult::Reserved(r), DispatchClaimResult::Replay)
        | (DispatchClaimResult::Replay, DispatchClaimResult::Reserved(r)) => r,
        _ => panic!("one reservation locator only"),
    };
    let mut fake_a = FakeProvider::fixture_only(true).unwrap();
    let mut fake_b = FakeProvider::fixture_only(true).unwrap();
    let (a, b) = tokio::join!(
        consume_then_fake(&f.handle, &reserved, &mut fake_a),
        consume_then_fake(&second, &reserved, &mut fake_b)
    );
    assert_eq!(usize::from(a.unwrap()) + usize::from(b.unwrap()), 1);
    let events = [
        fake_a.poll(&reserved.provider.run),
        fake_b.poll(&reserved.provider.run),
    ];
    assert_eq!(
        events
            .iter()
            .filter(|e| **e == Ok(Some(ProviderEvent::Started)))
            .count(),
        1
    );
    assert!(!consume_then_fake(&second, &reserved, &mut fake_b)
        .await
        .unwrap());
    f.close().await;
}

#[tokio::test]
async fn admission_pool_reopen_returns_replay_without_candidate_or_reservation() {
    let f = Fixture::new().await;
    let initial = f.admit(&f.handle).await;
    assert_eq!(initial.disposition, AdmissionDisposition::FreshCandidate);
    assert!(initial.candidate_key.is_some());
    f.close().await;
    let reopened = Store::open(&f.root.join("fixture.sqlite3")).await.unwrap();
    let attached = f.handle.reattach(&reopened).await.unwrap();
    let replay = f.admit(&attached).await;
    assert_eq!(replay.provider, initial.provider);
    assert_eq!(replay.disposition, AdmissionDisposition::Replay);
    assert!(replay.candidate_key.is_none());
    assert!(matches!(
        attached
            .claim_provider_dispatch(&replay, "synthetic-reserve")
            .await
            .unwrap(),
        DispatchClaimResult::Replay
    ));
    let mut untouched = FakeProvider::fixture_only(true).unwrap();
    assert_eq!(
        untouched.poll(&replay.provider.run),
        Err(orkestr_runtime::ports::Blocker::UnknownSession)
    );
    reopened.close().await;
}

#[tokio::test]
async fn discarded_consumption_reply_then_pool_reopen_cannot_redispatch_or_return_locators() {
    let f = Fixture::new().await;
    let reserved = f.reserve().await;
    // Caller deliberately discards a successful reply before I/O. This does not
    // inject a transport failure or exercise Core's private crash checkpoints.
    assert_eq!(
        f.handle.consume_provider_dispatch(&reserved).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    f.close().await;
    let reopened = Store::open(&f.root.join("fixture.sqlite3")).await.unwrap();
    let attached = f.handle.reattach(&reopened).await.unwrap();
    let replay = f.admit(&attached).await;
    assert_eq!(
        replay.disposition,
        AdmissionDisposition::ReconciliationRequired
    );
    assert!(replay.candidate_key.is_none());
    assert!(matches!(
        attached
            .claim_provider_dispatch(&replay, "synthetic-reserve")
            .await
            .unwrap(),
        DispatchClaimResult::ReconciliationRequired
    ));
    let mut recreated = FakeProvider::fixture_only(true).unwrap();
    assert!(!consume_then_fake(&attached, &reserved, &mut recreated)
        .await
        .unwrap());
    assert_eq!(
        recreated.poll(&reserved.provider.run),
        Err(orkestr_runtime::ports::Blocker::UnknownSession)
    );
    reopened.close().await;
}

#[tokio::test]
async fn store_refuses_changed_role_or_fence_before_fake_io() {
    let f = Fixture::new().await;
    let reserved = f.reserve().await;
    let mut fake = FakeProvider::fixture_only(true).unwrap();
    for change_role in [true, false] {
        let mut changed = reserved.clone();
        if change_role {
            changed.provider.run.role = Role::Worker;
        } else {
            changed.provider.run.dispatch_fence += 1;
        }
        assert_eq!(
            consume_then_fake(&f.handle, &changed, &mut fake).await,
            Err(if change_role {
                RuntimeStoreError::Conflict
            } else {
                RuntimeStoreError::Fenced
            })
        );
    }
    assert_eq!(
        fake.poll(&reserved.provider.run),
        Err(orkestr_runtime::ports::Blocker::UnknownSession)
    );
    assert!(consume_then_fake(&f.handle, &reserved, &mut fake)
        .await
        .unwrap());
    f.close().await;
}
