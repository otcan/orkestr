use orkestr_v2_contracts::*;
use orkestr_v2_ui::steering::Steering;
fn status() -> ExecutionStatus {
    serde_json::from_value(serde_json::json!({"schema_version":1,"conversation_id":"00000000-0000-4000-8000-000000000003","run_id":"00000000-0000-4000-8000-000000000005","revision":10,"control_revision":2,"observed_at_ms":100,"phase":"running","queue_age_ms":null,"progress":null,"resources":null,"capabilities":{"stop":true,"steer":true}})).unwrap()
}
fn receipt(disposition: SteeringDisposition) -> ExecutionSteeringReceipt {
    serde_json::from_value(serde_json::json!({"conversation_id":status().conversation_id,"run_id":status().run_id,"request_key":"original","message_id":"00000000-0000-4000-8000-000000000006","event_id":"00000000-0000-4000-8000-000000000007","scope_sequence":2,"disposition":disposition})).unwrap()
}
#[test]
fn uncertain_retry_freezes_every_authority_field_and_text() {
    let mut model = Steering {
        text: "first".into(),
        ..Default::default()
    };
    let original = model.prepare(&status(), "original".into()).unwrap();
    model.failed(503);
    model.text = "next draft".into();
    let mut later = status();
    later.capabilities.steer = false;
    later.revision = 100;
    later.control_revision = Some(99);
    assert_eq!(
        serde_json::to_value(model.prepare(&later, "changed".into()).unwrap()).unwrap(),
        serde_json::to_value(original).unwrap()
    );
    model.failed(409);
    assert!(model.prepare(&later, "new".into()).is_err());
    assert_eq!(model.text, "next draft");
}
#[test]
fn new_requests_need_running_capability_control_and_valid_text() {
    for change in 0..4 {
        let mut s = status();
        let mut m = Steering {
            text: "valid".into(),
            ..Default::default()
        };
        match change {
            0 => s.capabilities.steer = false,
            1 => s.phase = ExecutionPhase::AwaitingAcceptance,
            2 => s.control_revision = None,
            _ => m.text = " ".into(),
        }
        assert!(m.prepare(&s, "key".into()).is_err());
    }
}
#[test]
fn receipts_and_delivery_are_exactly_bound_and_never_completion() {
    for disposition in [
        SteeringDisposition::Reserved,
        SteeringDisposition::QueuedUnsupported,
        SteeringDisposition::QueuedOrdered,
    ] {
        let mut m = Steering {
            text: "first".into(),
            ..Default::default()
        };
        m.prepare(&status(), "original".into()).unwrap();
        let r = receipt(disposition);
        let mut wrong = r.clone();
        wrong.request_key = "foreign".into();
        assert!(!m.receipt(&status().conversation_id, wrong));
        assert!(m.receipt(&status().conversation_id, r.clone()));
        assert!(!m.notice.contains("acknowledged"));
        for state in [
            SteeringDeliveryState::Queued,
            SteeringDeliveryState::Reserved,
            SteeringDeliveryState::DeliveryUnknown,
            SteeringDeliveryState::Acknowledged,
            SteeringDeliveryState::Rejected,
        ] {
            assert!(m.delivery(ExecutionSteeringStatus {
                receipt: r.clone(),
                state,
                written_bytes: 0
            }));
            if state == SteeringDeliveryState::Acknowledged {
                assert!(m.notice.contains("does not confirm completion"));
            }
        }
    }
}

#[test]
fn foreign_selection_cannot_reuse_uncertain_request() {
    let mut model = Steering {
        text: "first".into(),
        ..Default::default()
    };
    model.prepare(&status(), "original".into()).unwrap();
    let mut foreign = status();
    foreign.conversation_id =
        serde_json::from_str("\"00000000-0000-4000-8000-000000000099\"").unwrap();
    assert!(model.prepare(&foreign, "other".into()).is_err());
    let mut foreign = status();
    foreign.run_id =
        Some(serde_json::from_str("\"00000000-0000-4000-8000-000000000099\"").unwrap());
    assert!(model.prepare(&foreign, "other".into()).is_err());
}
