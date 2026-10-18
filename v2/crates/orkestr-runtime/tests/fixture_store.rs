//! Real Core SQLite fixture bootstrap. No Spy, inference or provider dispatch.
//! Admission/readiness/consume coverage awaits Core's executable handoff.
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::OwnerId;
use orkestr_v2_store_sqlite::{
    fixture_runtime::{
        bootstrap_fixture_supervisor, ExplicitFixtureSupervisorConfig, FixtureSupervisorStore,
        FixtureTakeover,
    },
    Store,
};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct FixtureDirectory(PathBuf);
impl FixtureDirectory {
    fn new() -> Self {
        let home = std::env::var_os("ORKESTR_V2_HOME").expect("explicit isolated fixture home");
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = PathBuf::from(home).join(format!(
            "runtime-fixture-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    async fn open(&self) -> Store {
        Store::open(&self.0.join("fixture.sqlite3")).await.unwrap()
    }
}
impl Drop for FixtureDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn config(takeover: FixtureTakeover) -> ExplicitFixtureSupervisorConfig {
    ExplicitFixtureSupervisorConfig {
        namespace: "runtime-synthetic".into(),
        supervisor_key: "runtime-harness".into(),
        takeover,
    }
}
async fn owner(store: &Store) -> OwnerId {
    store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0
}

#[tokio::test]
async fn independent_bootstrap_has_one_winner_then_live_handle_reattaches_after_reopen() {
    let directory = FixtureDirectory::new();
    let first = directory.open().await;
    let owner = owner(&first).await;
    let second = directory.open().await;
    let (a, b) = tokio::join!(
        bootstrap_fixture_supervisor(&first, &owner, config(FixtureTakeover::First)),
        bootstrap_fixture_supervisor(&second, &owner, config(FixtureTakeover::First))
    );
    let winner: FixtureSupervisorStore = match (a, b) {
        (Ok(h), Err(RuntimeStoreError::Conflict)) | (Err(RuntimeStoreError::Conflict), Ok(h)) => h,
        _ => panic!("exactly one authorized fixture bootstrap must win"),
    };
    let attached = winner.reattach(&second).await.unwrap();
    assert_eq!(attached.incarnation_id(), winner.incarnation_id());
    attached.validate_context().await.unwrap();
    first.close().await;
    second.close().await;

    // The original live in-process handle remains required. This is pool reopen,
    // not recovery after process loss and not admission replay acceptance.
    let reopened = directory.open().await;
    let reattached = winner.reattach(&reopened).await.unwrap();
    assert_eq!(reattached.incarnation_id(), winner.incarnation_id());
    reattached.validate_context().await.unwrap();
    assert!(matches!(
        bootstrap_fixture_supervisor(&reopened, &owner, config(FixtureTakeover::First)).await,
        Err(RuntimeStoreError::Conflict)
    ));
    reopened.close().await;
}

#[tokio::test]
async fn active_context_refuses_takeover_and_unrelated_database_reattach() {
    let directory = FixtureDirectory::new();
    let store = directory.open().await;
    let owner = owner(&store).await;
    let handle = bootstrap_fixture_supervisor(&store, &owner, config(FixtureTakeover::First))
        .await
        .unwrap();
    let independent = directory.open().await;
    assert!(matches!(
        bootstrap_fixture_supervisor(
            &independent,
            &owner,
            config(FixtureTakeover::ExpiredPredecessor {
                incarnation_id: handle.incarnation_id(),
            })
        )
        .await,
        Err(RuntimeStoreError::Busy)
    ));
    let unrelated_directory = FixtureDirectory::new();
    let unrelated = unrelated_directory.open().await;
    assert!(matches!(
        handle.reattach(&unrelated).await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    handle.validate_context().await.unwrap();
    independent.close().await;
    unrelated.close().await;
    store.close().await;
}
