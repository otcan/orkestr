mod support;
use orkestr_runtime::{fake::FakeProvider, ports::*, protocol::*};
use orkestr_v2_contracts::runtime::SessionRole;
fn admission(role: SessionRole, id: &str) -> RunAdmission {
    let n = id
        .bytes()
        .fold(0u64, |a, b| a.wrapping_mul(31).wrapping_add(u64::from(b)))
        & 0xffffffffff;
    support::admission(role, n)
}
fn control(a: &RunAdmission) -> InterruptControl {
    support::control(a)
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
    let deep = admission(SessionRole::Deep, "deep");
    let fast = admission(SessionRole::Fast, "fast");
    let worker = admission(SessionRole::Worker, "worker");
    for a in [&deep, &fast, &worker] {
        p.start(a).unwrap();
        assert_eq!(p.poll(a), Ok(Some(ProviderEvent::Started)));
    }
    assert_eq!(p.poll(&deep), Ok(None));
    p.emit(&fast, ProviderEvent::CompletedProposal { synthetic: true })
        .unwrap();
    assert_eq!(
        p.poll(&fast),
        Ok(Some(ProviderEvent::CompletedProposal { synthetic: true }))
    );
    p.interrupt(&control(&worker)).unwrap();
    assert_eq!(p.poll(&worker), Ok(Some(ProviderEvent::Stopped)));
    assert_eq!(p.poll(&deep), Ok(None));
}
#[test]
fn same_native_session_cannot_run_concurrently() {
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let a = admission(SessionRole::Fast, "fast");
    let mut b = admission(SessionRole::Deep, "deep");
    b.native_session_id = a.native_session_id.clone();
    p.start(&a).unwrap();
    assert_eq!(p.start(&b), Err(Blocker::Busy));
}
#[test]
fn stale_lease_and_wrong_run_are_rejected() {
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let a = admission(SessionRole::Deep, "deep");
    p.start(&a).unwrap();
    let mut stale = a.clone();
    stale.lease_generation = 0;
    assert_eq!(
        p.emit(&stale, ProviderEvent::Failed),
        Err(Blocker::StaleLease)
    );
    assert_eq!(p.interrupt(&control(&stale)), Err(Blocker::StaleLease));
    let mut wrong = a.clone();
    wrong.run_id = support::admission(SessionRole::Deep, 999).run_id;
    assert_eq!(p.interrupt(&control(&wrong)), Err(Blocker::StaleLease));
    let mut fenced = a.clone();
    fenced.dispatch_fence += 1;
    p.interrupt(&control(&a)).unwrap();
    assert_eq!(p.poll(&fenced), Err(Blocker::StaleLease));
    assert_eq!(p.poll(&control(&a).cancellation), Err(Blocker::StaleLease));
    assert_eq!(p.poll(&a), Ok(Some(ProviderEvent::Stopped)));
}
#[test]
fn queues_are_bounded_and_fake_never_claims_real_output() {
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let a = admission(SessionRole::Deep, "deep");
    p.start(&a).unwrap();
    assert_eq!(
        p.emit(&a, ProviderEvent::CompletedProposal { synthetic: false }),
        Err(Blocker::FixtureOnly)
    );
    for _ in 0..31 {
        p.emit(&a, ProviderEvent::Progress("synthetic pending".into()))
            .unwrap();
    }
    assert_eq!(p.emit(&a, ProviderEvent::Failed), Err(Blocker::QueueFull));
    p.interrupt(&control(&a)).unwrap(); // stop has priority over bounded progress queue
    assert_eq!(p.poll(&control(&a).cancellation), Err(Blocker::StaleLease));
    assert_eq!(p.poll(&a), Ok(Some(ProviderEvent::Stopped)));
}
#[test]
fn unsupported_resume_fork_and_steer_are_explicit() {
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let a = admission(SessionRole::Fast, "fast");
    assert_eq!(p.resume(&a), Err(Blocker::Unsupported));
    assert_eq!(p.fork(&a), Err(Blocker::Unsupported));
    assert_eq!(p.steer(&a, "hello"), Err(Blocker::Unsupported));
}
#[test]
fn codex_offline_fixture_checks_identity_and_terminal_status() {
    let events: Vec<_> = include_str!("fixtures/codex.jsonl")
        .lines()
        .filter(|line| !line.contains("item/agentMessage/delta"))
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
            ProviderEvent::CompletedProposal { synthetic: false },
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
            None,
            None,
            Some(ProviderEvent::CompletedProposal { synthetic: false }),
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
        ProviderEvent::CompletedProposal { synthetic: true },
        ProviderEvent::Failed,
        ProviderEvent::Lost,
    ] {
        let mut p = FakeProvider::fixture_only(true).unwrap();
        let original = admission(SessionRole::Worker, "terminal-race");
        p.start(&original).unwrap();
        assert_eq!(p.poll(&original), Ok(Some(ProviderEvent::Started)));
        p.emit(&original, terminal.clone()).unwrap();
        let mut cancelled = original.clone();
        cancelled.dispatch_fence += 1;
        assert_eq!(p.interrupt(&control(&original)), Err(Blocker::Busy));
        // Unconfirmed interruption must not relabel or erase the original outcome.
        assert_eq!(p.poll(&cancelled), Err(Blocker::StaleLease));
        assert_eq!(p.poll(&original), Ok(Some(terminal)));
    }
}

