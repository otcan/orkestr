use orkestr_v2_contracts::tracker_automation::TrackerAutomationStatus;
use orkestr_v2_ui::tracker_setup::*;
use serde_json::json;
const SOURCE: &str = "10000000-0000-4000-8000-000000000001";
const INBOX: &str = "20000000-0000-4000-8000-000000000001";
const SENT: &str = "30000000-0000-4000-8000-000000000001";

#[test]
fn source_form_requires_both_roles_and_resets_consent_after_any_folder_change() {
    let mut form = SourceForm::default();
    assert!(form.selection(SOURCE, 0).is_err());
    form.choose(SOURCE.into());
    form.toggle(INBOX.into(), false);
    form.acknowledged = true;
    assert!(form.selection(SOURCE, 0).is_err());
    form.toggle(SENT.into(), true);
    assert!(!form.acknowledged);
    form.acknowledged = true;
    let request = form.selection(SOURCE, 0).unwrap();
    assert!(request.source.is_valid());
    assert!(request.acknowledge_read_only_access);
    form.choose(SOURCE.into());
    assert!(form.inbox.is_empty() && form.sent.is_empty() && !form.acknowledged);
}
#[test]
fn automation_is_off_by_default_and_keeps_the_reviewed_zone_and_revision_tuple() {
    let mut form = AutomationForm::default();
    let before = TrackerAutomationStatus {
        revision: 3,
        enabled: false,
        source_current: false,
        timer_revision: Some(7),
        authority: None,
        calendar: None,
    };
    assert!(form
        .enable(SOURCE, &before, 4, ("rules", &"ab".repeat(32)))
        .is_err());
    form.timezone = "Europe/Berlin".into();
    form.time = "09:30".into();
    form.acknowledged = true;
    let request = form
        .enable(SOURCE, &before, 4, ("rules", &"ab".repeat(32)))
        .unwrap();
    assert_eq!(request.calendar.timezone, "Europe/Berlin");
    assert_eq!(request.calendar.start_minute, 570);
    assert_eq!(request.expected_revision, 3);
    assert_eq!(request.expected_timer_revision, Some(7));
    assert_eq!(request.expected_source_revision, 4);
    let mut resumed = before.clone();
    resumed.calendar = Some(request.calendar.clone());
    let restored = AutomationForm::from_status(&resumed);
    assert_eq!(restored.calendar().unwrap(), request.calendar);
    assert!(!restored.acknowledged, "reload does not renew consent");
    form.frequent = true;
    let frequent = form.calendar().unwrap();
    resumed.calendar = Some(frequent.clone());
    let restored = AutomationForm::from_status(&resumed);
    assert!(restored.frequent);
    assert_eq!(restored.calendar().unwrap(), frequent);
    assert!(!restored.acknowledged);
    form.weekdays.clear();
    assert!(form.calendar().is_err());
}
#[test]
fn recovering_an_unknown_result_retains_the_original_key_and_body() {
    let decision = PendingDecision {
        kind: "automation_enable".into(),
        body: json!({"request_key":SOURCE,"expected_revision":0}),
    };
    assert_eq!(decision.key(), Some(SOURCE));
    assert_eq!(decision.operation(), Some(("POST", "/automation")));
    assert_eq!(
        decision.receipt_path(),
        Some(format!("/automation/decisions/{SOURCE}"))
    );
    let restarted: PendingDecision =
        serde_json::from_str(&serde_json::to_string(&decision).unwrap()).unwrap();
    assert_eq!(restarted, decision);
}

#[test]
fn only_known_receipts_or_definitive_refusals_resolve_a_saved_check() {
    let check = PendingDecision {
        kind: "check".into(),
        body: json!({"request_key":SOURCE}),
    };
    assert!(!check.resolved(
        200,
        &json!({"request_key":SOURCE,"cancelled":false,"result":null})
    ));
    assert!(check.resolved(
        200,
        &json!({"request_key":SOURCE,"cancelled":true,"result":null})
    ));
    assert!(check.resolved(200, &json!({"request_key":SOURCE,"result":{"news":false}})));
    assert!(!check.resolved(200, &json!({"request_key":INBOX,"result":{}})));
    for status in [0, 401, 403, 404, 500, 503] {
        assert!(!check.resolved(status, &json!({})));
    }
    for status in [400, 409] {
        assert!(check.resolved(status, &json!({})));
    }
}
