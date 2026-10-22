use orkestr_v2_contracts::{ExecutionStatus, ExecutionWindowQueue};
use orkestr_v2_ui::conversation_status::{row_status, valid_execution, valid_queue, Slots, Tone};
use serde_json::json;

const ID: &str = "00000000-0000-4000-8000-000000000001";
const OTHER: &str = "00000000-0000-4000-8000-000000000002";
fn execution(phase: &str) -> ExecutionStatus {
    serde_json::from_value(json!({"schema_version":1,"conversation_id":ID,"run_id":"00000000-0000-4000-8000-000000000009","revision":1,
        "observed_at_ms":10,"phase":phase,"queue_age_ms":null,"progress":null,"resources":null,"capabilities":{"stop":false,"steer":false}})).unwrap()
}
fn queue(conversation: &str, positions: &[(&str, Option<u32>)]) -> ExecutionWindowQueue {
    let entries: Vec<_> = positions.iter().enumerate().map(|(n, (state, position))| json!({"conversation_id":conversation,"request_key":format!("k{n}"),
        "input_message_id":format!("00000000-0000-4000-8000-{:012}",n+100),"input_event_id":format!("00000000-0000-4000-8000-{:012}",n+200),
        "input_request_key":format!("i{n}"),"state":state,"position":position,"queued_at_ms":1,"window_id":null,"withdrawal":null})).collect();
    serde_json::from_value(json!({"conversation_id":conversation,"capacity":2,"active":2,"queued_total":3,"entries":entries})).unwrap()
}

#[test]
fn phases_map_to_list_badges() {
    for (phase, label, tone) in [
        ("running", "Working", Tone::Working),
        ("starting", "Starting", Tone::Working),
        ("cancel_requested", "Stopping", Tone::Working),
        ("awaiting_acceptance", "Reply ready", Tone::Attention),
        ("failed", "Failed", Tone::Attention),
        ("blocked", "Needs attention", Tone::Attention),
    ] {
        let status = row_status(Some(&execution(phase)), None).unwrap();
        assert_eq!(
            (status.label.as_str(), status.tone),
            (label, tone),
            "{phase}"
        );
    }
    assert!(row_status(Some(&execution("completed")), None).is_none());
    assert!(row_status(Some(&execution("cancelled")), None).is_none());
    assert!(row_status(None, None).is_none());
}

#[test]
fn queued_intents_show_their_earliest_position_unless_work_is_live() {
    let q = queue(
        ID,
        &[
            ("queued", Some(4)),
            ("queued", Some(2)),
            ("withdrawn", None),
        ],
    );
    let status = row_status(None, Some(&q)).unwrap();
    assert_eq!(
        (status.label.as_str(), status.tone),
        ("Queued #2", Tone::Queued)
    );
    assert_eq!(
        row_status(Some(&execution("completed")), Some(&q))
            .unwrap()
            .label,
        "Queued #2"
    );
    assert_eq!(
        row_status(Some(&execution("running")), Some(&q))
            .unwrap()
            .label,
        "Working"
    );
    assert!(row_status(
        None,
        Some(&queue(ID, &[("dispatched", None), ("withdrawn", None)]))
    )
    .is_none());
    assert_eq!(
        row_status(None, Some(&queue(ID, &[("queued", None)])))
            .unwrap()
            .label,
        "Queued"
    );
}

#[test]
fn foreign_or_invalid_observations_are_rejected() {
    assert!(valid_queue(&queue(ID, &[("queued", Some(1))]), ID));
    assert!(!valid_queue(&queue(ID, &[]), OTHER));
    assert!(!valid_queue(&queue(OTHER, &[("queued", Some(1))]), ID));
    let mut mixed = queue(ID, &[("queued", Some(1))]);
    mixed.entries[0].conversation_id = serde_json::from_value(json!(OTHER)).unwrap();
    assert!(!valid_queue(&mixed, ID));
    assert!(valid_execution(&execution("running"), ID));
    assert!(!valid_execution(&execution("running"), OTHER));
    let mut bad = execution("running");
    bad.schema_version = 2;
    assert!(!valid_execution(&bad, ID));
}

#[test]
fn slot_summary_never_overstates_use() {
    assert_eq!(
        Slots {
            capacity: 2,
            active: 3,
            queued: 0
        }
        .label(),
        "2 working"
    );
    assert_eq!(
        Slots {
            capacity: 8,
            active: 1,
            queued: 3
        }
        .label(),
        "1 working · 3 waiting"
    );
}
