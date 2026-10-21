use super::super::TimerSchedule;
use super::*;
use jiff::Timestamp;

fn ms(text: &str) -> i64 {
    text.parse::<Timestamp>().unwrap().as_millisecond()
}
fn iso(ms: i64) -> String {
    Timestamp::from_millisecond(ms).unwrap().to_string()
}
fn rule(tz: &str, days: &[u8], start: u16, end: u16, minutes: &[u8]) -> CalendarRule {
    CalendarRule {
        timezone: tz.into(),
        weekdays: days.to_vec(),
        start_minute: start,
        end_minute: end,
        every_hours: 1,
        minutes: minutes.to_vec(),
    }
    .normalized()
    .unwrap()
}
fn berlin() -> CalendarRule {
    rule("Europe/Berlin", &[1, 2, 3, 4, 5], 8 * 60, 19 * 60, &[0])
}
fn istanbul() -> CalendarRule {
    rule("Europe/Istanbul", &[], 9 * 60, 23 * 60, &[37])
}

#[test]
fn window_edges_are_inclusive_and_exact() {
    // 2026-10-21 is a Wednesday, Berlin is CEST (UTC+2): 08:00 is 06:00Z.
    let r = berlin();
    assert_eq!(
        iso(next(&r, ms("2026-10-21T05:59:59Z")).unwrap()),
        "2026-10-21T06:00:00Z"
    );
    // Strictly after the instant itself: 08:00 -> 09:00.
    assert_eq!(
        iso(next(&r, ms("2026-10-21T06:00:00Z")).unwrap()),
        "2026-10-21T07:00:00Z"
    );
    // 19:00 CEST (17:00Z) is the last run of the day.
    assert_eq!(
        iso(next(&r, ms("2026-10-21T16:59:59Z")).unwrap()),
        "2026-10-21T17:00:00Z"
    );
    // After it the next run is tomorrow 08:00 Berlin (06:00Z).
    assert_eq!(
        iso(next(&r, ms("2026-10-21T17:00:00Z")).unwrap()),
        "2026-10-22T06:00:00Z"
    );
    // 07:59 local is before the window opens.
    assert_eq!(
        iso(next(&r, ms("2026-10-21T05:00:00Z")).unwrap()),
        "2026-10-21T06:00:00Z"
    );
}

#[test]
fn weekend_is_skipped_and_monday_resumes() {
    let r = berlin();
    // Friday 2026-10-23 19:00 CEST is the last run of the week.
    assert_eq!(
        iso(next(&r, ms("2026-10-23T16:00:00Z")).unwrap()),
        "2026-10-23T17:00:00Z"
    );
    assert_eq!(
        iso(next(&r, ms("2026-10-23T17:00:00Z")).unwrap()),
        "2026-10-26T07:00:00Z"
    );
}

#[test]
fn twelve_hourly_runs_per_workday() {
    let r = berlin();
    let runs = upcoming(&r, ms("2026-10-20T22:00:00Z"), 12).unwrap();
    assert_eq!(iso(runs[0]), "2026-10-21T06:00:00Z");
    assert_eq!(iso(runs[11]), "2026-10-21T17:00:00Z");
}

#[test]
fn istanbul_offset_37_window_ends_before_23_37() {
    let r = istanbul();
    // Istanbul is UTC+3 all year: 09:37 is 06:37Z, 22:37 is 19:37Z.
    assert_eq!(
        iso(next(&r, ms("2026-10-21T00:00:00Z")).unwrap()),
        "2026-10-21T06:37:00Z"
    );
    assert_eq!(
        iso(next(&r, ms("2026-10-21T19:36:00Z")).unwrap()),
        "2026-10-21T19:37:00Z"
    );
    assert_eq!(
        iso(next(&r, ms("2026-10-21T19:37:00Z")).unwrap()),
        "2026-10-22T06:37:00Z"
    );
}

#[test]
fn spring_forward_keeps_wall_clock_times() {
    // Berlin 2026-03-29: 02:00 -> 03:00. Daytime runs stay on local wall time.
    let r = rule("Europe/Berlin", &[], 0, 23 * 60 + 59, &[0, 30]);
    let from = ms("2026-03-29T00:00:00Z"); // 01:00 CET
    let runs = upcoming(&r, from, 5).unwrap();
    // 01:30 CET, then 02:00 and 02:30 do not exist -> 03:00 and 03:30 CEST, no duplicates.
    assert_eq!(
        runs.iter().map(|m| iso(*m)).collect::<Vec<_>>(),
        [
            "2026-03-29T00:30:00Z",
            "2026-03-29T01:00:00Z",
            "2026-03-29T01:30:00Z",
            "2026-03-29T02:00:00Z",
            "2026-03-29T02:30:00Z",
        ]
    );
    // And the next local-time run after the transition day uses CEST (UTC+2).
    let r = berlin();
    assert_eq!(
        iso(next(&r, ms("2026-03-27T18:00:00Z")).unwrap()),
        "2026-03-30T06:00:00Z"
    );
    assert_eq!(
        iso(next(&r, ms("2026-03-26T18:00:00Z")).unwrap()),
        "2026-03-27T07:00:00Z"
    );
}

