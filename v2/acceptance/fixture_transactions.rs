//! Independent public-API checks installed as a store integration test at the pinned candidate.
//! Scoped projections establish fixture state; these do not establish process recovery.
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::MessageInput;
use orkestr_v2_store_sqlite::{fixture_runtime::*, Store};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Case {
    path: PathBuf,
    a: Store,
    b: Store,
    h: FixtureSupervisorStore,
    binding: Binding,
    claim: InboxClaim,
}
impl Case {
    async fn new() -> Self {
        let path =
            PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("owned home")).join(format!(
                "independent-tx-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir(&path).unwrap();
        let a = Store::open(&path.join("test.sqlite3")).await.unwrap();
        let conversation = a.setup("synthetic", "synthetic-hash").await.unwrap();
        let owner = a.credentials("synthetic").await.unwrap().unwrap().0;
        let b = Store::open(&path.join("test.sqlite3")).await.unwrap();
        let h = bootstrap_fixture_supervisor(
            &a,
            &owner,
            ExplicitFixtureSupervisorConfig {
                namespace: "independent".into(),
                supervisor_key: "transaction-check".into(),
                takeover: FixtureTakeover::First,
            },
        )
        .await
        .unwrap();
        let roles = a.ensure_role_bindings(&owner, &conversation).await.unwrap();
        let binding = h
            .confirm_fixture_readiness(&roles.deep.session_id, 1)
            .await
            .unwrap();
        a.admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "input".into(),
                text: "Synthetic input".into(),
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
            path,
            a,
            b,
            h,
            binding,
            claim,
        }
    }
    async fn admit(&self, h: &FixtureSupervisorStore) -> RunAdmissionResult {
        h.admit_run(
            &self.claim,
            &self.binding.session_id,
            self.binding.generation,
            "admit",
        )
        .await
        .unwrap()
    }
    async fn close(&self) {
        self.a.close().await;
        self.b.close().await;
    }
}
impl Drop for Case {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
#[tokio::test]
async fn independent_race_and_observer_before_io() {
    let c = Case::new().await;
    let other = c.h.reattach(&c.b).await.unwrap();
    let (a, b) = tokio::join!(c.admit(&c.h), c.admit(&other));
    assert_eq!(a.provider, b.provider);
    assert_eq!(
        c.h.inspect_fixture_scope(&c.claim.conversation_id)
            .await
            .unwrap(),
        FixtureScopeInspection {
            attempts: 1,
            acknowledged: 1,
            reservations: 0,
            delivery_unknown: 0,
            quarantined: 0
        }
    );
    let fresh = match (a.disposition, b.disposition) {
        (AdmissionDisposition::FreshCandidate, AdmissionDisposition::Replay) => {
            assert!(b.candidate_key.is_none());
            a
        }
        (AdmissionDisposition::Replay, AdmissionDisposition::FreshCandidate) => {
            assert!(a.candidate_key.is_none());
            b
        }
        _ => panic!("one fresh response required"),
    };
    let (a, b) = tokio::join!(
        c.h.claim_provider_dispatch(&fresh, "reserve"),
        other.claim_provider_dispatch(&fresh, "reserve")
    );
    let claim = match (a.unwrap(), b.unwrap()) {
        (DispatchClaimResult::Reserved(r), DispatchClaimResult::Replay)
        | (DispatchClaimResult::Replay, DispatchClaimResult::Reserved(r)) => r,
        _ => panic!("one reservation required"),
    };
    let (a, b) = tokio::join!(
        c.h.consume_provider_dispatch(&claim),
        other.consume_provider_dispatch(&claim)
    );
    assert!(matches!(
        (a.unwrap(), b.unwrap()),
        (
            DispatchConsumption::DispatchNow,
            DispatchConsumption::ReconciliationRequired
        ) | (
            DispatchConsumption::ReconciliationRequired,
            DispatchConsumption::DispatchNow
        )
    ));
    // Independently opened THIRD pool observes committed unknown before any synthetic I/O.
    let observer = Store::open(&c.path.join("test.sqlite3")).await.unwrap();
    let h = c.h.reattach(&observer).await.unwrap();
    assert_eq!(
        h.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::ReconciliationRequired
    );
    let replay = c.admit(&h).await;
    assert_eq!(
        replay.disposition,
        AdmissionDisposition::ReconciliationRequired
    );
    assert!(replay.candidate_key.is_none());
    observer.close().await;
    c.close().await;
}
#[tokio::test]
async fn semantic_conflict_and_forged_locators_do_not_consume_authority() {
    let c = Case::new().await;
    let fresh = c.admit(&c.h).await;
    let before =
        c.h.inspect_fixture_scope(&c.claim.conversation_id)
            .await
            .unwrap();
    let mut changed = c.claim.clone();
    changed.scope_sequence += 1;
    assert_eq!(
        c.h.admit_run(
            &changed,
            &c.binding.session_id,
            c.binding.generation,
            "admit"
        )
        .await
        .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    let mut forged = fresh.clone();
    forged.candidate_key = Some("0".repeat(64));
    assert!(matches!(
        c.h.claim_provider_dispatch(&forged, "reserve").await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(
        c.h.inspect_fixture_scope(&c.claim.conversation_id)
            .await
            .unwrap(),
        before
    );
    let claim = match c
        .h
        .claim_provider_dispatch(&fresh, "reserve")
        .await
        .unwrap()
    {
        DispatchClaimResult::Reserved(r) => r,
        _ => panic!("reserved"),
    };
    for role in [true, false] {
        let mut changed = (*claim).clone();
        if role {
            changed.provider.run.role = Role::Worker;
        } else {
            changed.provider.run.dispatch_fence += 1;
        }
        assert_eq!(
            c.h.consume_provider_dispatch(&changed).await.unwrap_err(),
            if role {
                RuntimeStoreError::Conflict
            } else {
                RuntimeStoreError::Fenced
            }
        );
    }
    let mut forged = (*claim).clone();
    forged.reservation_key = "0".repeat(64);
    assert_eq!(
        c.h.consume_provider_dispatch(&forged).await.unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert_eq!(
        c.h.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    c.close().await;
}
#[tokio::test]
async fn discarded_reply_pool_reopen_and_ordinary_store_fail_closed() {
    let c = Case::new().await;
    assert!(matches!(
        c.a.admit_run(
            &c.claim,
            &c.binding.session_id,
            c.binding.generation,
            "ordinary"
        )
        .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    let fresh = c.admit(&c.h).await;
    let claim = match c
        .h
        .claim_provider_dispatch(&fresh, "reserve")
        .await
        .unwrap()
    {
        DispatchClaimResult::Reserved(r) => r,
        _ => panic!("reserved"),
    };
    assert_eq!(
        c.h.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    // Successful result intentionally discarded; not a transport failpoint or process restart.
    c.close().await;
    let reopened = Store::open(&c.path.join("test.sqlite3")).await.unwrap();
    let h = c.h.reattach(&reopened).await.unwrap();
    let replay = c.admit(&h).await;
    assert_eq!(
        replay.disposition,
        AdmissionDisposition::ReconciliationRequired
    );
    assert!(replay.candidate_key.is_none());
    assert!(matches!(
        h.claim_provider_dispatch(&replay, "reserve").await.unwrap(),
        DispatchClaimResult::ReconciliationRequired
    ));
    assert_eq!(
        h.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::ReconciliationRequired
    );
    reopened.close().await;
}

#[cfg(feature = "fixture-test-controls")]
#[tokio::test]
async fn expiry_takeover_quarantines_reserved_predecessor_without_touching_other_context() {
    let c = Case::new().await;
    let other = bootstrap_fixture_supervisor(
        &c.b,
        &c.claim.owner_id,
        ExplicitFixtureSupervisorConfig {
            namespace: "unrelated".into(),
            supervisor_key: "unrelated".into(),
            takeover: FixtureTakeover::First,
        },
    )
    .await
    .unwrap();
    let fresh = c.admit(&c.h).await;
    let reserved = match c
        .h
        .claim_provider_dispatch(&fresh, "reserve")
        .await
        .unwrap()
    {
        DispatchClaimResult::Reserved(r) => r,
        _ => panic!("reserved"),
    };
    c.h.fixture_expire_context().await.unwrap();
    assert_eq!(
        c.h.consume_provider_dispatch(&reserved).await.unwrap_err(),
        RuntimeStoreError::Expired
    );
    let config = || ExplicitFixtureSupervisorConfig {
        namespace: "independent".into(),
        supervisor_key: "transaction-check".into(),
        takeover: FixtureTakeover::ExpiredPredecessor {
            incarnation_id: c.h.incarnation_id(),
        },
    };
    let (a, b) = tokio::join!(
        bootstrap_fixture_supervisor(&c.a, &c.claim.owner_id, config()),
        bootstrap_fixture_supervisor(&c.b, &c.claim.owner_id, config())
    );
    let winner = match (a, b) {
        (Ok(h), Err(RuntimeStoreError::Conflict)) | (Err(RuntimeStoreError::Conflict), Ok(h)) => h,
        _ => panic!("one successor"),
    };
    assert_eq!(
        c.h.validate_context().await.unwrap_err(),
        RuntimeStoreError::Fenced
    );
    let row = winner
        .inspect_fixture_attempt(&c.claim.conversation_id, "admit")
        .await
        .unwrap()
        .unwrap();
    assert!(row.blocked && row.inbox_acknowledged);
    assert_eq!(row.dispatch, FixtureDispatchState::Quarantined);
    assert!(!row.candidate_verifier_present && !row.reservation_verifier_present);
    assert_eq!(
        winner
            .inspect_fixture_scope(&c.claim.conversation_id)
            .await
            .unwrap(),
        FixtureScopeInspection {
            attempts: 1,
            acknowledged: 1,
            reservations: 0,
            delivery_unknown: 0,
            quarantined: 1
        }
    );
    assert!(matches!(
        winner.consume_provider_dispatch(&reserved).await,
        Err(RuntimeStoreError::Fenced)
    ));
    other.validate_context().await.unwrap();
    assert_eq!(
        other
            .inspect_fixture_scope(&c.claim.conversation_id)
            .await
            .unwrap(),
        FixtureScopeInspection {
            attempts: 0,
            acknowledged: 0,
            reservations: 0,
            delivery_unknown: 0,
            quarantined: 0
        }
    );
    c.close().await;
}
#[cfg(feature = "fixture-test-controls")]
#[tokio::test]
async fn unavailable_reply_control_persists_unknown_without_locator_verifiers() {
    let c = Case::new().await;
    let fresh = c.admit(&c.h).await;
    let reserved = match c
        .h
        .claim_provider_dispatch(&fresh, "reserve")
        .await
        .unwrap()
    {
        DispatchClaimResult::Reserved(r) => r,
        _ => panic!("reserved"),
    };
    assert_eq!(
        c.h.fixture_consume_without_reply(&reserved)
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    let observer = c.h.reattach(&c.b).await.unwrap();
    let row = observer
        .inspect_fixture_attempt(&c.claim.conversation_id, "admit")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.dispatch, FixtureDispatchState::DeliveryUnknown);
    assert!(!row.candidate_verifier_present && !row.reservation_verifier_present);
    assert_eq!(
        observer.consume_provider_dispatch(&reserved).await.unwrap(),
        DispatchConsumption::ReconciliationRequired
    );
    c.close().await;
}

#[path = "independent_transactions/negative.rs"]
mod negative;
