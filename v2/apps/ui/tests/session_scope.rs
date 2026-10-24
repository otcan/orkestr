use orkestr_v2_ui::{
    execution::{Execution, Phase, Sample},
    session_scope::SessionScope,
    Draft,
};
use std::collections::BTreeMap;
fn draft(text: &str) -> Draft {
    let mut draft = Draft::default();
    draft.edit(text.into());
    draft
}
#[test]
fn logout_and_owner_change_fence_old_receipts_without_cross_owner_drafts() {
    let mut session = SessionScope::default();
    let mut drafts = BTreeMap::new();
    let first = session.activate("owner-a-global", &mut drafts);
    drafts.insert("project-conversation".into(), draft("private draft A"));
    drafts
        .get_mut("project-conversation")
        .unwrap()
        .prepare("pending-a".into())
        .unwrap();
    session.invalidate();
    assert!(!session.is_current(first));
    assert!(session.retention_namespace().is_none());
    let resumed = session.activate("owner-a-global", &mut drafts);
    assert!(session.is_current(resumed));
    assert_eq!(session.retention_namespace(), Some("owner-a-global"));
    assert!(!session.is_current(first));
    assert_eq!(drafts["project-conversation"].text, "private draft A");
    assert!(drafts["project-conversation"].pending.is_some());
    session.invalidate();
    let other = session.activate("owner-b-global", &mut drafts);
    assert!(drafts.is_empty());
    drafts.insert("project-conversation".into(), draft("private draft B"));
    // Same conversation lookup and a late owner-A receipt cannot clear owner-B text.
    if session.is_current(resumed) {
        drafts.get_mut("project-conversation").unwrap().accepted();
    }
    assert_eq!(drafts["project-conversation"].text, "private draft B");
    assert!(session.is_current(other));
    session.activate("owner-a-global", &mut drafts);
    assert!(drafts.is_empty()); // No hidden cross-owner cache restored.
}
#[test]
fn invalid_identity_cannot_resume_or_retain_drafts() {
    let mut session = SessionScope::default();
    let mut drafts = BTreeMap::new();
    session.activate("owner-a-global", &mut drafts);
    drafts.insert("conversation".into(), draft("private"));
    let invalid = session.activate("", &mut drafts);
    assert!(!session.is_current(invalid));
    assert!(drafts.is_empty());
}
#[test]
fn authorization_loss_removes_execution_resources_and_invalidates_late_status() {
    let mut state = Execution::default();
    let generation = state.select("conversation", "run");
    state
        .apply(
            generation,
            1,
            Sample {
                conversation: "conversation".into(),
                run: "run".into(),
                revision: 100,
                observed_ms: 999999,
                phase: Phase::Running,
                queue_age_ms: Some(1),
                progress: None,
                progress_reference: None,
                resource_age_ms: Some(0),
                cpu_capacity_permille: Some(500),
                ram_bytes: Some(1048576),
                stop_supported: true,
                steering_supported: true,
            },
        )
        .unwrap();
    state.authorization_lost();
    assert!(!state.can_stop(1) && !state.can_steer(1));
    assert!(!state.summary(1).contains("Running"));
    assert!(!state.resources(1).contains("50.0%"));
    // Old callbacks no longer have a valid selected generation/scope.
    assert!(state.apply_status(generation, 2, serde_json::from_value(serde_json::json!({"schema_version":1,"conversation_id":"00000000-0000-4000-8000-000000000003","run_id":null,"revision":1,"observed_at_ms":1,"phase":"queued","queue_age_ms":null,"progress":null,"resources":null,"capabilities":{"stop":false,"steer":false}})).unwrap()).is_err());
}
