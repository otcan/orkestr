//! Actual SQLite and FAKE composition. Pool reopen is not process-crash evidence.
#[path = "supervisor.rs"]
mod supervisor;
use self::supervisor::FixtureSupervisor;
use orkestr_runtime::{ports::Blocker, supervisor::Error};
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{ConversationEvent, MessageInput};
use orkestr_v2_store_sqlite::{
    fixture_runtime::{
        bootstrap_fixture_supervisor, ExplicitFixtureSupervisorConfig, FixtureTakeover,
    },
    Store,
};
use std::{
    io::ErrorKind,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    store: Store,
    second: Store,
    binding: Binding,
    claim: InboxClaim,
    supervisor: FixtureSupervisor,
}
impl Fixture {
    async fn new() -> Self {
        let home = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"));
        std::fs::create_dir_all(&home).unwrap();
        let root = loop {
            let root = home.join(format!(
                "fixture-composition-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            match std::fs::create_dir(&root) {
                Ok(()) => break root,
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("fixture directory: {error}"),
            }
        };
        let store = Store::open(&root.join("fixture.sqlite3")).await.unwrap();
        let conversation = store
            .setup("synthetic-owner", "synthetic-hash")
            .await
            .unwrap();
        let (owner, _) = store.credentials("synthetic-owner").await.unwrap().unwrap();
        let handle = bootstrap_fixture_supervisor(
            &store,
            &owner,
            ExplicitFixtureSupervisorConfig {
                namespace: "fixture-composition".into(),
                supervisor_key: "synthetic-supervisor".into(),
                takeover: FixtureTakeover::First,
            },
        )
        .await
        .unwrap();
        let roles = store
            .ensure_role_bindings(&owner, &conversation)
            .await
            .unwrap();
        let binding = handle
            .confirm_fixture_readiness(&roles.deep.session_id, 1)
            .await
            .unwrap();
        store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: "synthetic-input".into(),
                    text: "Synthetic fixture input".into(),
                },
            )
            .await
            .unwrap();
        let claim = store
            .claim_next(
                &owner,
                &conversation,
                &binding.session_id,
                Duration::from_secs(60),
            )
            .await
            .unwrap()
            .unwrap();
        let second = Store::open(&root.join("fixture.sqlite3")).await.unwrap();
        Self {
            root,
            store,
            second,
            binding,
            claim,
            supervisor: FixtureSupervisor::new(handle),
        }
    }
    async fn events(&self) -> Vec<ConversationEvent> {
        self.second
            .events(&self.claim.owner_id, &self.claim.conversation_id, 0, 100)
            .await
            .unwrap()
    }
    async fn close(self) {
        self.store.close().await;
        self.second.close().await;
        drop(self.supervisor);
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

#[tokio::test]
async fn durable_deep_composition_records_started_and_synthetic_proposal_without_success() {
    let mut f = Fixture::new().await;
    f.supervisor
        .start(&f.claim, &f.binding, "run")
        .await
        .unwrap();
    assert_eq!(f.supervisor.starts(), 1);
    let scope = f
        .supervisor
        .handle
        .inspect_fixture_scope(&f.claim.conversation_id)
        .await
        .unwrap();
    assert_eq!(scope.acknowledged, 1);
    assert_eq!(scope.delivery_unknown, 1);
    assert_eq!(scope.reservations, 0);
    assert!(f.supervisor.step().await.unwrap());
    f.supervisor
        .emit(ProviderEvent::CompletedProposal { synthetic: true })
        .unwrap();
    assert!(f.supervisor.step().await.unwrap());
    let events = f.events().await;
    assert_eq!(events.len(), 3);
    assert_eq!(
        events
            .iter()
            .map(ConversationEvent::sse_name)
            .collect::<Vec<_>>(),
        vec![
            "message_accepted",
            "fixture_provider_observed",
            "fixture_provider_observed"
        ]
    );
    let replay = f
        .supervisor
        .handle
        .admit_run(&f.claim, &f.binding.session_id, f.binding.generation, "run")
        .await
        .unwrap();
    assert_eq!(replay.run_state, RunState::AwaitingAcceptance);
    assert_eq!(
        replay.disposition,
        AdmissionDisposition::ReconciliationRequired
    );
    assert!(replay.candidate_key.is_none());
    assert_eq!(
        f.supervisor.start(&f.claim, &f.binding, "run").await,
        Err(Error::Provider(Blocker::DispatchUnconfirmed))
    );
    assert_eq!(f.supervisor.starts(), 1);
    assert_eq!(
        serde_json::to_vec(&f.events().await).unwrap(),
        serde_json::to_vec(&events).unwrap()
    );
    f.close().await;
}

#[tokio::test]
async fn durable_control_acknowledges_only_real_fake_stop_without_repoll_or_redispatch() {
    let mut f = Fixture::new().await;
    f.supervisor
        .start(&f.claim, &f.binding, "run")
        .await
        .unwrap();
    assert!(f.supervisor.step().await.unwrap());
    let (cancel, interrupt) = f.supervisor.cancel("cancel").await.unwrap();
    assert_eq!(cancel.state, RunState::CancelRequested);
    assert_eq!(cancel.inflight_status, InflightStatus::Unknown);
    assert_eq!(interrupt, Ok(()));
    assert!(f.supervisor.acknowledge_stop().await.unwrap());
    assert!(!f.supervisor.acknowledge_stop().await.unwrap());
    assert_eq!(
        f.supervisor.cancel("cancel").await.unwrap(),
        (cancel, Ok(()))
    );
    let events = f.events().await;
    assert_eq!(
        events
            .iter()
            .map(ConversationEvent::sse_name)
            .collect::<Vec<_>>(),
        vec![
            "message_accepted",
            "fixture_provider_observed",
            "fixture_cancellation_requested",
            "fixture_provider_stopped"
        ]
    );
    assert_eq!(f.supervisor.starts(), 1);
    assert_eq!(
        f.supervisor.start(&f.claim, &f.binding, "run").await,
        Err(Error::Provider(Blocker::DispatchUnconfirmed))
    );
    assert_eq!(
        serde_json::to_vec(&f.events().await).unwrap(),
        serde_json::to_vec(&events).unwrap()
    );
    f.close().await;
}

#[tokio::test]
async fn cancellation_preserves_racing_terminal_and_does_not_fabricate_stopped() {
    let mut f = Fixture::new().await;
    f.supervisor
        .start(&f.claim, &f.binding, "run")
        .await
        .unwrap();
    f.supervisor.step().await.unwrap();
    f.supervisor
        .emit(ProviderEvent::CompletedProposal { synthetic: true })
        .unwrap();
    let (receipt, interrupt) = f.supervisor.cancel("cancel").await.unwrap();
    assert_eq!(receipt.state, RunState::CancelRequested);
    assert_eq!(interrupt, Err(Blocker::Busy));
    let before = f.events().await;
    assert_eq!(
        f.supervisor.acknowledge_stop().await,
        Err(Error::Store(RuntimeStoreError::Fenced))
    );
    assert_eq!(
        f.supervisor.rejected(),
        Some(&ProviderEvent::CompletedProposal { synthetic: true })
    );
    assert_eq!(
        f.supervisor.acknowledge_stop().await,
        Err(Error::Store(RuntimeStoreError::Fenced))
    );
    assert_eq!(
        f.supervisor.cancel("cancel").await.unwrap(),
        (receipt, Err(Blocker::Busy))
    );
    assert_eq!(
        serde_json::to_vec(&f.events().await).unwrap(),
        serde_json::to_vec(&before).unwrap()
    );
    assert_eq!(f.supervisor.starts(), 1);
    f.close().await;
}

#[tokio::test]
async fn role_mismatch_never_admits_and_active_replay_never_starts_replacement_fake() {
    let mut f = Fixture::new().await;
    let mut forged = f.binding.clone();
    forged.role = Role::Worker;
    assert_eq!(
        f.supervisor.start(&f.claim, &forged, "run").await,
        Err(Error::Store(RuntimeStoreError::InvalidInput))
    );
    assert_eq!(f.supervisor.starts(), 0);
    assert_eq!(
        f.supervisor
            .handle
            .inspect_fixture_scope(&f.claim.conversation_id)
            .await
            .unwrap()
            .attempts,
        0
    );
    f.supervisor
        .start(&f.claim, &f.binding, "run")
        .await
        .unwrap();
    let replacement_handle = f.supervisor.handle.reattach(&f.second).await.unwrap();
    let mut replacement = FixtureSupervisor::new(replacement_handle);
    assert_eq!(
        replacement.start(&f.claim, &f.binding, "run").await,
        Err(Error::Provider(Blocker::DispatchUnconfirmed))
    );
    assert_eq!(replacement.starts(), 0);
    assert_eq!(f.supervisor.starts(), 1);
    drop(replacement);
    f.close().await;
}

#[cfg(feature = "fixture-test-controls")]
#[tokio::test]
async fn consumed_unknown_reply_reopen_never_permits_fake_io() {
    let mut f = Fixture::new().await;
    assert_eq!(
        f.supervisor
            .start_discarding_consume_reply(&f.claim, &f.binding, "run")
            .await,
        Err(Error::Store(RuntimeStoreError::Unavailable))
    );
    assert_eq!(f.supervisor.starts(), 0);
    let scope = f
        .supervisor
        .handle
        .inspect_fixture_scope(&f.claim.conversation_id)
        .await
        .unwrap();
    assert_eq!(scope.delivery_unknown, 1);
    assert_eq!(scope.reservations, 0);
    let reopened = Store::open(&f.root.join("fixture.sqlite3")).await.unwrap();
    let mut replacement =
        FixtureSupervisor::new(f.supervisor.handle.reattach(&reopened).await.unwrap());
    assert_eq!(
        replacement.start(&f.claim, &f.binding, "run").await,
        Err(Error::Provider(Blocker::DispatchUnconfirmed))
    );
    assert_eq!(replacement.starts(), 0);
    assert_eq!(f.events().await.len(), 1);
    drop(replacement);
    reopened.close().await;
    f.close().await;
}

#[tokio::test]
async fn polled_stop_survives_store_unavailable_then_retries_without_repoll() {
    let mut f = Fixture::new().await;
    f.supervisor
        .start(&f.claim, &f.binding, "run")
        .await
        .unwrap();
    f.supervisor.step().await.unwrap();
    assert_eq!(f.supervisor.cancel("cancel").await.unwrap().1, Ok(()));
    f.store.close().await;
    assert_eq!(
        f.supervisor.acknowledge_stop().await,
        Err(Error::Store(RuntimeStoreError::Unavailable))
    );
    let before = f.events().await;
    assert_eq!(before.len(), 3);
    let reopened = Store::open(&f.root.join("fixture.sqlite3")).await.unwrap();
    f.supervisor.handle = f.supervisor.handle.reattach(&reopened).await.unwrap();
    assert!(f.supervisor.acknowledge_stop().await.unwrap());
    assert!(!f.supervisor.acknowledge_stop().await.unwrap());
    assert_eq!(f.events().await.len(), 4);
    assert_eq!(f.supervisor.starts(), 1);
    reopened.close().await;
    f.close().await;
}

#[tokio::test]
async fn ordinary_store_and_normal_supervisor_start_remain_blocked() {
    let mut f = Fixture::new().await;
    let mut fake = orkestr_runtime::fake::FakeProvider::fixture_only(true).unwrap();
    assert_eq!(
        orkestr_runtime::supervisor::start(
            &f.store,
            &mut fake,
            &f.claim,
            &f.binding.session_id,
            f.binding.generation,
            "normal",
            Role::Deep
        )
        .await,
        Err(Error::Store(RuntimeStoreError::Unavailable))
    );
    assert_eq!(
        f.supervisor
            .handle
            .inspect_fixture_scope(&f.claim.conversation_id)
            .await
            .unwrap()
            .attempts,
        0
    );
    f.supervisor
        .start(&f.claim, &f.binding, "fixture")
        .await
        .unwrap();
    assert_eq!(f.supervisor.starts(), 1);
    f.close().await;
}
