use orkestr_runtime::{fake::FakeProvider, ports::*, protocol::*};
fn admission(role: Role, id: &str) -> Admission {
    Admission {
        run_id: format!("run-{id}"),
        session_id: format!("session-{id}"),
        native_session_id: format!("FAKE-{id}"),
        generation: 1,
        role,
    }
}
#[test]
fn fixture_requires_explicit_selection() {
    assert!(matches!(
        FakeProvider::fixture_only(false),
        Err(Blocker::FixtureOnly)
    ));
}
#[test]
fn busy_deep_does_not_block_fast_or_independent_worker() {
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let deep = admission(Role::Deep, "deep");
    let fast = admission(Role::Fast, "fast");
    let worker = admission(Role::Worker, "worker");
    for a in [&deep, &fast, &worker] {
        p.start(a).unwrap();
        assert_eq!(p.poll(a), Ok(Some(ProviderEvent::Started)));
    }
    assert_eq!(p.poll(&deep), Ok(None));
    p.emit(&fast, ProviderEvent::Completed { synthetic: true })
        .unwrap();
    assert_eq!(
        p.poll(&fast),
        Ok(Some(ProviderEvent::Completed { synthetic: true }))
    );
    p.interrupt(&worker).unwrap();
    assert_eq!(p.poll(&worker), Ok(Some(ProviderEvent::Stopped)));
    assert_eq!(p.poll(&deep), Ok(None));
}
#[test]
fn same_native_session_cannot_run_concurrently() {
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let a = admission(Role::Fast, "fast");
    let mut b = admission(Role::Deep, "deep");
    b.native_session_id = a.native_session_id.clone();
    p.start(&a).unwrap();
    assert_eq!(p.start(&b), Err(Blocker::Busy));
}
#[test]
fn stale_lease_and_wrong_run_are_rejected() {
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let a = admission(Role::Deep, "deep");
    p.start(&a).unwrap();
    let mut stale = a.clone();
    stale.generation = 0;
    assert_eq!(
        p.emit(&stale, ProviderEvent::Failed),
        Err(Blocker::StaleLease)
    );
    assert_eq!(p.interrupt(&stale), Err(Blocker::StaleLease));
    let mut wrong = a.clone();
    wrong.run_id = "other".into();
    assert_eq!(p.interrupt(&wrong), Err(Blocker::StaleLease));
    let mut fenced = a.clone();
    fenced.generation += 1;
    p.interrupt(&fenced).unwrap();
    assert_eq!(p.poll(&a), Err(Blocker::StaleLease));
    assert_eq!(p.poll(&fenced), Ok(Some(ProviderEvent::Stopped)));
}
#[test]
fn queues_are_bounded_and_fake_never_claims_real_output() {
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let a = admission(Role::Deep, "deep");
    p.start(&a).unwrap();
    assert_eq!(
        p.emit(&a, ProviderEvent::Completed { synthetic: false }),
        Err(Blocker::FixtureOnly)
    );
    for _ in 0..31 {
        p.emit(&a, ProviderEvent::Progress("pending".into()))
            .unwrap();
    }
    assert_eq!(p.emit(&a, ProviderEvent::Failed), Err(Blocker::QueueFull));
    p.interrupt(&a).unwrap(); // stop has priority over bounded progress queue
    assert_eq!(p.poll(&a), Ok(Some(ProviderEvent::Stopped)));
}
#[test]
fn unsupported_resume_fork_and_steer_are_explicit() {
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let a = admission(Role::Fast, "fast");
    assert_eq!(p.resume(&a), Err(Blocker::Unsupported));
    assert_eq!(p.fork(&a), Err(Blocker::Unsupported));
    assert_eq!(p.steer(&a, "hello"), Err(Blocker::Unsupported));
}
#[test]
fn codex_offline_fixture_checks_identity_and_terminal_status() {
    let events: Vec<_> = include_str!("fixtures/codex.jsonl")
        .lines()
        .map(|line| {
            codex_event(line, "fixture-thread", "fixture-turn")
                .unwrap()
                .unwrap()
        })
        .collect();
    assert_eq!(
        events,
        vec![
            ProviderEvent::Started,
            ProviderEvent::Progress("Synthetic fixture output".into()),
            ProviderEvent::Completed { synthetic: false },
            ProviderEvent::Stopped,
            ProviderEvent::Failed
        ]
    );
    let line = include_str!("fixtures/codex.jsonl").lines().next().unwrap();
    assert_eq!(
        codex_event(line, "wrong", "fixture-turn"),
        Err(Blocker::StaleLease)
    );
    assert_eq!(
        codex_event(line, "fixture-thread", "wrong"),
        Err(Blocker::StaleLease)
    );
}
#[test]
fn claude_offline_fixture_checks_identity_and_error_status() {
    let events: Vec<_> = include_str!("fixtures/claude.jsonl")
        .lines()
        .map(|line| claude_event(line, "fixture-session").unwrap())
        .collect();
    assert_eq!(
        events,
        vec![
            Some(ProviderEvent::Started),
            None,
            Some(ProviderEvent::Completed { synthetic: false }),
            Some(ProviderEvent::Failed)
        ]
    );
    assert_eq!(
        claude_event(
            include_str!("fixtures/claude.jsonl")
                .lines()
                .next()
                .unwrap(),
            "wrong"
        ),
        Err(Blocker::StaleLease)
    );
}
#[test]
fn malformed_and_oversized_protocol_frames_fail_closed() {
    assert_eq!(codex_event("{", "t", "r"), Err(Blocker::Protocol));
    assert_eq!(
        claude_event(&"x".repeat(65537), "s"),
        Err(Blocker::Protocol)
    );
    assert_eq!(
        claude_event(
            r#"{"type":"result","session_id":"s","subtype":"success"}"#,
            "s"
        ),
        Err(Blocker::Protocol)
    );
    let init: serde_json::Value = serde_json::from_str(&codex_initialize()).unwrap();
    assert_eq!(init["method"], "initialize");
}

#[test]
fn terminal_evidence_survives_newer_cancel_generation() {
    for terminal in [
        ProviderEvent::Completed { synthetic: true },
        ProviderEvent::Failed,
        ProviderEvent::Lost,
    ] {
        let mut p = FakeProvider::fixture_only(true).unwrap();
        let original = admission(Role::Worker, "terminal-race");
        p.start(&original).unwrap();
        assert_eq!(p.poll(&original), Ok(Some(ProviderEvent::Started)));
        p.emit(&original, terminal.clone()).unwrap();
        let mut cancelled = original.clone();
        cancelled.generation += 1;
        assert_eq!(p.interrupt(&cancelled), Err(Blocker::Busy));
        // Unconfirmed interruption must not relabel or erase the original outcome.
        assert_eq!(p.poll(&cancelled), Err(Blocker::StaleLease));
        assert_eq!(p.poll(&original), Ok(Some(terminal)));
    }
}