#[test]
fn fall_back_repeated_hour_fires_once() {
    // Berlin 2026-10-25: 03:00 CEST -> 02:00 CET, so 02:00-02:59 happens twice.
    let r = rule("Europe/Berlin", &[], 0, 23 * 60 + 59, &[0]);
    let runs = upcoming(&r, ms("2026-10-24T22:00:00Z"), 6).unwrap();
    assert_eq!(
        runs.iter().map(|m| iso(*m)).collect::<Vec<_>>(),
        [
            "2026-10-24T23:00:00Z", // 01:00 CEST
            "2026-10-25T00:00:00Z", // 02:00 CEST, first of the repeated hour
            "2026-10-25T02:00:00Z", // 03:00 CET; 02:00 CET (01:00Z) is not a second run
            "2026-10-25T03:00:00Z",
            "2026-10-25T04:00:00Z",
            "2026-10-25T05:00:00Z",
        ]
    );
}

#[test]
fn a_claim_during_the_repeated_hour_never_fires_it_again() {
    let r = rule("Europe/Berlin", &[], 2 * 60, 2 * 60 + 30, &[30]);
    let first = next(&r, ms("2026-10-24T12:00:00Z")).unwrap();
    assert_eq!(iso(first), "2026-10-25T00:30:00Z");
    for claimed in [
        first,
        ms("2026-10-25T01:30:00Z"),
        ms("2026-10-25T01:45:00Z"),
    ] {
        assert_eq!(iso(next(&r, claimed).unwrap()), "2026-10-26T01:30:00Z");
    }
}

#[test]
fn downtime_coalesces_to_one_catch_up() {
    let r = berlin();
    // Three days offline: one next occurrence from the claim time, not a backlog.
    let late = next(&r, ms("2026-10-26T12:00:00Z")).unwrap();
    assert_eq!(iso(late), "2026-10-26T13:00:00Z");
}

#[test]
fn encode_decode_roundtrip_and_validation() {
    let schedule = TimerSchedule::Calendar(berlin());
    let encoded = super::super::schedule::encode(&schedule).unwrap();
    assert_eq!(
        encoded,
        r#"["calendar","Europe/Berlin",[1,2,3,4,5],480,1140,1,[0]]"#
    );
    assert_eq!(super::super::schedule::decode(&encoded).unwrap(), schedule);
    // Unnormalized rules and unknown zones are refused, not silently repaired.
    let mut bad = berlin();
    bad.minutes = vec![30, 0];
    assert!(super::super::schedule::encode(&TimerSchedule::Calendar(bad)).is_err());
    let mut bad = berlin();
    bad.timezone = "Mars/Olympus".into();
    assert!(super::super::schedule::encode(&TimerSchedule::Calendar(bad)).is_err());
    let event = super::super::schedule::encode(&TimerSchedule::Event).unwrap();
    assert_eq!(
        super::super::schedule::decode(&event).unwrap(),
        TimerSchedule::Event
    );
}

#[test]
fn local_dates_follow_the_zone() {
    // 21:30Z on the 21st is already the 22nd in Istanbul (UTC+3).
    assert_eq!(
        local_date("Europe/Istanbul", ms("2026-10-21T21:30:00Z")).unwrap(),
        "2026-10-22"
    );
    assert_eq!(
        local_date("UTC", ms("2026-10-21T21:30:00Z")).unwrap(),
        "2026-10-21"
    );
    assert!(valid_date("2026-12-25"));
    assert!(!valid_date("2026-02-30") && !valid_date("2026-1-5") && !valid_date("x"));
}

#[test]
fn local_labels_name_the_zone_and_follow_dst() {
    assert_eq!(
        local_time_label("Europe/Berlin", ms("2026-10-21T12:00:00Z")).unwrap(),
        "Wed 21 Oct 14:00 CEST"
    );
    assert_eq!(
        local_time_label("Europe/Berlin", ms("2026-12-24T12:00:00Z")).unwrap(),
        "Thu 24 Dec 13:00 CET"
    );
    assert_eq!(
        local_time_label("Europe/Istanbul", ms("2026-10-21T19:37:00Z")).unwrap(),
        "Wed 21 Oct 22:37 +03"
    );
    assert!(local_time_label("Mars/Base", 0).is_none());
}
