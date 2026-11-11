//! ORK-786: one run state near the composer; its words and controls agree.
use orkestr_v2_contracts::{ExecutionPhase, ExecutionStatus};
use orkestr_v2_ui::run_state::{run_view, Observation, RunState, RunView};

fn status(phase: &str, stop: bool, steer: bool) -> ExecutionStatus {
    let failure = matches!(phase, "failed").then(|| serde_json::json!({"class":"quota"}));
    let value = serde_json::json!({"schema_version":1,
        "conversation_id":"00000000-0000-4000-8000-000000000001",
        "run_id":"00000000-0000-4000-8000-000000000002","revision":3,
        "observed_at_ms":100,"phase":phase,"queue_age_ms":null,
        "progress":null,"resources":null,"capabilities":{"stop":stop,"steer":steer},
        "failure":failure});
    let status: ExecutionStatus = serde_json::from_value(value).unwrap();
    assert!(status.is_valid(), "{phase}");
    status
}

fn live(status: &ExecutionStatus) -> RunView {
    run_view(Observation {
        status: Some(status),
        observed: true,
        connected: true,
        fresh: true,
        auto_accept: false,
    })
}

const PHASES: [&str; 9] = [
    "queued",
    "starting",
    "running",
    "cancel_requested",
    "cancelled",
    "awaiting_acceptance",
    "completed",
    "failed",
    "blocked",
];

#[test]
fn every_phase_maps_to_one_state_with_consistent_label_and_controls() {
    let expected = [
        ("queued", RunState::Queued, "Queued", true, false),
        ("starting", RunState::Running, "Starting…", true, false),
        ("running", RunState::Running, "Working", true, true),
        (
            "cancel_requested",
            RunState::Stopping,
            "Stop requested · waiting for confirmation",
            false,
            false,
        ),
        ("cancelled", RunState::Stopped, "Stopped", false, false),
        (
            "awaiting_acceptance",
            RunState::AwaitingInput,
            "Reply ready · review and accept",
            false,
            false,
        ),
        ("completed", RunState::Completed, "Completed", false, false),
        (
            "failed",
            RunState::Failed,
            "Failed: provider usage limit reached",
            false,
            false,
        ),
        (
            "blocked",
            RunState::AwaitingInput,
            "Work needs your attention",
            false,
            false,
        ),
    ];
    for (phase, state, label, stop, steer) in expected {
        let view = live(&status(phase, true, true));
        assert_eq!(view.state, state, "{phase}");
        assert_eq!(view.label, label, "{phase}");
        assert_eq!((view.stop, view.steer), (stop, steer), "{phase}");
    }
}

#[test]
fn completed_and_other_finished_work_never_offers_stop_or_steer() {
    for phase in [
        "completed",
        "cancelled",
        "failed",
        "awaiting_acceptance",
        "blocked",
        "cancel_requested",
    ] {
        let view = live(&status(phase, true, true));
        assert!(!view.stop && !view.steer, "{phase} offers a run control");
    }
    let done = live(&status("completed", true, true));
    assert_eq!(done.label, "Completed");
    assert_eq!(done.detail, None, "model details only when reported");
    let mut reported = status("completed", true, true);
    reported.models =
        Some(serde_json::from_value(serde_json::json!({"actual_model":"answer-model"})).unwrap());
    assert_eq!(
        live(&reported).detail.as_deref(),
        Some("Answered with answer-model")
    );
    // A running run shows no model line.
    let mut running = status("running", true, true);
    running.models = reported.models.clone();
    assert_eq!(live(&running).detail, None);
}

#[test]
fn controls_follow_the_run_capabilities() {
    for phase in PHASES {
        let view = live(&status(phase, false, false));
        assert!(!view.stop && !view.steer, "{phase} without capabilities");
    }
    let stop_only = live(&status("running", true, false));
    assert!(stop_only.stop && !stop_only.steer);
    let steer_only = live(&status("running", false, true));
    assert!(!steer_only.stop && steer_only.steer);
    // A queued entry without a run has nothing to stop.
    let mut unassigned = status("queued", true, true);
    unassigned.run_id = None;
    assert!(unassigned.is_valid());
    assert!(!live(&unassigned).stop);
}

#[test]
fn acceptance_is_offered_only_when_the_owner_reviews_replies() {
    let ready = status("awaiting_acceptance", false, false);
    assert!(live(&ready).accept);
    let auto = run_view(Observation {
        status: Some(&ready),
        observed: true,
        connected: true,
        fresh: true,
        auto_accept: true,
    });
    assert_eq!(auto.state, RunState::AwaitingInput);
    assert_eq!(auto.label, "Reply ready · accepting automatically");
    assert!(!auto.accept);
    for phase in PHASES.iter().filter(|p| **p != "awaiting_acceptance") {
        assert!(!live(&status(phase, true, true)).accept, "{phase}");
    }
}

#[test]
fn checking_idle_and_disconnected_offer_nothing_and_never_imply_completion() {
    let none = |observed, connected| {
        run_view(Observation {
            status: None,
            observed,
            connected,
            fresh: false,
            auto_accept: false,
        })
    };
    assert_eq!(none(false, false).state, RunState::Checking);
    assert_eq!(none(true, true).state, RunState::Idle);
    assert_eq!(none(true, true).label, "No work running");
    assert_eq!(none(true, false).state, RunState::Disconnected);
    let running = status("running", true, true);
    for (connected, fresh, lead) in [
        (false, true, "Disconnected"),
        (false, false, "Disconnected"),
        (true, false, "Status not current"),
    ] {
        let view = run_view(Observation {
            status: Some(&running),
            observed: true,
            connected,
            fresh,
            auto_accept: false,
        });
        assert_eq!(view.state, RunState::Disconnected);
        assert!(view.label.starts_with(lead), "{}", view.label);
        assert!(view.label.contains("last known: working"));
        assert!(view.label.contains("does not confirm completion"));
        assert!(!view.stop && !view.steer && !view.accept);
    }
    for view in [none(false, false), none(true, true), none(true, false)] {
        assert!(!view.stop && !view.steer && !view.accept);
    }
}

#[test]
fn states_have_distinct_markup_names() {
    let all = [
        RunState::Checking,
        RunState::Idle,
        RunState::Queued,
        RunState::Running,
        RunState::Stopping,
        RunState::AwaitingInput,
        RunState::Completed,
        RunState::Stopped,
        RunState::Failed,
        RunState::Disconnected,
    ];
    let mut slugs: Vec<_> = all.iter().map(|s| s.slug()).collect();
    slugs.sort_unstable();
    slugs.dedup();
    assert_eq!(slugs.len(), all.len());
    assert_eq!(
        ExecutionPhase::Completed,
        status("completed", true, true).phase
    );
}
