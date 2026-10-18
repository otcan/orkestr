use orkestr_v2_contracts::{
    ConversationId, RunId, WorkerTaskList, WorkerTaskPhase, WorkerTaskReceipt,
};
use orkestr_v2_ui::worker_tasks::{phase_label, TaskDraft, TaskHistory};
fn ids() -> (ConversationId, RunId) {
    (
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000001")).unwrap(),
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000002")).unwrap(),
    )
}
fn receipt() -> WorkerTaskReceipt {
    serde_json::from_value(serde_json::json!({"schema_version":1,"conversation_id":ids().0,"parent_run_id":ids().1,"task_id":"00000000-0000-4000-8000-000000000003","source_message_id":"00000000-0000-4000-8000-000000000004","source_event_id":"00000000-0000-4000-8000-000000000005","created_at_ms":1})).unwrap()
}
#[test]
fn uncertain_create_retains_independent_instructions_key_and_parent_despite_edits() {
    let (conversation, parent) = ids();
    let mut draft = TaskDraft::default();
    draft.edit("Task".into(), "Independent instructions".into());
    let pending = draft
        .prepare(
            conversation.clone(),
            parent.clone(),
            3,
            true,
            "key-one".into(),
        )
        .unwrap();
    draft.failed(&pending, 0);
    draft.edit("New draft".into(), "New independent instructions".into());
    let retry = draft
        .prepare(conversation, parent, 99, false, "key-two".into())
        .unwrap();
    assert_eq!(
        serde_json::to_value(&pending.request).unwrap(),
        serde_json::to_value(&retry.request).unwrap()
    );
    draft.receipt(&retry, receipt()).unwrap();
    assert_eq!(draft.title, "New draft");
    assert_eq!(draft.instructions, "New independent instructions");
    assert!(draft.needs_review());
    assert!(!draft.retryable());
}
#[test]
fn refused_parent_requires_explicit_review_and_invalid_or_foreign_intent_is_not_sent() {
    let (conversation, parent) = ids();
    let mut draft = TaskDraft::default();
    assert!(draft
        .prepare(conversation.clone(), parent.clone(), 3, true, "one".into())
        .is_err());
    draft.edit("é".repeat(81), "Independent".into());
    assert!(draft
        .prepare(conversation.clone(), parent.clone(), 3, true, "one".into())
        .is_err());
    draft.edit("Task".into(), "Independent".into());
    assert!(draft
        .prepare(conversation.clone(), parent.clone(), 3, false, "one".into())
        .is_err());
    let pending = draft
        .prepare(conversation.clone(), parent.clone(), 3, true, "one".into())
        .unwrap();
    draft.failed(&pending, 409);
    assert!(draft
        .prepare(conversation.clone(), parent.clone(), 4, true, "two".into())
        .is_err());
    let mut bad = receipt();
    bad.parent_run_id =
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000099")).unwrap();
    assert!(draft.receipt(&pending, bad).is_err());
    draft.review();
    let refreshed = draft
        .prepare(conversation, parent, 4, true, "two".into())
        .unwrap();
    assert_eq!(refreshed.request.expected_control_revision, 4);
    assert_eq!(refreshed.request.request_key, "two");
}
#[test]
fn payload_removal_masks_late_history_without_fabricating_hold_or_completion() {
    let (conversation, parent) = ids();
    let mut history = TaskHistory::default();
    let list:WorkerTaskList=serde_json::from_value(serde_json::json!({"schema_version":1,"conversation_id":conversation,"parent_run_id":parent,"can_create":false,"tasks":[{"task":receipt(),"phase":"claimed","title":"Private task title","instructions_available":true,"run_id":null}]})).unwrap();
    history.apply(&conversation, &parent, list.clone()).unwrap();
    history.removed(&receipt().task_id);
    history.apply(&conversation, &parent, list.clone()).unwrap();
    let row = &history.list().unwrap().tasks[0];
    assert!(row.title.is_none());
    assert!(!row.instructions_available);
    assert_eq!(row.phase, WorkerTaskPhase::Claimed);
    assert!(phase_label(row.phase).contains("execution not confirmed"));
    let mut bad = list;
    bad.tasks[0].phase = WorkerTaskPhase::Completed;
    assert!(history.apply(&conversation, &parent, bad).is_err());
    assert_eq!(
        history.list().unwrap().tasks[0].phase,
        WorkerTaskPhase::Claimed
    );
}

#[test]
fn task_history_refuses_foreign_parent_and_retains_current_observed_availability() {
    let (conversation, parent) = ids();
    let mut history = TaskHistory::default();
    let mut list:WorkerTaskList=serde_json::from_value(serde_json::json!({"schema_version":1,"conversation_id":conversation,"parent_run_id":parent,"can_create":true,"tasks":[]})).unwrap();
    history.apply(&conversation, &parent, list.clone()).unwrap();
    assert!(history.list().unwrap().can_create);
    list.can_create = false;
    history.apply(&conversation, &parent, list.clone()).unwrap();
    assert!(!history.list().unwrap().can_create);
    list.parent_run_id =
        serde_json::from_value(serde_json::json!("00000000-0000-4000-8000-000000000099")).unwrap();
    assert!(history.apply(&conversation, &parent, list).is_err());
    assert_eq!(history.list().unwrap().parent_run_id, parent);
    assert!(!history.list().unwrap().can_create);
}
