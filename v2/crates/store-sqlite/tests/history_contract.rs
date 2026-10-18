use orkestr_v2_contracts::*;
use serde_json::json;

#[test]
fn dormant_history_wire_contains_provenance_not_runtime_authority() {
    let request = json!({
        "namespace":"00000000-0000-0000-0000-000000000001",
        "source_digest":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "source_conversation_id":"00000000-0000-0000-0000-000000000002",
        "source_scope":{"kind":"global"},
        "source_watermark":0,
        "messages":[]
    });
    let parsed: HistoryImportRequest = serde_json::from_value(request.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), request);
    for field in ["token", "owner_id", "native_session_id", "dispatch_fence"] {
        let mut forged = request.clone();
        forged[field] = json!("untrusted");
        assert!(serde_json::from_value::<HistoryImportRequest>(forged).is_err());
    }
    let rollback = json!({
        "namespace":"00000000-0000-0000-0000-000000000001",
        "expected_revision":1
    });
    let parsed: HistoryRollbackRequest = serde_json::from_value(rollback.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), rollback);
}
