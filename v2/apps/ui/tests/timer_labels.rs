use orkestr_v2_ui::timer_labels::{controller_notice, held_reason, state_label};

#[test]
fn dormant_reasons_remain_explicit_and_unknown_reason_never_implies_ready() {
    for reason in [
        "missing_timezone",
        "unsupported_timezone",
        "ambiguous_cadence",
        "uncertain_effects",
        "future_reason",
    ] {
        assert!(held_reason(Some(reason)).unwrap().starts_with("Held:"));
    }
    assert!(held_reason(Some("missing_timezone"))
        .unwrap()
        .contains("explicit timezone"));
    assert!(held_reason(None).is_none());
    assert_eq!(state_label("future_state"), "Timer state unavailable");
}

#[test]
fn enabled_schedule_is_not_armed_after_restart_and_never_claims_execution() {
    assert!(
        controller_notice("enabled", false, Some("explicit_owner_rearm_required"))
            .contains("not armed")
    );
    assert!(
        controller_notice("enabled", false, Some("explicit_owner_rearm_required"))
            .contains("after a restart")
    );
    assert!(
        controller_notice("enabled", false, Some("explicit_owner_rearm_required"))
            .contains("Disable it first")
    );
    assert!(
        controller_notice("enabled", false, Some("explicit_owner_rearm_required"))
            .contains("cannot rearm")
    );
    assert!(controller_notice("enabled", true, None).contains("does not confirm"));
    for state in [
        "paused",
        "disabled",
        "stopped",
        "rolled_back",
        "exhausted",
        "unknown",
    ] {
        assert!(controller_notice(state, true, None).contains("not enabled"));
        assert!(controller_notice(state, true, None).contains("Already admitted work"));
    }
}

#[test]
fn utc_schedule_labels_do_not_use_browser_local_time() {
    use orkestr_v2_ui::timer_labels::{schedule_label, utc_time};
    use orkestr_v2_ui::timers::Schedule;
    assert_eq!(utc_time(1000), "1970-01-01 00:00:01 UTC");
    assert_eq!(utc_time(1709164800000), "2024-02-29 00:00:00 UTC");
    assert!(schedule_label(&Schedule::UtcClock {
        weekly: true,
        minute_of_day: 90
    })
    .contains("01:30 UTC"));
}

#[test]
fn durable_hold_notices_do_not_invent_missing_permission() {
    let saved = controller_notice("enabled", false, Some("scheduler_unavailable"));
    assert!(saved.contains("permission is saved"));
    assert!(!saved.contains("Disable"));
    let missing = controller_notice("enabled", false, Some("durable_owner_enable_required"));
    assert!(missing.contains("fresh instructions"));
    assert!(!missing.contains("restart"));
    assert!(!missing.contains("hour"));
    assert!(controller_notice("enabled", false, None).contains("Refresh"));
}
