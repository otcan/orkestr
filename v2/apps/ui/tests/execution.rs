use orkestr_v2_contracts::ConversationSnapshot;
use orkestr_v2_ui::{
    execution::{Execution, Phase, Sample},
    Draft, Projection,
};
fn sample() -> Sample {
    Sample {
        conversation: "synthetic-conversation".into(),
        run: "synthetic-run".into(),
        revision: 1,
        observed_ms: 1000,
        phase: Phase::Running,
        queue_age_ms: Some(2500),
        progress: Some((2, 10)),
        cpu_percent: Some(25),
        ram_bytes: Some(1048576),
        stop_supported: true,
        steering_supported: true,
    }
}
#[test]
fn stale_disconnect_and_request_never_claim_stopped_or_enable_controls() {
    let mut state = Execution::default();
    assert!(!state.can_stop(1000));
    state
        .apply("synthetic-conversation", 1000, sample())
        .unwrap();
    assert!(state.can_stop(1000) && state.can_steer(1000));
    assert!(state.summary(1000).contains("2/10"));
    assert!(state.resources(1000).contains("1 MiB"));
    assert!(!state.can_stop(17000));
    assert!(state.summary(17000).contains("stale"));
    assert!(!state.resources(17000).contains("25%"));
    state.disconnected();
    assert!(!state.can_steer(1000));
    let mut pending = sample();
    pending.revision = 2;
    pending.phase = Phase::CancellationRequested;
    state
        .apply("synthetic-conversation", 1000, pending)
        .unwrap();
    assert!(!state.can_stop(1000));
    assert!(!state.summary(1000).contains("Cancelled"));
    let mut confirmed = sample();
    confirmed.revision = 3;
    confirmed.phase = Phase::Cancelled;
    state
        .apply("synthetic-conversation", 1000, confirmed)
        .unwrap();
    assert!(state.summary(1000).contains("Cancelled"));
}
#[test]
fn invalid_or_out_of_order_samples_preserve_confirmed_status() {
    let mut state = Execution::default();
    state
        .apply("synthetic-conversation", 1000, sample())
        .unwrap();
    let before = state.summary(1000);
    for i in 0..6 {
        let mut bad = sample();
        bad.revision = 2;
        match i {
            0 => bad.conversation = "wrong".into(),
            1 => bad.observed_ms = 1001,
            2 => bad.revision = 1,
            3 => bad.progress = Some((11, 10)),
            4 => bad.cpu_percent = Some(101),
            _ => bad.run.clear(),
        }
        assert!(state.apply("synthetic-conversation", 1000, bad).is_err());
        assert_eq!(state.summary(1000), before);
    }
}
#[test]
fn thirty_second_busy_composer_preserves_new_draft_and_original_retry() {
    let mut draft = Draft::default();
    draft.edit("first request".into());
    let input = draft.prepare("synthetic-request".into()).unwrap();
    for second in 1..=30 {
        draft.edit(format!("steering draft at {second}s"));
        assert_eq!(
            draft
                .prepare("unused-new-key".into())
                .unwrap()
                .client_message_id,
            input.client_message_id
        );
    }
    draft.accepted();
    assert_eq!(draft.text, "steering draft at 30s");
    assert!(draft.pending.is_none());
}
#[test]
fn ten_thousand_history_rows_keep_render_window_bounded() {
    let start = std::time::Instant::now();
    let template: ConversationSnapshot =
        serde_json::from_str(include_str!("../../../fixtures/conversation-snapshot.json")).unwrap();
    let mut projection = Projection::default();
    for page in 0..100 {
        let mut snapshot = template.clone();
        snapshot.last_sequence = 10000;
        snapshot.messages = (1..=100)
            .map(|offset| {
                let mut m = template.messages[0].clone();
                m.sequence = page * 100 + offset;
                m.text = format!("synthetic message {}", m.sequence);
                m
            })
            .collect();
        projection.page(snapshot).unwrap();
        assert!(projection.messages.len() <= 100);
    }
    assert_eq!(projection.messages.keys().next().copied(), Some(9901));
    assert_eq!(projection.messages.keys().last().copied(), Some(10000));
    assert!(
        start.elapsed() < std::time::Duration::from_secs(5),
        "10k history processing exceeded generous local regression budget"
    );
}
