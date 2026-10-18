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
    assert!(controller_notice("enabled", false).contains("not armed"));
    assert!(controller_notice("enabled", false).contains("after a restart"));
    assert!(controller_notice("enabled", true).contains("does not confirm"));
    for state in [
        "paused",
        "disabled",
        "stopped",
        "rolled_back",
        "exhausted",
        "unknown",
    ] {
        assert!(controller_notice(state, true).contains("not enabled"));
        assert!(controller_notice(state, true).contains("Already admitted work"));
    }
}
