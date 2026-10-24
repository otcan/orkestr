use orkestr_v2_contracts::ExecutionStatus;
use orkestr_v2_ui::execution::{failure_notice, model_label};

fn status() -> ExecutionStatus {
    serde_json::from_value(serde_json::json!({"schema_version":1,
        "conversation_id":"00000000-0000-4000-8000-000000000001",
        "run_id":"00000000-0000-4000-8000-000000000002","revision":1,
        "observed_at_ms":100,"phase":"failed","queue_age_ms":null,
        "progress":null,"resources":null,"capabilities":{"stop":false,"steer":false},
        "failure":{"class":"policy"},"models":{"resolved_model":"initial-model","refused_model":"refusing-model"}
    })).unwrap()
}

#[test]
fn policy_notice_names_the_refusing_model_without_suggesting_a_retry() {
    let mut status = status();
    assert!(status.is_valid());
    let notice = failure_notice(&status).unwrap();
    assert!(notice.contains("policy refusal from refusing-model"));
    assert!(!notice.contains("retry"));
    assert_eq!(model_label(&status), "Declined by refusing-model");
    status.phase = orkestr_v2_contracts::ExecutionPhase::Cancelled;
    assert!(status.is_valid());
    assert!(failure_notice(&status).unwrap().contains("policy refusal"));
}

#[test]
fn actual_answer_model_and_unreported_legacy_evidence_are_distinct() {
    let mut status = status();
    status.models.as_mut().unwrap().actual_model = Some("answer-model".into());
    assert_eq!(
        model_label(&status),
        "Answered with answer-model (initialized as initial-model)"
    );
    status.models = None;
    assert_eq!(model_label(&status), "Answering model unreported");
}
