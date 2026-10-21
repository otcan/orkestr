use orkestr_v2_contracts::ConversationId;
use orkestr_v2_ui::{
    timer_rules::{parse_clock, pause_body, Kind, RuleForm, FOREVER_MS},
    timers::full_listing,
};
use serde_json::{json, Value};

const ID: &str = "00000000-0000-4000-8000-000000000001";
const CONVERSATION: &str = "00000000-0000-4000-8000-0000000000c1";

fn conversation() -> ConversationId {
    serde_json::from_value(json!(CONVERSATION)).unwrap()
}
fn filled() -> RuleForm {
    RuleForm {
        label: "Jobs triage".into(),
        instruction: "Check the inbox".into(),
        start: "09:00".into(),
        end: "20:00".into(),
        ..RuleForm::default()
    }
}
fn listed(schedule: Value, policy: Value) -> Value {
    json!({"conversation_id": CONVERSATION, "pause_until_ms": null, "digests": [], "timers": [{
        "namespace": ID, "source_digest": "d", "schedule": schedule, "conversation_id": CONVERSATION,
        "state": "enabled", "dormant_reason": null, "revision": 3, "generation": 1, "next_due_ms": 1792652400000_i64,
        "controller_armed": true, "controller_hold": null, "label": "Jobs triage", "source_thread_id": "orkestr:calendar",
        "source_namespace": "orkestr:calendar", "source_timer_id": ID, "source_enabled": false, "native": true,
        "policy": policy, "stats": {"last_kind": null, "last_summary": null, "last_at_ms": null, "silent_runs": 0, "total_runs": 0},
        "next_due_local": "Thu 22 Oct 09:00 CEST", "last_result_local": null, "pause_until_local": null}]})
}
fn calendar_schedule() -> Value {
    json!({"kind":"calendar","timezone":"Europe/Berlin","weekdays":[1,2,3,4,5],"start_minute":540,"end_minute":1200,
           "every_hours":1,"minutes":[0],"summary":"Hourly at :00, Mon–Fri, 09:00–20:00 Europe/Berlin"})
}
fn policy(extra: Value) -> Value {
    let mut base = json!({"revision":2,"silent_mode":"unless_changed","pause_until_ms":null,"skip_dates":["2026-12-25"],
                          "skip_timezone":null,"digest":null,"digest_since_ms":null,"trigger":null,"updated_ms":1});
    base.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    base
}

#[test]
fn clock_inputs_are_strict() {
    assert_eq!(parse_clock("08:00"), Some(480));
    assert_eq!(parse_clock(" 9:05 "), Some(545));
    for bad in ["", "24:00", "08:60", "8", "08-00", "ab:cd", "08:00:00"] {
        assert_eq!(parse_clock(bad), None, "{bad}");
    }
}

#[test]
fn the_form_reads_the_rule_in_plain_words_before_anything_is_sent() {
    let built = filled().build().unwrap();
    assert_eq!(
        built.summary,
        "Hourly at :00, Mon–Fri, 09:00–20:00 Europe/Berlin"
    );
    assert_eq!(built.schedule["kind"], "calendar");
    assert_eq!(built.schedule["weekdays"], json!([1, 2, 3, 4, 5]));
    assert_eq!(built.policy["silent_mode"], "unless_changed");
    let mut istanbul = filled();
    istanbul.timezone = "Europe/Istanbul".into();
    istanbul.weekdays = [true; 7];
    istanbul.start = "09:00".into();
    istanbul.end = "23:00".into();
    istanbul.minutes = "37".into();
    assert_eq!(
        istanbul.build().unwrap().summary,
        "Hourly at :37, every day, 09:00–23:00 Europe/Istanbul"
    );
    istanbul.digest_on = true;
    istanbul.digest_times = "09:00, 18:30".into();
    assert_eq!(
        istanbul.build().unwrap().policy["digest"],
        json!({"timezone":"Europe/Istanbul","minutes":[540,1110]})
    );
}

#[test]
fn bad_input_is_explained_not_sent() {
    type Mutation = fn(&mut RuleForm);
    let cases: Vec<(Mutation, &str)> = vec![
        (|f: &mut RuleForm| f.start = "nine".into(), "Start"),
        (|f| f.end = "25:00".into(), "End"),
        (|f| f.minutes = "".into(), "Minutes"),
        (|f| f.minutes = "75".into(), "Schedule"),
        (|f| f.every_hours = "x".into(), "Hours"),
        (|f| f.every_hours = "30".into(), "Schedule"),
        (|f| f.start = "21:00".into(), "Schedule"),
        (|f| f.timezone = " ".into(), "time zone"),
        (|f| f.digest_on = true, ""),
    ];
    for (mutate, expected) in cases {
        let mut form = filled();
        mutate(&mut form);
        if expected.is_empty() {
            // Digest on with the default time is fine.
            assert!(form.build().is_ok());
            continue;
        }
        let message = form.build().unwrap_err();
        assert!(
            message.contains(expected),
            "{message} should mention {expected}"
        );
    }
    let mut digest = filled();
    digest.digest_on = true;
    digest.digest_times = "soon".into();
    assert!(digest.build().is_err());
    let mut gap = filled();
    gap.on_message = true;
    gap.min_interval_s = "-5".into();
    assert!(gap.build().is_err());
}

