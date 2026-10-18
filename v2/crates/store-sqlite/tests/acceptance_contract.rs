//! Wire compatibility only, not acceptance transaction evidence.
use orkestr_v2_contracts::*;
use serde_json::{json, Value};
#[test]
fn strict_acceptance_variant_preserves_legacy_wire() {
    let value: Value =
        serde_json::from_str(include_str!("../../../fixtures/execution-accepted.json")).unwrap();
    let event: ConversationEvent = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(event.sse_name(), "execution_accepted");
    assert_eq!(serde_json::to_value(event).unwrap(), value);
    for mutation in ["schema", "unknown", "identity", "completion"] {
        let mut bad = value.clone();
        match mutation {
            "schema" => bad["schema_version"] = json!(8),
            "unknown" => bad["native_id"] = json!("forbidden"),
            "identity" => bad["owner_id"] = json!(uuid::Uuid::nil()),
            "completion" => {
                bad["payload_ref_or_safe_payload"]["completion_event_id"] = bad["event_id"].clone()
            }
            _ => unreachable!(),
        }
        assert!(
            serde_json::from_value::<ConversationEvent>(bad).is_err(),
            "{mutation}"
        );
    }
    let legacy: Value = serde_json::from_str(include_str!("../../../fixtures/event.json")).unwrap();
    let event: ConversationEvent = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(event.sse_name(), "message_accepted");
    assert_eq!(serde_json::to_value(event).unwrap(), legacy);
}
#[test]
fn strict_receipt_requires_original_commit_revision() {
    let mut value = json!({"schema_version":1,"conversation_id":"00000000-0000-4000-8000-000000000004",
        "run_id":"00000000-0000-4000-8000-000000000001",
        "completion_event_id":"00000000-0000-4000-8000-000000000002",
        "acceptance_event_id":"00000000-0000-4000-8000-000000000005",
        "request_key":"accept:1","requested_revision":4,"revision":6,"outcome":"succeeded"});
    assert!(
        serde_json::from_value::<ExecutionAcceptanceReceipt>(value.clone())
            .unwrap()
            .is_valid()
    );
    for field in ["schema_version", "revision"] {
        let mut bad = value.clone();
        bad[field] = json!(0);
        assert!(!serde_json::from_value::<ExecutionAcceptanceReceipt>(bad)
            .unwrap()
            .is_valid());
    }
    value["outcome"] = json!("awaiting_acceptance");
    assert!(serde_json::from_value::<ExecutionAcceptanceReceipt>(value).is_err());
    let mut request = json!({"run_id":"00000000-0000-4000-8000-000000000001",
        "completion_event_id":"00000000-0000-4000-8000-000000000002","expected_revision":4,"request_key":"accept:1"});
    assert!(
        serde_json::from_value::<ExecutionAcceptanceRequest>(request.clone())
            .unwrap()
            .is_valid()
    );
    request["owner_id"] = json!("00000000-0000-4000-8000-000000000003");
    assert!(serde_json::from_value::<ExecutionAcceptanceRequest>(request).is_err());
}
