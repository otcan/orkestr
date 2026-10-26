use super::super::policy_pause::{first_allowed, Suppression};
use super::*;
use jiff::Timestamp;

fn ms(text: &str) -> i64 {
    text.parse::<Timestamp>().unwrap().as_millisecond()
}
fn iso(ms: i64) -> String {
    Timestamp::from_millisecond(ms).unwrap().to_string()
}
fn berlin() -> TimerSchedule {
    TimerSchedule::Calendar(
        CalendarRule {
            timezone: "Europe/Berlin".into(),
            weekdays: vec![1, 2, 3, 4, 5],
            start_minute: 480,
            end_minute: 1140,
            every_hours: 1,
            minutes: vec![0],
        }
        .normalized()
        .unwrap(),
    )
}
fn supp(until: i64, skip: &[&str]) -> Suppression {
    Suppression {
        until,
        skip: skip.iter().map(|s| (*s).to_owned()).collect(),
        zone: "Europe/Berlin".into(),
    }
}

#[test]
fn pause_until_resumes_at_the_first_run_at_or_after_the_end() {
    let schedule = berlin();
    // Paused until Wed 2026-10-21 12:30 Berlin (10:30Z): next run is 13:00 (11:00Z).
    let s = supp(ms("2026-10-21T10:30:00Z"), &[]);
    let candidate = ms("2026-10-21T07:00:00Z");
    assert_eq!(
        iso(first_allowed(&s, &schedule, 0, candidate)),
        "2026-10-21T11:00:00Z"
    );
    // Pause ending exactly on a run time allows that run.
    let s = supp(ms("2026-10-21T11:00:00Z"), &[]);
    assert_eq!(
        iso(first_allowed(&s, &schedule, 0, candidate)),
        "2026-10-21T11:00:00Z"
    );
    // A pause already over changes nothing.
    let s = supp(ms("2026-10-20T00:00:00Z"), &[]);
    assert_eq!(first_allowed(&s, &schedule, 0, candidate), candidate);
}

#[test]
fn skip_dates_use_the_local_date_of_the_run() {
    let schedule = berlin();
    // Holiday Thu 2026-10-22: the Wed 19:00 run (17:00Z) is followed by Fri 08:00 (06:00Z).
    let s = supp(0, &["2026-10-22"]);
    let candidate = ms("2026-10-22T06:00:00Z");
    assert_eq!(
        iso(first_allowed(&s, &schedule, 0, candidate)),
        "2026-10-23T06:00:00Z"
    );
    // The day before is untouched.
    let before = ms("2026-10-21T17:00:00Z");
    assert_eq!(first_allowed(&s, &schedule, 0, before), before);
    // A skipped Friday over a weekend resumes Monday.
    let s = supp(0, &["2026-10-23"]);
    assert_eq!(
        iso(first_allowed(&s, &schedule, 0, ms("2026-10-23T06:00:00Z"))),
        "2026-10-26T07:00:00Z"
    );
}

#[test]
fn skip_date_is_judged_in_the_rule_zone_not_utc() {
    // 22:30Z on the 21st is 00:30 on the 22nd in Berlin.
    let s = supp(0, &["2026-10-22"]);
    assert!(s.blocks(ms("2026-10-21T22:30:00Z")));
    assert!(!s.blocks(ms("2026-10-21T21:30:00Z")));
}

#[test]
fn pause_and_skip_combine() {
    let schedule = berlin();
    let s = supp(ms("2026-10-22T10:00:00Z"), &["2026-10-23"]);
    // Paused until Thu 12:00 Berlin; Friday is a holiday: Thursday 12:00 runs.
    assert_eq!(
        iso(first_allowed(&s, &schedule, 0, ms("2026-10-21T08:00:00Z"))),
        "2026-10-22T10:00:00Z"
    );
    let s = supp(ms("2026-10-23T08:00:00Z"), &["2026-10-23"]);
    assert_eq!(
        iso(first_allowed(&s, &schedule, 0, ms("2026-10-21T08:00:00Z"))),
        "2026-10-26T07:00:00Z"
    );
}

#[test]
fn indefinite_pause_leaves_the_candidate_to_the_scheduler_filter() {
    let schedule = berlin();
    let s = supp(FOREVER_MS, &[]);
    let candidate = ms("2026-10-21T07:00:00Z");
    assert_eq!(first_allowed(&s, &schedule, 0, candidate), candidate);
    assert!(s.blocks(candidate));
}

#[test]
fn update_validation_normalizes_and_refuses_bad_input() {
    let mut ok = PolicyUpdate {
        silent_mode: SilentMode::UnlessChanged,
        pause_until_ms: None,
        skip_dates: vec![
            "2026-12-26".into(),
            "2026-12-25".into(),
            "2026-12-25".into(),
        ],
        skip_timezone: None,
        digest: Some(DigestConfig {
            timezone: "Europe/Istanbul".into(),
            minutes: vec![540, 540, 60],
        }),
        trigger: Some(TriggerConfig {
            sources: vec![
                TriggerSource::Email,
                TriggerSource::Message,
                TriggerSource::Email,
            ],
            min_interval_s: 30,
        }),
    };
    validate(&mut ok).unwrap();
    assert_eq!(ok.skip_dates, ["2026-12-25", "2026-12-26"]);
    assert_eq!(ok.digest.as_ref().unwrap().minutes, [60, 540]);
    assert_eq!(
        ok.trigger.as_ref().unwrap().sources,
        [TriggerSource::Email, TriggerSource::Message]
    );
    for mutate in [
        (|u: &mut PolicyUpdate| u.skip_dates = vec!["2026-02-30".into()]) as fn(&mut PolicyUpdate),
        |u| u.skip_dates = vec!["12/25/2026".into()],
        |u| {
            u.skip_dates = (0..401)
                .map(|i| format!("2026-01-{:02}", i % 28 + 1))
                .collect()
        },
        |u| u.pause_until_ms = Some(-1),
        |u| u.pause_until_ms = Some(FOREVER_MS + 1),
        |u| u.skip_timezone = Some("Mars/Olympus".into()),
        |u| {
            u.digest = Some(DigestConfig {
                timezone: "UTC".into(),
                minutes: vec![],
            })
        },
        |u| {
            u.digest = Some(DigestConfig {
                timezone: "UTC".into(),
                minutes: vec![1440],
            })
        },
        |u| {
            u.digest = Some(DigestConfig {
                timezone: "Nowhere/Zone".into(),
                minutes: vec![0],
            })
        },
        |u| {
            u.trigger = Some(TriggerConfig {
                sources: vec![],
                min_interval_s: 0,
            })
        },
        |u| {
            u.trigger = Some(TriggerConfig {
                sources: vec![TriggerSource::Other],
                min_interval_s: 90_000,
            })
        },
    ] {
        let mut bad = ok.clone();
        mutate(&mut bad);
        assert_eq!(validate(&mut bad), Err(HistoryError::Invalid));
    }
}
