use orkestr_v2_contracts::ConversationId;
use orkestr_v2_ui::timers::{Action, Detail, Editor};
use serde_json::json;
const ID: &str = "00000000-0000-4000-8000-000000000001";
fn detail() -> Detail {
    serde_json::from_value(json!({"namespace":ID,"source_digest":"synthetic-digest","schedule":{"kind":"interval","every_ms":60000},"conversation_id":ID,"state":"disabled","dormant_reason":null,"revision":1,"generation":0,"next_due_ms":null,"controller_armed":false,"controller_hold":null})).unwrap()
}
fn target() -> ConversationId {
    serde_json::from_value(json!(ID)).unwrap()
}
#[test]
fn uncertain_enable_retains_exact_tuple_despite_edits_and_new_revision() {
    let mut e = Editor::default();
    e.edit("first instruction".into());
    let p = e
        .prepare(&detail(), &target(), None, "first-key".into())
        .unwrap();
    assert!(e.result(&p, 503, None).is_err());
    e.edit("next draft".into());
    let mut d = detail();
    d.revision = 8;
    let retry = e
        .prepare(&d, &target(), Some(Action::Stop), "new-key".into())
        .unwrap();
    assert_eq!(p.body, retry.body);
    assert_eq!(retry.operation, "enable");
    assert!(e.result(&p, 200, Some(&d)).is_ok());
    assert_eq!(e.text, "next draft");
}
#[test]
fn conflict_requires_explicit_review_and_preserves_instructions() {
    let mut e = Editor::default();
    e.edit("saved draft".into());
    let p = e.prepare(&detail(), &target(), None, "key".into()).unwrap();
    assert!(e.result(&p, 409, None).is_err());
    assert!(e
        .prepare(&detail(), &target(), None, "other".into())
        .is_err());
    e.review();
    let mut d = detail();
    d.revision = 2;
    let next = e.prepare(&d, &target(), None, "fresh".into()).unwrap();
    assert_eq!(next.body["expected_revision"], 2);
    assert_eq!(next.body["text"], "saved draft");
}
#[test]
fn control_has_no_client_clock_or_claim_and_success_is_not_execution() {
    for action in [Action::Disable, Action::Stop, Action::Rollback] {
        let mut e = Editor::default();
        let p = e
            .prepare(&detail(), &target(), Some(action), "key".into())
            .unwrap();
        assert_eq!(p.body.as_object().unwrap().len(), 3);
        assert!(e.result(&p, 200, Some(&detail())).is_ok());
        assert!(e.notice.unwrap().contains("separate from work execution"));
    }
}
#[test]
fn malformed_scope_schedule_unknown_fields_and_dormancy_refuse() {
    let d = detail();
    assert!(d.valid_for(ID));
    assert!(!d.valid_for("00000000-0000-4000-8000-000000000002"));
    let mut bad = d.clone();
    bad.controller_armed = true;
    assert!(!bad.valid_for(ID));
    bad = d.clone();
    bad.schedule = orkestr_v2_ui::timers::Schedule::UtcClock {
        weekly: false,
        minute_of_day: 1440,
    };
    assert!(!bad.valid_for(ID));
    let mut e = Editor::default();
    e.edit("fresh".into());
    bad = d;
    bad.dormant_reason = Some("missing_timezone".into());
    assert!(e.prepare(&bad, &target(), None, "key".into()).is_err());
    assert!(serde_json::from_value::<Detail>(json!({"namespace":ID,"claim":"forbidden"})).is_err());
}
#[test]
fn old_or_foreign_success_does_not_clear_draft() {
    let mut e = Editor::default();
    e.edit("keep".into());
    let mut d = detail();
    d.revision = 5;
    let p = e.prepare(&d, &target(), None, "key".into()).unwrap();
    assert!(e.result(&p, 200, Some(&detail())).is_err());
    assert_eq!(e.text, "keep");
    d.namespace = "00000000-0000-4000-8000-000000000002".into();
    assert!(e.result(&p, 200, Some(&d)).is_err());
    assert_eq!(e.text, "keep");
}

#[test]
fn enabled_unarmed_requires_disable_then_fresh_enable_but_uncertain_retry_stays_exact() {
    use orkestr_v2_ui::timers::State;
    let mut enabled = detail();
    enabled.state = State::Enabled;
    enabled.controller_hold = Some("explicit_owner_rearm_required".into());
    let mut editor = Editor::default();
    editor.edit("fresh owner instructions".into());
    assert!(editor
        .prepare(&enabled, &target(), None, "new-enable".into())
        .is_err());
    let disable = editor
        .prepare(&enabled, &target(), Some(Action::Disable), "disable".into())
        .unwrap();
    let mut disabled = detail();
    disabled.revision = 2;
    editor.result(&disable, 200, Some(&disabled)).unwrap();
    editor.review();
    let enable = editor
        .prepare(&disabled, &target(), None, "fresh-enable".into())
        .unwrap();
    assert_eq!(enable.body["expected_revision"], 2);
    assert!(editor.result(&enable, 503, None).is_err());
    let retry = editor
        .prepare(&enabled, &target(), None, "must-not-replace".into())
        .unwrap();
    assert_eq!(retry.body, enable.body);
    assert_eq!(retry.body["request_key"], "fresh-enable");
}

#[test]
fn durable_hold_validation_preserves_armed_guard() {
    for hold in [
        "scheduler_unavailable",
        "durable_owner_enable_required",
        "explicit_owner_rearm_required",
    ] {
        let mut d = detail();
        d.state = orkestr_v2_ui::timers::State::Enabled;
        d.controller_hold = Some(hold.into());
        assert!(d.valid_for(ID));
        d.controller_armed = true;
        assert!(!d.valid_for(ID));
    }
    let mut d = detail();
    d.controller_hold = Some("invented_readiness".into());
    assert!(!d.valid_for(ID));
}

#[test]
fn conversation_listing_keeps_labels_and_refuses_foreign_or_malformed_rows() {
    use orkestr_v2_ui::timers::listing;
    let row = json!({"namespace":ID,"source_digest":"synthetic-digest","schedule":{"kind":"interval","every_ms":60000},
        "conversation_id":ID,"state":"enabled","dormant_reason":null,"revision":2,"generation":1,"next_due_ms":5,
        "controller_armed":true,"controller_hold":null,"label":"Synthetic daily","source_thread_id":"t",
        "source_namespace":"n","source_timer_id":"s","source_enabled":true});
    let rows = listing(&json!({"conversation_id":ID,"timers":[row.clone()]}), ID).unwrap();
    assert_eq!(
        (rows[0].label.as_deref(), rows[0].detail.revision),
        (Some("Synthetic daily"), 2)
    );
    assert!(listing(
        &json!({"conversation_id":"other","timers":[row.clone()]}),
        ID
    )
    .is_none());
    let mut bad = row;
    bad["claim"] = json!("forbidden");
    assert!(listing(&json!({"conversation_id":ID,"timers":[bad]}), ID).is_none());
}
