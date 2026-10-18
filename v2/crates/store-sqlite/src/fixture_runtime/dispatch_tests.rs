use super::*;
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{ConversationId, MessageInput};
use std::{path::PathBuf, time::Duration};

pub(super) struct Fixture {
    pub a: Store,
    pub b: Store,
    pub root: PathBuf,
    pub owner: OwnerId,
    pub conversation: ConversationId,
    pub handle: FixtureSupervisorStore,
    pub binding: Binding,
    pub claim: InboxClaim,
}
pub(super) async fn fixture() -> Fixture {
    let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"))
        .join(format!("fixture-dispatch-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let a = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let conversation = a.setup("synthetic-owner", "synthetic-hash").await.unwrap();
    let (owner, _) = a.credentials("synthetic-owner").await.unwrap().unwrap();
    let b = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let handle = bootstrap_fixture_supervisor(
        &a,
        &owner,
        ExplicitFixtureSupervisorConfig {
            namespace: "explicit-fixture".into(),
            supervisor_key: "fixture-worker".into(),
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
            client_message_id: "input1".into(),
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
    Fixture {
        a,
        b,
        root,
        owner,
        conversation,
        handle,
        binding,
        claim,
    }
}
impl Fixture {
    pub async fn admit(&self) -> RunAdmissionResult {
        self.handle
            .admit_run(
                &self.claim,
                &self.binding.session_id,
                self.binding.generation,
                "run1",
            )
            .await
            .unwrap()
    }
    pub async fn cleanup(self) {
        self.a.close().await;
        self.b.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

#[tokio::test]
async fn atomic_admission_race_replay_rollback_and_followup() {
    let f = fixture().await;
    let second = f.handle.reattach(&f.b).await.unwrap();
    let (a, b) = tokio::join!(
        f.handle.admit_run(
            &f.claim,
            &f.binding.session_id,
            f.binding.generation,
            "run1"
        ),
        second.admit_run(
            &f.claim,
            &f.binding.session_id,
            f.binding.generation,
            "run1"
        )
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a.provider, b.provider);
    assert_eq!(
        usize::from(a.candidate_key.is_some()) + usize::from(b.candidate_key.is_some()),
        1
    );
    assert!(matches!(
        (a.disposition, b.disposition),
        (
            AdmissionDisposition::FreshCandidate,
            AdmissionDisposition::Replay
        ) | (
            AdmissionDisposition::Replay,
            AdmissionDisposition::FreshCandidate
        )
    ));
    let mut changed = f.claim.clone();
    changed.lease_deadline_ms += 1;
    assert_eq!(
        f.handle
            .admit_run(
                &changed,
                &f.binding.session_id,
                f.binding.generation,
                "run1"
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    let row = sqlx::query(
        "SELECT state,admitted_fixture_run_id FROM reasoning_inbox WHERE conversation_id=?",
    )
    .bind(f.conversation.to_string())
    .fetch_one(&f.b.pool)
    .await
    .unwrap();
    assert_eq!(row.get::<&str, _>("state"), "consumed");
    assert_eq!(
        row.get::<String, _>("admitted_fixture_run_id"),
        a.provider.run.run_id.to_string()
    );
    f.a.admit(
        &f.owner,
        &f.conversation,
        &MessageInput {
            client_message_id: "followup".into(),
            text: "Follow-up".into(),
        },
    )
    .await
    .unwrap();
    let followup =
        f.a.claim_next(
            &f.owner,
            &f.conversation,
            &f.binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(followup.scope_sequence > f.claim.scope_sequence);
    assert_eq!(
        f.handle
            .admit_run(
                &followup,
                &f.binding.session_id,
                f.binding.generation,
                "run2"
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::Busy
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT state FROM reasoning_inbox WHERE message_id=?")
            .bind(followup.message_id.to_string())
            .fetch_one(&f.a.pool)
            .await
            .unwrap(),
        "claimed"
    );
    f.cleanup().await;

    // Injection after run insertion but before ack proves the whole transaction rolls back.
    let f = fixture().await;
    sqlx::query("CREATE TRIGGER fixture_fail_ack BEFORE UPDATE ON reasoning_inbox WHEN NEW.state='consumed' BEGIN SELECT RAISE(ABORT,'synthetic ack failure'); END").execute(&f.a.pool).await.unwrap();
    assert_eq!(
        f.handle
            .admit_run(
                &f.claim,
                &f.binding.session_id,
                f.binding.generation,
                "run1"
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM fixture_runs")
            .fetch_one(&f.b.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT state FROM reasoning_inbox")
            .fetch_one(&f.b.pool)
            .await
            .unwrap(),
        "claimed"
    );
    sqlx::query("DROP TRIGGER fixture_fail_ack")
        .execute(&f.a.pool)
        .await
        .unwrap();
    assert_eq!(
        f.admit().await.disposition,
        AdmissionDisposition::FreshCandidate
    );
    f.cleanup().await;
}

#[tokio::test]
async fn independent_reserve_consume_winners_and_reopen_never_redispatch() {
    let f = fixture().await;
    let second = f.handle.reattach(&f.b).await.unwrap();
    let fresh = f.admit().await;
    let (a, b) = tokio::join!(
        f.handle.claim_provider_dispatch(&fresh, "reserve1"),
        second.claim_provider_dispatch(&fresh, "reserve1")
    );
    let claim = match (a.unwrap(), b.unwrap()) {
        (DispatchClaimResult::Reserved(c), DispatchClaimResult::Replay)
        | (DispatchClaimResult::Replay, DispatchClaimResult::Reserved(c)) => c,
        _ => panic!("one reservation only"),
    };
    assert!(matches!(
        f.handle
            .claim_provider_dispatch(&fresh, "changed-key")
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    let (a, b) = tokio::join!(
        f.handle.consume_provider_dispatch(&claim),
        second.consume_provider_dispatch(&claim)
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
    let stored: String = sqlx::query_scalar("SELECT dispatch_state FROM fixture_runs")
        .fetch_one(&f.b.pool)
        .await
        .unwrap();
    assert_eq!(stored, "delivery_unknown");
    f.a.close().await;
    f.b.close().await;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let handle = f.handle.reattach(&reopened).await.unwrap();
    assert_eq!(
        handle.consume_provider_dispatch(&claim).await.unwrap(),
        DispatchConsumption::ReconciliationRequired
    );
    let replay = handle
        .admit_run(
            &f.claim,
            &f.binding.session_id,
            f.binding.generation,
            "run1",
        )
        .await
        .unwrap();
    assert_eq!(
        replay.disposition,
        AdmissionDisposition::ReconciliationRequired
    );
    assert!(replay.candidate_key.is_none());
    // Ordinary Store never gains execution authority, even for a valid fixture admission.
    assert_eq!(
        reopened
            .consume_provider_dispatch(&claim)
            .await
            .unwrap_err(),
        RuntimeStoreError::Unavailable
    );
    reopened.close().await;
    f.cleanup().await;
}

#[tokio::test]
async fn readiness_scope_role_fence_and_takeover_are_fail_closed() {
    let f = fixture().await;
    let roles =
        f.a.ensure_role_bindings(&f.owner, &f.conversation)
            .await
            .unwrap();
    assert_eq!(
        f.handle
            .confirm_fixture_readiness(&roles.fast.session_id, 1)
            .await
            .unwrap_err(),
        RuntimeStoreError::InvalidInput
    );
    assert_eq!(
        f.handle
            .confirm_fixture_readiness(&f.binding.session_id, 2)
            .await
            .unwrap_err(),
        RuntimeStoreError::InvalidInput
    );
    let mut wrong = f.claim.clone();
    wrong.owner_id = OwnerId(Uuid::new_v4());
    assert_eq!(
        f.handle
            .admit_run(&wrong, &f.binding.session_id, f.binding.generation, "run1")
            .await
            .unwrap_err(),
        RuntimeStoreError::Unauthorized
    );
    assert_eq!(
        f.handle
            .admit_run(
                &f.claim,
                &roles.fast.session_id,
                roles.fast.generation,
                "run1"
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert_eq!(
        f.handle
            .admit_run(
                &f.claim,
                &f.binding.session_id,
                f.binding.generation + 1,
                "run1"
            )
            .await
            .unwrap_err(),
        RuntimeStoreError::StaleLease
    );
    let fresh = f.admit().await;
    let mut forged = fresh.clone();
    forged.provider.run.dispatch_fence += 1;
    assert_eq!(
        f.handle
            .claim_provider_dispatch(&forged, "reserve")
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    let mut forged = fresh.clone();
    forged.provider.run.role = Role::Worker;
    assert_eq!(
        f.handle
            .claim_provider_dispatch(&forged, "reserve")
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    let other = bootstrap_fixture_supervisor(
        &f.b,
        &f.owner,
        ExplicitFixtureSupervisorConfig {
            namespace: "other".into(),
            supervisor_key: "worker".into(),
            takeover: FixtureTakeover::First,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        other
            .claim_provider_dispatch(&fresh, "reserve")
            .await
            .unwrap_err(),
        RuntimeStoreError::NotFound
    );
    let claim = match f
        .handle
        .claim_provider_dispatch(&fresh, "reserve")
        .await
        .unwrap()
    {
        DispatchClaimResult::Reserved(c) => c,
        _ => panic!(),
    };
    sqlx::query("UPDATE fixture_supervisors SET lease_deadline_ms=0 WHERE context_id=?")
        .bind(f.handle.context_id.to_string())
        .execute(&f.a.pool)
        .await
        .unwrap();
    let replacement = bootstrap_fixture_supervisor(
        &f.b,
        &f.owner,
        ExplicitFixtureSupervisorConfig {
            namespace: "explicit-fixture".into(),
            supervisor_key: "fixture-worker".into(),
            takeover: FixtureTakeover::ExpiredPredecessor {
                incarnation_id: f.handle.incarnation_id(),
            },
        },
    )
    .await
    .unwrap();
    assert_eq!(
        f.handle
            .consume_provider_dispatch(&claim)
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert_eq!(
        replacement
            .consume_provider_dispatch(&claim)
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT dispatch_state FROM fixture_runs")
            .fetch_one(&f.a.pool)
            .await
            .unwrap(),
        "quarantined"
    );
    assert_eq!(
        replacement
            .confirm_fixture_readiness(&f.binding.session_id, 1)
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    f.cleanup().await;
}