#[test]
fn cancellation_ack_token_cannot_start_execution() {
    let mut p = FakeProvider::fixture_only(true).unwrap();
    let a = admission(SessionRole::Worker, "cancel-purpose");
    assert_eq!(p.start(&control(&a).cancellation), Err(Blocker::StaleLease));
    p.start(&a).unwrap();
    assert_eq!(p.poll(&control(&a).cancellation), Err(Blocker::StaleLease));
    assert_eq!(
        p.emit(&a, ProviderEvent::Progress("é".repeat(4097))),
        Err(Blocker::QueueFull)
    );
}

#[test]
fn raw_progress_requires_unavailable_payload_store_not_fabricated_reference() {
    let line = include_str!("fixtures/codex.jsonl")
        .lines()
        .find(|line| line.contains("item/agentMessage/delta"))
        .unwrap();
    assert_eq!(
        codex_event(line, "fixture-thread", "fixture-turn"),
        Err(Blocker::PayloadUnavailable)
    );
    assert_eq!(
        codex_event(line, "wrong-thread", "fixture-turn"),
        Err(Blocker::StaleLease)
    );
}

#[test]
fn provider_progress_bounds_apply_before_payload_mapping() {
    let delta = serde_json::json!({"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"r","delta":"x".repeat(8193)}}).to_string();
    assert_eq!(codex_event(&delta, "t", "r"), Err(Blocker::Protocol));
    let assistant = serde_json::json!({"type":"assistant","session_id":"s","message":{"content":"x".repeat(8193)}}).to_string();
    assert_eq!(claude_event(&assistant, "s"), Err(Blocker::Protocol));
    let result = serde_json::json!({"type":"result","session_id":"s","subtype":"success","is_error":false,"result":"x".repeat(8193)}).to_string();
    assert_eq!(claude_event(&result, "s"), Err(Blocker::Protocol));
}

#[test]
fn claude_session_initialization_never_claims_turn_execution() {
    let init = r#"{"type":"system","subtype":"init","session_id":"synthetic-session"}"#;
    assert_eq!(claude_event(init, "synthetic-session"), Ok(None));
    assert_eq!(
        claude_event(init, "other-session"),
        Err(Blocker::StaleLease)
    );
    // Even a success result remains only a completion proposal, not acceptance.
    let result = r#"{"type":"result","session_id":"synthetic-session","subtype":"success","is_error":false}"#;
    assert_eq!(
        claude_event(result, "synthetic-session"),
        Ok(Some(ProviderEvent::CompletedProposal { synthetic: false }))
    );
}
