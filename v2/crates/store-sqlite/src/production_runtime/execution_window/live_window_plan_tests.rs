//! The live-window reads use the partial index over unresolved windows, so
//! their cost follows the windows open now, not every window ever opened.
use super::{LIVE_WINDOWS, OTHER_LIVE_WINDOWS, UNRESOLVED_WINDOWS};
use crate::production_runtime::tests::setup;
use sqlx::Row;

async fn plan(store: &crate::Store, sql: &str, binds: usize) -> Vec<String> {
    let text = format!("EXPLAIN QUERY PLAN {sql}");
    let mut q = sqlx::query(&text);
    for _ in 0..binds {
        q = q.bind("synthetic");
    }
    q.fetch_all(&store.pool)
        .await
        .unwrap()
        .iter()
        .map(|row| row.get::<String, _>("detail"))
        .collect()
}

#[tokio::test]
async fn live_window_reads_use_the_unresolved_partial_index() {
    let f = setup().await;
    for (sql, binds) in [
        (LIVE_WINDOWS, 2),
        (OTHER_LIVE_WINDOWS, 3),
        (UNRESOLVED_WINDOWS, 1),
    ] {
        let plan = plan(&f.store, sql, binds).await;
        assert!(
            plan.iter()
                .any(|step| step.contains("execution_window_unresolved")),
            "{sql}: {plan:?}"
        );
    }
}
