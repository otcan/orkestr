use super::*;
use std::path::PathBuf;

fn config(
    namespace: &str,
    key: &str,
    takeover: FixtureTakeover,
) -> ExplicitFixtureSupervisorConfig {
    ExplicitFixtureSupervisorConfig {
        namespace: namespace.into(),
        supervisor_key: key.into(),
        takeover,
    }
}
async fn fixture() -> (Store, Store, PathBuf, OwnerId) {
    let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"))
        .join(format!("fixture-context-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("core.sqlite3");
    let a = Store::open(&path).await.unwrap();
    a.setup("synthetic-owner", "synthetic-hash").await.unwrap();
    let (owner, _) = a.credentials("synthetic-owner").await.unwrap().unwrap();
    let b = Store::open(&path).await.unwrap();
    (a, b, root, owner)
}
async fn expire(store: &Store, handle: &FixtureSupervisorStore) {
    // Core-owned test-only control: no exported clock setter or production hook.
    sqlx::query("UPDATE fixture_supervisors SET lease_deadline_ms=0 WHERE context_id=?")
        .bind(handle.context_id.to_string())
        .execute(&store.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn independent_connection_bootstrap_has_one_winner_and_reattaches_after_reopen() {
    let (a, b, root, owner) = fixture().await;
    let (left, right) = tokio::join!(
        bootstrap_fixture_supervisor(
            &a,
            &owner,
            config("fixture", "supervisor", FixtureTakeover::First)
        ),
        bootstrap_fixture_supervisor(
            &b,
            &owner,
            config("fixture", "supervisor", FixtureTakeover::First)
        )
    );
    assert_ne!(left.is_ok(), right.is_ok());
    let handle = match (left, right) {
        (Ok(h), Err(RuntimeStoreError::Conflict)) | (Err(RuntimeStoreError::Conflict), Ok(h)) => h,
        _ => panic!("exactly one first bootstrap must win"),
    };
    let attached = handle.reattach(&b).await.unwrap();
    attached.validate_context().await.unwrap();
    a.close().await;
    b.close().await;
    let reopened = Store::open(&root.join("core.sqlite3")).await.unwrap();
    handle
        .reattach(&reopened)
        .await
        .unwrap()
        .validate_context()
        .await
        .unwrap();
    reopened.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn takeover_requires_expiry_and_exact_predecessor_with_one_winner() {
    let (a, b, root, owner) = fixture().await;
    let h = bootstrap_fixture_supervisor(
        &a,
        &owner,
        config("fixture", "supervisor", FixtureTakeover::First),
    )
    .await
    .unwrap();
    let predecessor = h.incarnation_id();
    assert!(matches!(
        bootstrap_fixture_supervisor(
            &b,
            &owner,
            config(
                "fixture",
                "supervisor",
                FixtureTakeover::ExpiredPredecessor {
                    incarnation_id: predecessor
                }
            )
        )
        .await,
        Err(RuntimeStoreError::Busy)
    ));
    expire(&a, &h).await;
    assert_eq!(h.validate_context().await, Err(RuntimeStoreError::Expired));
    assert!(matches!(
        bootstrap_fixture_supervisor(
            &b,
            &owner,
            config(
                "fixture",
                "supervisor",
                FixtureTakeover::ExpiredPredecessor {
                    incarnation_id: Uuid::new_v4()
                }
            )
        )
        .await,
        Err(RuntimeStoreError::Conflict)
    ));
    let (left, right) = tokio::join!(
        bootstrap_fixture_supervisor(
            &a,
            &owner,
            config(
                "fixture",
                "supervisor",
                FixtureTakeover::ExpiredPredecessor {
                    incarnation_id: predecessor
                }
            )
        ),
        bootstrap_fixture_supervisor(
            &b,
            &owner,
            config(
                "fixture",
                "supervisor",
                FixtureTakeover::ExpiredPredecessor {
                    incarnation_id: predecessor
                }
            )
        )
    );
    let winner = match (left, right) {
        (Ok(h), Err(RuntimeStoreError::Conflict)) | (Err(RuntimeStoreError::Conflict), Ok(h)) => h,
        _ => panic!("exactly one takeover must win"),
    };
    winner.validate_context().await.unwrap();
    assert_eq!(h.validate_context().await, Err(RuntimeStoreError::Fenced));
    assert!(matches!(
        h.reattach(&b).await,
        Err(RuntimeStoreError::Fenced)
    ));
    a.close().await;
    b.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn owner_namespace_key_and_database_contexts_are_isolated() {
    let (a, b, root, owner) = fixture().await;
    let h =
        bootstrap_fixture_supervisor(&a, &owner, config("fixture", "one", FixtureTakeover::First))
            .await
            .unwrap();
    let other_key =
        bootstrap_fixture_supervisor(&b, &owner, config("fixture", "two", FixtureTakeover::First))
            .await
            .unwrap();
    let other_namespace =
        bootstrap_fixture_supervisor(&b, &owner, config("other", "one", FixtureTakeover::First))
            .await
            .unwrap();
    assert!(matches!(
        bootstrap_fixture_supervisor(
            &a,
            &OwnerId(Uuid::new_v4()),
            config("fixture", "one", FixtureTakeover::First)
        )
        .await,
        Err(RuntimeStoreError::NotFound)
    ));
    assert!(matches!(
        bootstrap_fixture_supervisor(
            &a,
            &owner,
            config("bad/namespace", "one", FixtureTakeover::First)
        )
        .await,
        Err(RuntimeStoreError::InvalidInput)
    ));
    expire(&a, &h).await;
    bootstrap_fixture_supervisor(
        &a,
        &owner,
        config(
            "fixture",
            "one",
            FixtureTakeover::ExpiredPredecessor {
                incarnation_id: h.incarnation_id(),
            },
        ),
    )
    .await
    .unwrap();
    other_key.validate_context().await.unwrap();
    other_namespace.validate_context().await.unwrap();
    let (foreign, foreign_b, foreign_root, foreign_owner) = fixture().await;
    bootstrap_fixture_supervisor(
        &foreign,
        &foreign_owner,
        config("fixture", "two", FixtureTakeover::First),
    )
    .await
    .unwrap();
    assert!(matches!(
        other_key.reattach(&foreign).await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    a.close().await;
    b.close().await;
    foreign.close().await;
    foreign_b.close().await;
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(foreign_root).unwrap();
}
