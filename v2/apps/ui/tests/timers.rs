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

fn server_listing(timer_extra: serde_json::Value) -> serde_json::Value {
    let mut timer = json!({"namespace":ID,"source_digest":"synthetic-digest","schedule":{"kind":"calendar","timezone":"Europe/Berlin",
        "weekdays":[1,2,3,4,5],"start_minute":540,"end_minute":1200,"every_hours":1,"minutes":[0],
        "summary":"Hourly at :00, Mon–Fri, 09:00–20:00 Europe/Berlin"},"conversation_id":ID,"state":"enabled","dormant_reason":null,
        "revision":2,"generation":1,"next_due_ms":1792652400000_i64,"controller_armed":true,"controller_hold":null,
        "label":"Jobs","source_thread_id":"orkestr:calendar","source_namespace":"orkestr:calendar","source_timer_id":ID,"source_enabled":false});
    timer
        .as_object_mut()
        .unwrap()
        .extend(timer_extra.as_object().unwrap().clone());
    json!({"conversation_id":ID,"timers":[timer]})
}
#[test]
fn listing_reads_policy_stats_local_times_and_digests() {
    let mut value = server_listing(json!({"native":true,
        "policy":{"revision":1,"silent_mode":"unless_changed","pause_until_ms":null,"skip_dates":[],"skip_timezone":null,"digest":{"timezone":"Europe/Berlin","minutes":[540]},"trigger":null,"digest_since_ms":1,"updated_ms":1},
        "stats":{"last_kind":"silent","last_summary":"no news","last_at_ms":1792650000000_i64,"silent_runs":4,"total_runs":9},
        "next_due_local":"Thu 22 Oct 09:00 CEST","last_result_local":"Thu 22 Oct 08:00 CEST","pause_until_local":null}));
    value["pause_until_ms"] = json!(1792700000000_i64);
    value["pause_until_local"] = json!("Thu 22 Oct 22:53 CEST");
    value["digests"] = json!([{"id":ID,"namespace":ID,"slot_ms":1,"text":"Digest: Jobs","item_count":3,"created_ms":2,"delivered_ms":null}]);
    let listing = orkestr_v2_ui::timers::full_listing(&value, ID).unwrap();
    let row = &listing.rows[0];
    assert!(row.native);
    assert_eq!(row.stats.as_ref().unwrap().silent_runs, 4);
    assert_eq!(
        row.policy
            .as_ref()
            .unwrap()
            .digest
            .as_ref()
            .unwrap()
            .minutes,
        vec![540]
    );
    assert_eq!(row.local.next.as_deref(), Some("Thu 22 Oct 09:00 CEST"));
    assert_eq!(listing.pause_until_ms, Some(1792700000000));
    assert_eq!(listing.digests[0].item_count, 3);
    assert_eq!(orkestr_v2_ui::timers::listing(&value, ID).unwrap().len(), 1);
}
#[test]
fn an_older_server_without_policy_still_lists() {
    let listing = orkestr_v2_ui::timers::full_listing(&server_listing(json!({})), ID).unwrap();
    let row = &listing.rows[0];
    assert!(row.policy.is_none() && row.stats.is_none() && !row.native);
    assert!(listing.digests.is_empty());
}
#[test]
fn malformed_calendar_rules_and_foreign_listings_are_refused() {
    let mut value = server_listing(json!({}));
    assert!(
        orkestr_v2_ui::timers::full_listing(&value, "00000000-0000-4000-8000-000000000002")
            .is_none()
    );
    for (field, bad) in [
        ("weekdays", json!([8])),
        ("minutes", json!([60])),
        ("every_hours", json!(0)),
        ("end_minute", json!(1440)),
        ("start_minute", json!(1300)),
    ] {
        value = server_listing(json!({}));
        value["timers"][0]["schedule"][field] = bad;
        assert!(
            orkestr_v2_ui::timers::full_listing(&value, ID).is_none(),
            "{field}"
        );
    }
    value = server_listing(json!({"claim":"forbidden"}));
    assert!(orkestr_v2_ui::timers::full_listing(&value, ID).is_none());
}
