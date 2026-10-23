//! Reconstruct schema 71 exactly; never erase observed models from a fixture.
use super::*;

pub(super) async fn downgrade(store: &Store) {
    let mut tx = store.pool.begin().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM production_run_models")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "historical fixture must have no new model evidence"
    );
    for statement in [
        "DROP TABLE production_run_models",
        "ALTER TABLE production_failure_classes RENAME TO failure_class_copy",
        include_str!("../../migrations/0051_observation_failure_class.sql"),
        "INSERT INTO production_failure_classes SELECT * FROM failure_class_copy",
        "DROP TABLE failure_class_copy",
        "DELETE FROM _sqlx_migrations WHERE version=72",
    ] {
        sqlx::raw_sql(statement).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn schema71_upgrade_preserves_existing_failure_class_and_observations() {
    use super::{
        observation_tests::{consumed, input},
        tests::setup,
    };
    use orkestr_v2_contracts::{ExecutionFailureClass, ExecutionPhase};
    let f = setup().await;
    let provider = consumed(&f).await;
    f.handle
        .append_provider_event(
            &f.owner,
            &provider,
            &input(
                &provider,
                1,
                ProviderEvent::FailedWith(ExecutionFailureClass::Authentication),
            ),
        )
        .await
        .unwrap();
    let before: Vec<(String, String, String)> =
        sqlx::query_as("SELECT event_id,run_id,class FROM production_failure_classes")
            .fetch_all(&f.store.pool)
            .await
            .unwrap();
    downgrade(&f.store).await;
    let upgraded = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let after: Vec<(String, String, String)> =
        sqlx::query_as("SELECT event_id,run_id,class FROM production_failure_classes")
            .fetch_all(&upgraded.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    let status = upgraded
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.phase, ExecutionPhase::Failed);
    assert_eq!(
        status.failure.unwrap().class,
        ExecutionFailureClass::Authentication
    );
    assert_eq!(status.models.unwrap().actual_model, None);
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&upgraded.pool)
        .await
        .unwrap()
        .is_empty());
}
