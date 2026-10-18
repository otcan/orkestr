//! Full-row read-only oracles for independently authored process tests.
use super::*;
use sqlx::Row;
// All columns, stable ordering, a single read-only transaction. Private values
// remain in memory; only hashes and public envelope fields cross exec boundaries.
pub(super) async fn snapshot(root: &Path) -> Vec<Vec<String>> {
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(root.join("case.sqlite3"))
            .read_only(true),
    )
    .await
    .unwrap();
    sqlx::query("PRAGMA query_only=ON")
        .execute(&mut db)
        .await
        .unwrap();
    let mut tx = db.begin().await.unwrap();
    let mut result = Vec::new();
    for table in [
        "conversations",
        "events",
        "outbox",
        "fixture_observations",
        "fixture_runs",
        "reasoning_inbox",
        "session_bindings",
        "fixture_supervisors",
        "fixture_readiness",
    ] {
        let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *tx)
            .await
            .unwrap()
            .iter()
            .map(|r| format!("\"{}\"", r.get::<String, _>("name")))
            .collect::<Vec<_>>()
            .join(",");
        result.push(
            sqlx::query_scalar(&format!(
                "SELECT json_array({columns}) FROM {table} ORDER BY rowid"
            ))
            .fetch_all(&mut *tx)
            .await
            .unwrap(),
        );
    }
    tx.commit().await.unwrap();
    db.close().await.unwrap();
    result
}
pub(super) fn fingerprints(rows: &[Vec<String>]) -> Value {
    use sha2::{Digest, Sha256};
    json!(rows
        .iter()
        .map(|table| {
            let mut hash = Sha256::new();
            for row in table {
                hash.update((row.len() as u64).to_be_bytes());
                hash.update(row.as_bytes());
            }
            format!("{:x}", hash.finalize())
        })
        .collect::<Vec<_>>())
}
pub(super) async fn expected_projections(root: &Path, rows: &[Vec<String>]) -> Value {
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(root.join("case.sqlite3"))
            .read_only(true),
    )
    .await
    .unwrap();
    sqlx::query("PRAGMA query_only=ON")
        .execute(&mut db)
        .await
        .unwrap();
    let mut expected = rows.to_vec();
    for (table, index, column, value) in [
        ("conversations", 0, "sequence", json!(2)),
        ("fixture_runs", 4, "state", json!("running")),
    ] {
        let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut db)
            .await
            .unwrap();
        let column = columns
            .iter()
            .position(|r| r.get::<String, _>("name") == column)
            .unwrap();
        let mut row: Value = serde_json::from_str(&expected[index][0]).unwrap();
        row[column] = value;
        expected[index][0] = serde_json::to_string(&row).unwrap();
    }
    db.close().await.unwrap();
    fingerprints(&expected)
}
