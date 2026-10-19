use orkestr_v2_contracts::*;
use orkestr_v2_ui::{memory_client, memory_state::MemoryState};
fn settings() -> MemorySettings {
    serde_json::from_str(r#"{"owner_id":"00000000-0000-4000-8000-000000000001","enabled":true}"#)
        .unwrap()
}
fn proposal() -> MemoryProposal {
    serde_json::from_value(serde_json::json!({"schema_version":1,"request_key":"synthetic-key","operation":{"operation":"forget","memory_id":"00000000-0000-4000-8000-000000000002","expected_revision":9007199254740993_u64},"digest":"a".repeat(64)})).unwrap()
}
#[test]
fn disabled_unknown_and_explicit_matching_decision() {
    let mut state = MemoryState::default();
    assert_eq!(state.enabled(), None);
    assert!(!state.review(0, proposal()));
    assert!(state.settings(0, settings()));
    assert!(state.review(0, proposal()));
    assert!(state.confirm(MemoryConsentAction::Remember).is_err());
    let frozen = memory_client::body(&state.confirm(MemoryConsentAction::Forget).unwrap()).unwrap();
    assert!(frozen.contains("9007199254740993"));
    assert!(state.edit().is_err());
    assert_eq!(
        memory_client::body(&state.confirm(MemoryConsentAction::Approve).unwrap()).unwrap(),
        frozen
    );
    assert!(state.resolved(0));
    assert!(state.refresh_required);
    assert!(state.confirm(MemoryConsentAction::Forget).is_err());
}
#[test]
fn edit_scope_and_logout_invalidate_old_callbacks_and_consent() {
    let mut state = MemoryState::default();
    state.settings(0, settings());
    state.review(0, proposal());
    state.edit().unwrap();
    assert!(!state.review(0, proposal()));
    let generation = state.generation();
    assert!(state.review(generation, proposal()));
    state.retire();
    assert_eq!(state.enabled(), None);
    assert!(!state.resolved(generation));
    assert!(!state.settings(generation, settings()));
}
#[test]
fn exact_receipt_integer_and_route_specific_bounds() {
    let text = r#"{"memory_id":"00000000-0000-4000-8000-000000000002","revision":9007199254740993,"forgotten":true}"#;
    let receipt: MemoryReceipt =
        memory_client::decode(memory_client::MemoryRoute::Decisions, text).unwrap();
    assert_eq!(receipt.revision, 9007199254740993);
    assert!(memory_client::decode::<serde_json::Value>(
        memory_client::MemoryRoute::Settings,
        &" ".repeat(65537)
    )
    .is_err());
    assert_eq!(memory_client::MemoryRoute::Query.response_limit(), 4194304);
    assert_eq!(memory_client::MemoryRoute::Export.response_limit(), 8388608);
}

#[test]
fn foreign_project_proposal_and_changed_owner_refuse_and_clear() {
    let mut state = MemoryState::default();
    state.settings(0, settings());
    let proposal: MemoryProposal = serde_json::from_value(serde_json::json!({
        "schema_version":1,"request_key":"synthetic-project","digest":"a".repeat(64),
        "operation":{"operation":"create","candidate":{
            "scope":{"kind":"project","project_id":"00000000-0000-4000-8000-000000000009"},
            "content":{"category":"project_summary","summary":"Synthetic summary"},
            "source":{"kind":"owner","actor_id":settings().owner_id.to_string(),"origin":"synthetic","captured_at_ms":0,"task_id":null,"event_id":null,"cursor":null}
        }}
    })).unwrap();
    assert!(!state.review(0, proposal.clone()));
    let project: ProjectId =
        serde_json::from_str("\"00000000-0000-4000-8000-000000000009\"").unwrap();
    state.select(Some(project));
    assert!(!state.review(0, proposal.clone()));
    let generation = state.generation();
    assert!(state.review(generation, proposal));
    state.confirm(MemoryConsentAction::Remember).unwrap();
    let mut foreign = settings();
    foreign.owner_id = serde_json::from_str("\"00000000-0000-4000-8000-000000000008\"").unwrap();
    assert!(!state.settings(generation, foreign));
    assert_eq!(state.enabled(), None);
    assert!(state.confirm(MemoryConsentAction::Remember).is_err());
}

#[test]
fn independent_disable_fences_inflight_old_enabled_settings_and_proposals() {
    let mut state = MemoryState::default();
    state.settings(0, settings());
    let old = state.generation();
    let mut disabled = settings();
    disabled.enabled = false;
    assert!(state.settings(old, disabled));
    assert!(
        !state.settings(old, settings()),
        "stale enabled settings must not undo the observed disable"
    );
    assert!(
        !state.review(old, proposal()),
        "pre-disable proposal must be fenced"
    );
}
