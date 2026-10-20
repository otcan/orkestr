//! Upgrade preserves prior uncertainty instead of reviving blocked execution.
use super::*;
use crate::production_runtime::{observation_tests::input as event, tests::setup};

#[tokio::test]
async fn proposal_migration_preserves_old_blocked_children_and_every_prior_row() {
    let f = setup().await;
    let (parent, worker, _) = super::completed_tests::completed_worker(&f).await;
    let old = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/0022_fast_provider_runs.sql"
    ));
    let trigger = old
        .split("CREATE TRIGGER worker_provider_parent_fence")
        .nth(1)
        .unwrap()
        .split("CREATE TEMP TABLE")
        .next()
        .unwrap();
    let mut tx = f.store.pool.begin().await.unwrap();
    sqlx::query("DROP TRIGGER worker_provider_parent_fence")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(&format!(
        "CREATE TRIGGER worker_provider_parent_fence{trigger}"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=44")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    f.handle
        .append_provider_event(
            &f.owner,
            &parent,
            &event(
                &parent,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        super::completed_tests::state(&f, &worker).await,
        ("blocked".into(), "lost".into(), "blocked".into())
    );
    let before = super::tests::ledger(&f.store).await;
    f.store.close().await;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    assert_eq!(super::tests::ledger(&reopened).await, before);
    let latest: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&reopened.pool)
        .await
        .unwrap();
    assert_eq!(latest, 44);
}