#[test]
fn create_body_carries_only_owner_fields() {
    let body = filled().create_body(ID, &conversation()).unwrap();
    let keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "conversation_id",
            "label",
            "namespace",
            "policy",
            "schedule",
            "text"
        ]
    );
    assert_eq!(body["text"], "Check the inbox");
    assert_eq!(body["namespace"], ID);
    for (name, mutate) in [
        (
            "name",
            (|f: &mut RuleForm| f.label = " ".into()) as fn(&mut RuleForm),
        ),
        ("instructions", |f| f.instruction = "".into()),
    ] {
        let mut form = filled();
        mutate(&mut form);
        assert!(form.create_body(ID, &conversation()).is_err(), "{name}");
    }
}

#[test]
fn event_timers_need_something_that_starts_them() {
    let mut form = filled();
    form.kind = Kind::Event;
    assert!(form.build().unwrap_err().contains("Choose what starts"));
    form.on_email = true;
    form.min_interval_s = "300".into();
    let built = form.build().unwrap();
    assert_eq!(built.schedule, json!({"kind":"event"}));
    assert_eq!(
        built.policy["trigger"],
        json!({"sources":["email"],"min_interval_s":300})
    );
    assert_eq!(built.summary, "When a new email arrives");
    form.on_message = true;
    assert_eq!(
        form.build().unwrap().summary,
        "When a new message or email arrives"
    );
}

#[test]
fn editing_round_trips_and_only_changed_parts_are_sent() {
    let value = listed(
        calendar_schedule(),
        policy(
            json!({"digest": {"timezone":"Europe/Berlin","minutes":[540]},
        "trigger": {"sources":["message"],"min_interval_s":120}}),
        ),
    );
    let row = full_listing(&value, CONVERSATION).unwrap().rows.remove(0);
    let mut form = RuleForm::from_listed(&row);
    assert_eq!(
        (
            form.start.as_str(),
            form.end.as_str(),
            form.minutes.as_str()
        ),
        ("09:00", "20:00", "0")
    );
    assert_eq!(form.weekdays, [true, true, true, true, true, false, false]);
    assert!(form.silent && form.digest_on && form.on_message && !form.on_email);
    assert_eq!(
        (
            form.digest_times.as_str(),
            form.skip_dates.as_str(),
            form.min_interval_s.as_str()
        ),
        ("09:00", "2026-12-25", "120")
    );
    // Untouched: the policy is saved, the schedule is not re-sent.
    let (schedule, policy) = form.edit_bodies().unwrap();
    assert!(schedule.is_none());
    assert_eq!(policy["expected_revision"], 2);
    assert_eq!(policy["policy"]["skip_dates"], json!(["2026-12-25"]));
    assert_eq!(policy["policy"]["pause_until_ms"], Value::Null);
    // A changed window is sent with the timer's revision.
    form.end = "19:00".into();
    let (schedule, _) = form.edit_bodies().unwrap();
    let schedule = schedule.unwrap();
    assert_eq!(schedule["expected_revision"], 3);
    assert_eq!(schedule["schedule"]["end_minute"], 1140);
    assert!(RuleForm::default().edit_bodies().is_err());
}

#[test]
fn full_week_edits_normalise_to_every_day() {
    let mut schedule = calendar_schedule();
    schedule["weekdays"] = json!([]);
    schedule["summary"] = json!("Hourly at :00, every day, 09:00–20:00 Europe/Berlin");
    let row = full_listing(&listed(schedule, policy(json!({}))), CONVERSATION)
        .unwrap()
        .rows
        .remove(0);
    let form = RuleForm::from_listed(&row);
    assert_eq!(form.weekdays, [true; 7]);
    let (changed, _) = form.edit_bodies().unwrap();
    assert!(
        changed.is_none(),
        "an unchanged every-day rule is not re-sent"
    );
}

#[test]
fn pause_bodies_carry_only_the_end() {
    assert_eq!(pause_body(Some(5)), json!({"until_ms": 5}));
    assert_eq!(pause_body(None), json!({"until_ms": null}));
    assert_eq!(FOREVER_MS, 4_102_444_800_000);
}

#[test]
fn an_edit_keeps_an_active_pause() {
    let value = listed(
        calendar_schedule(),
        policy(json!({"pause_until_ms": 1792700000000_i64})),
    );
    let row = full_listing(&value, CONVERSATION).unwrap().rows.remove(0);
    let (_, policy) = RuleForm::from_listed(&row).edit_bodies().unwrap();
    assert_eq!(policy["policy"]["pause_until_ms"], 1792700000000_i64);
}
