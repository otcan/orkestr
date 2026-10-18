//! Exact field-delta oracles. Fresh opaque values are validated, never printed.
use super::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
pub(super) type Rows = BTreeMap<String, Vec<Value>>;
pub(super) async fn rows(root: &std::path::Path) -> Rows {
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.join("core.sqlite3"))
            .read_only(true),
    )
    .await
    .unwrap();
    sqlx::query("PRAGMA query_only=ON")
        .execute(&mut db)
        .await
        .unwrap();
    let mut tx = db.begin().await.unwrap();
    let mut result = Rows::new();
    for table in [
        "production_supervisors",
        "production_readiness",
        "production_runs",
        "production_run_leases",
        "reasoning_inbox",
        "session_bindings",
        "messages",
        "events",
        "outbox",
        "conversations",
        "execution_revisions",
    ] {
        let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *tx)
            .await
            .unwrap()
            .iter()
            .map(|r| {
                let s: String = r.get("name");
                format!("'{s}',\"{s}\"")
            })
            .collect::<Vec<_>>()
            .join(",");
        let values: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT json_object({columns}) FROM {table} ORDER BY rowid"
        ))
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        result.insert(
            table.into(),
            values
                .iter()
                .map(|s| serde_json::from_str(s).unwrap())
                .collect(),
        );
    }
    tx.commit().await.unwrap();
    db.close().await.unwrap();
    result
}
fn opaque(value: &Value) {
    let s = value.as_str().expect("fresh verifier string");
    assert!(
        s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()),
        "bounded fresh verifier"
    );
}
pub(super) fn checkpoint_delta(before: &Rows, after: &Rows, stage: &str, input: &Value) {
    if !stage.ends_with("after-commit") {
        assert!(before == after, "precommit full rows must roll back");
        return;
    }
    let mut expected = before.clone();
    if stage.starts_with("admit") {
        assert!(before["production_runs"].is_empty() && before["production_run_leases"].is_empty());
        assert_eq!(after["production_runs"].len(), 1);
        let r = &after["production_runs"][0];
        Uuid::parse_str(r["id"].as_str().unwrap()).unwrap();
        opaque(&r["input_digest"]);
        opaque(&r["candidate_hash"]);
        let context = &before["production_supervisors"][0];
        let deadline = input["claim_deadline"]
            .as_i64()
            .unwrap()
            .min(context["lease_deadline_ms"].as_i64().unwrap());
        expected.insert("production_runs".into(), vec![json!({
            "id": r["id"], "context_id": context["context_id"], "incarnation_id": context["incarnation_id"],
            "owner_id": input["owner"], "conversation_id": input["conversation"], "session_id": input["session"],
            "native_session_id": "synthetic-independent-native", "provider_kind": "codex",
            "binding_generation": input["binding_generation"], "message_id": input["message"], "event_id": input["event"],
            "scope_sequence": input["sequence"], "claim_generation": input["claim_generation"],
            "request_key": "independent-crash:1", "input_digest": r["input_digest"], "lease_generation": 1,
            "dispatch_fence": context["generation"], "lease_deadline_ms": deadline, "attempt": 1,
            "state": "starting", "dispatch_state": "candidate", "candidate_hash": r["candidate_hash"],
            "reservation_hash": null, "reserve_key": null
        })]);
        expected.insert("production_run_leases".into(), vec![json!({"run_id": r["id"], "generation":1,
            "lease_deadline_ms":deadline, "dispatch_fence":context["generation"], "purpose":"execution"})]);
        assert_eq!(expected["reasoning_inbox"].len(), 1);
        expected.get_mut("reasoning_inbox").unwrap()[0]["state"] = json!("consumed");
        expected.get_mut("reasoning_inbox").unwrap()[0]["admitted_run_id"] = r["id"].clone();
        let b = expected
            .get_mut("session_bindings")
            .unwrap()
            .iter_mut()
            .find(|b| b["id"] == input["session"])
            .unwrap();
        b["state"] = json!("busy");
    } else {
        assert_eq!(expected["production_runs"].len(), 1);
        let row = &mut expected.get_mut("production_runs").unwrap()[0];
        if stage.starts_with("reserve") {
            opaque(&after["production_runs"][0]["reservation_hash"]);
            row["dispatch_state"] = json!("reserved");
            row["reservation_hash"] = after["production_runs"][0]["reservation_hash"].clone();
            row["reserve_key"] = json!("independent-reserve:1");
        } else {
            row["dispatch_state"] = json!("delivery_unknown");
            row["candidate_hash"] = Value::Null;
            row["reservation_hash"] = Value::Null;
        }
    }
    expected.get_mut("execution_revisions").unwrap()[0]["revision"] = json!(
        before["execution_revisions"][0]["revision"]
            .as_i64()
            .unwrap()
            + if stage.starts_with("admit") { 2 } else { 1 }
    );
    for (table, wanted) in &expected {
        let actual = &after[table];
        assert_eq!(wanted.len(), actual.len(), "row count {table}");
        for (w, a) in wanted.iter().zip(actual) {
            for (column, value) in w.as_object().unwrap() {
                assert!(
                    a[column] == *value,
                    "postcommit mismatch {stage}: {table}.{column}"
                );
            }
            assert_eq!(
                w.as_object().unwrap().len(),
                a.as_object().unwrap().len(),
                "column count {table}"
            );
        }
    }
}
pub(super) fn takeover_delta(before: &Rows, after: &Rows) {
    let mut expected = before.clone();
    let old = &before["production_supervisors"][0];
    let new = &after["production_supervisors"][0];
    let old_id = old["incarnation_id"].as_str().unwrap();
    let new_id = new["incarnation_id"].as_str().unwrap();
    Uuid::parse_str(new_id).unwrap();
    assert_ne!(old_id, new_id);
    assert!(
        new["lease_deadline_ms"].as_i64().unwrap() > old["lease_deadline_ms"].as_i64().unwrap()
    );
    let c = &mut expected.get_mut("production_supervisors").unwrap()[0];
    c["incarnation_id"] = new["incarnation_id"].clone();
    c["lease_deadline_ms"] = new["lease_deadline_ms"].clone();
    c["generation"] = json!(old["generation"].as_i64().unwrap() + 1);
    for b in expected.get_mut("session_bindings").unwrap() {
        if before["production_readiness"]
            .iter()
            .any(|r| r["session_id"] == b["id"])
        {
            b["state"] = json!("lost");
        }
    }
    for r in expected.get_mut("production_runs").unwrap() {
        r["state"] = json!("blocked");
        if r["dispatch_state"] != "delivery_unknown" {
            r["dispatch_state"] = json!("quarantined");
        }
        r["candidate_hash"] = Value::Null;
        r["reservation_hash"] = Value::Null;
        r["reserve_key"] = Value::Null;
    }
    expected.get_mut("execution_revisions").unwrap()[0]["revision"] = json!(
        before["execution_revisions"][0]["revision"]
            .as_i64()
            .unwrap()
            + before["production_runs"].len() as i64
    );
    assert!(
        &expected == after,
        "takeover changed fields outside quarantine/CAS policy"
    );
}
