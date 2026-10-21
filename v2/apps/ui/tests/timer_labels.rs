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
    let weekly = serde_json::from_str::<Schedule>(
        r#"{"kind":"zoned_clock","timezone":"Europe/Berlin","weekday":5,"minute_of_day":1205}"#,
    )
    .unwrap();
    assert_eq!(
        schedule_label(&weekly),
        "Every Friday at 20:05 Europe/Berlin"
    );
    assert_eq!(
        schedule_label(&Schedule::ZonedClock {
            timezone: "Europe/Istanbul".into(),
            weekday: None,
            minute_of_day: 540
        }),
        "Daily at 09:00 Europe/Istanbul"
    );
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

mod calendar_labels {
    use orkestr_v2_ui::{
        timer_labels::{
            last_result_label, run_status, schedule_label, silent_runs_label, trigger_label,
        },
        timers::{full_listing, Listed},
    };
    use serde_json::json;
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    const NOW: i64 = 1_792_650_000_000;

    fn row(policy: serde_json::Value, state: &str) -> Listed {
        let value = json!({"conversation_id":ID,"timers":[{"namespace":ID,"source_digest":"d","schedule":{"kind":"calendar","timezone":"Europe/Berlin",
            "weekdays":[1,2,3,4,5],"start_minute":480,"end_minute":1140,"every_hours":1,"minutes":[0],"summary":"Hourly at :00, Mon–Fri, 08:00–19:00 Europe/Berlin"},
            "conversation_id":ID,"state":state,"dormant_reason":null,"revision":2,"generation":1,"next_due_ms":NOW+1000,"controller_armed":state=="enabled",
            "controller_hold":null,"label":"Jobs","policy":policy,"pause_until_local":"Fri 23 Oct 09:00 CEST"}]});
        full_listing(&value, ID).unwrap().rows.remove(0)
    }
    fn policy(extra: serde_json::Value) -> serde_json::Value {
        let mut base = json!({"revision":1,"silent_mode":"off","pause_until_ms":null,"skip_dates":[],"skip_timezone":null,"digest":null,"trigger":null});
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        base
    }

    #[test]
    fn the_rule_is_shown_in_the_servers_plain_words() {
        let listed = row(policy(json!({})), "enabled");
        assert_eq!(
            schedule_label(&listed.detail.schedule),
            "Hourly at :00, Mon–Fri, 08:00–19:00 Europe/Berlin"
        );
        assert_eq!(
            schedule_label(&orkestr_v2_ui::timers::Schedule::Event),
            "Runs when something arrives"
        );
    }

    #[test]
    fn running_paused_and_chat_paused_are_distinct_and_expired_pauses_are_ignored() {
        let running = row(policy(json!({})), "enabled");
        assert_eq!(run_status(&running, None, None, NOW), "Running");
        let paused = row(policy(json!({"pause_until_ms": NOW + 5000})), "enabled");
        assert_eq!(
            run_status(&paused, None, None, NOW),
            "Paused until Fri 23 Oct 09:00 CEST"
        );
        let forever = row(
            policy(json!({"pause_until_ms": 4_102_444_800_000_i64})),
            "enabled",
        );
        assert_eq!(
            run_status(&forever, None, None, NOW),
            "Paused until resumed"
        );
        let over = row(policy(json!({"pause_until_ms": NOW - 5})), "enabled");
        assert_eq!(run_status(&over, None, None, NOW), "Running");
        assert_eq!(
            run_status(
                &running,
                Some(NOW + 9000),
                Some("Sat 24 Oct 10:00 CEST"),
                NOW
            ),
            "Chat paused until Sat 24 Oct 10:00 CEST"
        );
        assert_eq!(run_status(&running, Some(NOW - 1), None, NOW), "Running");
        // The later of the two wins.
        assert!(run_status(&paused, Some(NOW + 9000), None, NOW).starts_with("Chat paused"));
        assert_eq!(
            run_status(&row(policy(json!({})), "disabled"), None, None, NOW),
            "Disabled"
        );
    }

    #[test]
    fn last_result_and_silent_runs_read_naturally() {
        use orkestr_v2_ui::timers::Stats;
        let stats = |kind: &str, summary: &str, quiet: i64| Stats {
            last_kind: Some(kind.into()),
            last_summary: Some(summary.into()),
            last_at_ms: Some(NOW),
            silent_runs: quiet,
            total_runs: 9,
        };
        assert_eq!(
            last_result_label(
                Some(&stats("delivered", "Interview invite", 0)),
                Some("Wed 21 Oct 21:00 CEST")
            )
            .unwrap(),
            "Sent: Interview invite (Wed 21 Oct 21:00 CEST)"
        );
        assert!(
            last_result_label(Some(&stats("silent", "no news", 3)), None)
                .unwrap()
                .starts_with("Silent: no news (")
        );
        assert!(last_result_label(Some(&stats("digest", "promo", 1)), None)
            .unwrap()
            .starts_with("Held for digest: promo"));
        assert!(last_result_label(
            Some(&Stats {
                last_kind: None,
                last_summary: None,
                last_at_ms: None,
                silent_runs: 0,
                total_runs: 0
            }),
            None
        )
        .is_none());
        assert!(last_result_label(None, None).is_none());
        assert_eq!(
            silent_runs_label(Some(&stats("silent", "x", 1))).unwrap(),
            "1 silent run since the last message"
        );
        assert_eq!(
            silent_runs_label(Some(&stats("silent", "x", 4))).unwrap(),
            "4 silent runs since the last message"
        );
        assert!(silent_runs_label(Some(&stats("delivered", "x", 0))).is_none());
    }

    #[test]
    fn triggers_are_named() {
        let listed = row(
            policy(json!({"trigger":{"sources":["message","email"],"min_interval_s":300}})),
            "enabled",
        );
        assert_eq!(
            trigger_label(listed.policy.as_ref()).unwrap(),
            "Also runs on a new message or a new email, at most every 5 min"
        );
        assert!(trigger_label(row(policy(json!({})), "enabled").policy.as_ref()).is_none());
    }
}
