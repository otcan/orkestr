//! Synthetic protocol fixtures only. No provider process, profile, or credentials.
use super::*;
use serde_json::json;

const SESSION: &str = "11111111-2222-4333-8444-555555555555";
const OTHER: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const KEY: &str = "synthetic:fast:request-1";
const PRIVATE: &str = "synthetic-provider-content-must-not-escape";

fn parser() -> ClaudeRpc {
    ClaudeRpc::new(SESSION, KEY).unwrap()
}

fn init(session: &str) -> Value {
    json!({"type":"system", "subtype":"init", "session_id":session})
}

fn assistant(session: &str) -> Value {
    json!({"type":"assistant", "session_id":session, "parent_tool_use_id":null,
        "message":{"role":"assistant", "content":[{"type":"text", "text":PRIVATE}]}})
}

fn result(session: &str, error: bool) -> Value {
    json!({"type":"result", "subtype":"success", "session_id":session,
        "is_error":error, "result":PRIVATE})
}

fn receive(parser: &mut ClaudeRpc, value: Value) -> Result<Option<ClaudeObservation>, Blocker> {
    parser.receive(KEY, &value.to_string())
}

fn initialized() -> ClaudeRpc {
    let mut parser = parser();
    assert_eq!(
        receive(&mut parser, init(SESSION)),
        Ok(Some(ClaudeObservation::Initialized))
    );
    assert!(!parser.terminal_result_seen());
    parser
}

fn assert_quarantined(parser: &mut ClaudeRpc) {
    assert_eq!(receive(parser, init(SESSION)), Err(Blocker::Protocol));
    assert_eq!(
        receive(parser, result(SESSION, false)),
        Err(Blocker::Protocol)
    );
    assert_eq!(parser.finish(KEY), Err(Blocker::Protocol));
}

#[test]
fn success_is_only_a_proposal_and_clean_eof_is_separate() {
    let mut parser = initialized();
    assert_eq!(
        receive(&mut parser, assistant(SESSION)),
        Ok(Some(ClaudeObservation::Progress))
    );
    assert!(!parser.terminal_result_seen());
    let observed = receive(&mut parser, result(SESSION, false)).unwrap();
    assert_eq!(observed, Some(ClaudeObservation::CompletedProposal));
    assert_eq!(format!("{observed:?}"), "Some(CompletedProposal)");
    assert!(parser.terminal_result_seen());
    assert_eq!(parser.finish(KEY), Ok(()));
}

#[test]
fn constructor_requires_bounded_local_key_and_native_uuid() {
    for session in [
        "",
        "synthetic",
        "11111111_2222-4333-8444-555555555555",
        "11111111-2222-4333-8444-55555555555z",
    ] {
        assert!(matches!(
            ClaudeRpc::new(session, KEY),
            Err(Blocker::Protocol)
        ));
    }
    for key in ["", "key with space", "key\n", "ümlaut"] {
        assert!(matches!(
            ClaudeRpc::new(SESSION, key),
            Err(Blocker::Protocol)
        ));
    }
    assert!(ClaudeRpc::new(SESSION, &"a".repeat(MAX_KEY_BYTES)).is_ok());
    assert!(matches!(
        ClaudeRpc::new(SESSION, &"a".repeat(MAX_KEY_BYTES + 1)),
        Err(Blocker::Protocol)
    ));
}

#[test]
fn native_uuid_case_does_not_change_session_identity() {
    let mut parser = ClaudeRpc::new(OTHER, KEY).unwrap();
    assert_eq!(
        receive(&mut parser, init(&OTHER.to_ascii_uppercase())),
        Ok(Some(ClaudeObservation::Initialized))
    );
    assert_eq!(
        receive(&mut parser, result(OTHER, false)),
        Ok(Some(ClaudeObservation::CompletedProposal))
    );
}

#[test]
fn session_mismatch_on_every_frame_kind_poisons_only_that_parser() {
    for value in [
        init(OTHER),
        assistant(OTHER),
        result(OTHER, false),
        json!({"type":"rate_limit_event", "session_id":OTHER}),
        json!({"type":"unknown", "session_id":OTHER}),
    ] {
        let mut parser = parser();
        assert_eq!(receive(&mut parser, value), Err(Blocker::StaleLease));
        assert_quarantined(&mut parser);
    }
}

#[test]
fn local_request_key_is_checked_for_each_frame_and_eof() {
    for value in [init(SESSION), assistant(SESSION), result(SESSION, false)] {
        let mut parser = parser();
        assert_eq!(
            parser.receive("synthetic:wrong-role", &value.to_string()),
            Err(Blocker::StaleLease)
        );
        assert_quarantined(&mut parser);
    }
    let mut parser = initialized();
    receive(&mut parser, result(SESSION, false)).unwrap();
    assert_eq!(
        parser.finish("synthetic:other-request"),
        Err(Blocker::StaleLease)
    );
    assert_quarantined(&mut parser);
}

#[test]
fn role_connections_can_interleave_but_cannot_exchange_frames() {
    let mut fast = parser();
    let mut deep = ClaudeRpc::new(OTHER, "synthetic:deep:request-1").unwrap();
    receive(&mut fast, init(SESSION)).unwrap();
    deep.receive("synthetic:deep:request-1", &init(OTHER).to_string())
        .unwrap();
    receive(&mut fast, assistant(SESSION)).unwrap();
    assert_eq!(
        receive(&mut fast, result(OTHER, false)),
        Err(Blocker::StaleLease)
    );
    assert_quarantined(&mut fast);
    assert_eq!(
        deep.receive("synthetic:deep:request-1", &assistant(OTHER).to_string()),
        Ok(Some(ClaudeObservation::Progress))
    );
    assert_eq!(
        deep.receive(
            "synthetic:deep:request-1",
            &result(OTHER, false).to_string()
        ),
        Ok(Some(ClaudeObservation::CompletedProposal))
    );
    assert_eq!(deep.finish("synthetic:deep:request-1"), Ok(()));
}

#[test]
fn missing_malformed_or_conflicting_session_identity_is_rejected() {
    for value in [
        json!({"type":"system", "subtype":"init", "sessionId":SESSION}),
        json!({"type":"system", "subtype":"init", "session_id":null}),
        json!({"type":"system", "subtype":"init", "session_id":"not-a-uuid"}),
        json!({"type":"system", "subtype":"init", "session_id":SESSION, "sessionId":OTHER}),
        json!({"type":"assistant", "session_id":SESSION,
            "message":{"session_id":OTHER, "content":[]}}),
    ] {
        let mut parser = parser();
        assert!(receive(&mut parser, value).is_err());
        assert_quarantined(&mut parser);
    }
}

#[test]
fn malformed_truncated_multiline_and_non_object_frames_fail_closed() {
    for line in [
        "",
        " ",
        "{",
        "{\"type\":\"result\"",
        "null",
        "[]",
        "{}{}",
        "{}\n{}",
        "{}\r",
        "{}\0",
    ] {
        let mut parser = parser();
        assert_eq!(parser.receive(KEY, line), Err(Blocker::Protocol));
        assert_quarantined(&mut parser);
    }
}

#[test]
fn clean_eof_without_result_is_not_completion() {
    for with_init in [false, true] {
        let mut parser = if with_init { initialized() } else { parser() };
        assert_eq!(parser.finish(KEY), Err(Blocker::Protocol));
        assert_quarantined(&mut parser);
    }
}

#[test]
fn unknown_frame_and_system_subtypes_are_unsupported_not_silently_dropped() {
    for value in [
        json!({"type":"stream_event", "session_id":SESSION}),
        json!({"type":"future_event", "session_id":SESSION}),
        json!({"type":"system", "subtype":"future_notice", "session_id":SESSION}),
    ] {
        let mut parser = parser();
        assert_eq!(receive(&mut parser, value), Err(Blocker::Unsupported));
        assert_quarantined(&mut parser);
    }
}

#[test]
fn duplicate_init_and_early_progress_or_success_are_invalid() {
    let mut duplicate = initialized();
    assert_eq!(
        receive(&mut duplicate, init(SESSION)),
        Err(Blocker::Protocol)
    );
    assert_quarantined(&mut duplicate);
    for value in [assistant(SESSION), result(SESSION, false)] {
        let mut parser = parser();
        assert_eq!(receive(&mut parser, value), Err(Blocker::Protocol));
        assert_quarantined(&mut parser);
    }
}

#[test]
fn housekeeping_and_replayed_user_text_are_not_progress() {
    let mut parser = parser();
    let housekeeping = json!({"type":"rate_limit_event", "session_id":SESSION,
        "rate_limit_info":{"status":"allowed"}});
    assert_eq!(receive(&mut parser, housekeeping.clone()), Ok(None));
    receive(&mut parser, init(SESSION)).unwrap();
    assert_eq!(receive(&mut parser, housekeeping), Ok(None));
    assert_eq!(
        receive(
            &mut parser,
            json!({"type":"user", "session_id":SESSION,
        "message":{"role":"user", "content":[{"type":"text", "text":PRIVATE}]}})
        ),
        Ok(None)
    );
    assert!(!parser.terminal_result_seen());
}

#[test]
fn tool_and_subagent_content_is_opaque_progress_not_dispatch_or_completion() {
    let mut parser = initialized();
    assert_eq!(
        receive(
            &mut parser,
            json!({"type":"assistant", "session_id":SESSION,
        "parent_tool_use_id":"synthetic-parent-tool", "message":{"role":"assistant",
        "content":[{"type":"tool_use", "name":"synthetic-noop", "input":
            {"type":"result", "subtype":"success", "is_error":false, "result":PRIVATE}}]}})
        ),
        Ok(Some(ClaudeObservation::Progress))
    );
    assert_eq!(
        receive(
            &mut parser,
            json!({"type":"user", "session_id":SESSION,
        "message":{"content":[{"type":"tool_result", "content":PRIVATE}]}})
        ),
        Ok(Some(ClaudeObservation::Progress))
    );
    assert!(!parser.terminal_result_seen());
}

#[test]
fn nested_init_or_result_cannot_own_the_root_invocation() {
    for mut value in [init(SESSION), result(SESSION, false)] {
        value["parent_tool_use_id"] = json!("synthetic-child");
        let mut parser = parser();
        assert_eq!(receive(&mut parser, value), Err(Blocker::Protocol));
        assert_quarantined(&mut parser);
    }
}

#[test]
fn explicit_result_error_can_precede_init_and_never_exposes_its_text() {
    let mut parser = parser();
    let mut value = result(SESSION, true);
    value["subtype"] = json!("error_during_execution");
    value["errors"] = json!([PRIVATE]);
    let observed = receive(&mut parser, value).unwrap();
    assert_eq!(format!("{observed:?}"), "Some(Failed)");
    assert!(parser.terminal_result_seen());
    assert_eq!(parser.finish(KEY), Ok(()));
}

#[test]
fn assistant_error_requires_terminal_error_and_cannot_become_success() {
    for terminal_error in [false, true] {
        let mut parser = initialized();
        let mut notice = assistant(SESSION);
        notice["error"] = json!("rate_limit");
        assert_eq!(
            receive(&mut parser, notice),
            Ok(Some(ClaudeObservation::Failed))
        );
        assert!(!parser.terminal_result_seen());
        assert_eq!(receive(&mut parser, assistant(SESSION)), Ok(None));
        let observed = receive(&mut parser, result(SESSION, terminal_error));
        if terminal_error {
            assert_eq!(observed, Ok(Some(ClaudeObservation::Failed)));
            assert_eq!(parser.finish(KEY), Ok(()));
        } else {
            assert_eq!(observed, Err(Blocker::Protocol));
            assert_quarantined(&mut parser);
        }
    }
    let mut parser = parser();
    let mut notice = assistant(SESSION);
    notice["error"] = json!("authentication_failed");
    assert_eq!(
        receive(&mut parser, notice),
        Ok(Some(ClaudeObservation::Failed))
    );
    assert_eq!(parser.finish(KEY), Err(Blocker::Protocol));
}

#[test]
fn closed_error_class_maps_to_presentation_class_and_first_notice_wins() {
    use orkestr_v2_contracts::ExecutionFailureClass as Class;
    for (error, class) in [
        ("authentication_failed", Class::Authentication),
        ("rate_limit", Class::Quota),
        ("billing_error", Class::Billing),
        ("server_error", Class::Provider),
        ("invalid_request", Class::Provider),
        ("unknown", Class::Unknown),
        ("novel", Class::Unknown),
    ] {
        let mut parser = initialized();
        assert_eq!(parser.failure_class(), None);
        let mut notice = assistant(SESSION);
        notice["error"] = json!(error);
        receive(&mut parser, notice).unwrap();
        let mut later = assistant(SESSION);
        later["error"] = json!("rate_limit");
        receive(&mut parser, later).unwrap();
        assert_eq!(parser.failure_class(), Some(class), "{error}");
    }
    let mut parser = initialized();
    receive(&mut parser, result(SESSION, true)).unwrap();
    assert_eq!(
        parser.failure_class(),
        None,
        "unclassified failure stays None"
    );
}

#[test]
fn arbitrary_provider_words_do_not_turn_into_errors_or_verified_success() {
    let mut parser = initialized();
    let mut content = assistant(SESSION);
    content["message"]["content"][0]["text"] =
        json!("error success completed verified authentication_failed");
    assert_eq!(
        receive(&mut parser, content),
        Ok(Some(ClaudeObservation::Progress))
    );
    assert!(!parser.terminal_result_seen());
    let mut empty = result(SESSION, false);
    empty["result"] = json!("");
    assert_eq!(
        receive(&mut parser, empty),
        Ok(Some(ClaudeObservation::CompletedProposal))
    );
}

#[test]
fn terminal_replay_or_conflicting_result_irreversibly_quarantines_connection() {
    for first_error in [false, true] {
        for next in [
            result(SESSION, false),
            result(SESSION, true),
            assistant(SESSION),
            init(SESSION),
        ] {
            let mut parser = initialized();
            receive(&mut parser, result(SESSION, first_error)).unwrap();
            assert_eq!(receive(&mut parser, next), Err(Blocker::Protocol));
            assert_quarantined(&mut parser);
        }
    }
}

#[test]
fn malformed_message_result_and_parent_fields_are_not_success() {
    let mut invalid = Vec::new();
    for (field, value) in [
        ("is_error", json!("false")),
        ("subtype", json!("")),
        ("result", json!({"text":PRIVATE})),
        ("parent_tool_use_id", json!(42)),
    ] {
        let mut frame = result(SESSION, false);
        frame[field] = value;
        invalid.push(frame);
    }
    let mut absent_result = result(SESSION, false);
    absent_result.as_object_mut().unwrap().remove("result");
    invalid.push(absent_result);
    for (field, value) in [
        ("role", json!("user")),
        ("content", json!(PRIVATE)),
        ("content", json!([null])),
    ] {
        let mut frame = assistant(SESSION);
        frame["message"][field] = value;
        invalid.push(frame);
    }
    for value in invalid {
        let mut parser = initialized();
        assert_eq!(receive(&mut parser, value), Err(Blocker::Protocol));
        assert_quarantined(&mut parser);
    }
    let mut parser = initialized();
    let mut future_result = result(SESSION, false);
    future_result["subtype"] = json!("future_success");
    assert_eq!(
        receive(&mut parser, future_result),
        Err(Blocker::Unsupported)
    );
}

#[test]
fn frame_limit_is_in_bytes_and_accepts_its_exact_boundary() {
    let mut line = init(SESSION).to_string();
    line.extend(std::iter::repeat_n(' ', MAX_FRAME_BYTES - line.len()));
    assert_eq!(
        parser().receive(KEY, &line),
        Ok(Some(ClaudeObservation::Initialized))
    );
    line.push(' ');
    let mut parser = parser();
    assert_eq!(parser.receive(KEY, &line), Err(Blocker::Protocol));
    assert_quarantined(&mut parser);
}

#[test]
fn string_and_key_limits_apply_to_unknown_fields_too() {
    for (size, accepted) in [(MAX_STRING_BYTES, true), (MAX_STRING_BYTES + 1, false)] {
        let mut frame = init(SESSION);
        frame["opaque"] = json!("x".repeat(size));
        assert_eq!(receive(&mut parser(), frame).is_ok(), accepted);
    }
    let mut frame = init(SESSION);
    frame["opaque"] = json!("é".repeat(MAX_STRING_BYTES / 2 + 1));
    assert_eq!(receive(&mut parser(), frame), Err(Blocker::Protocol));
    let mut frame = init(SESSION);
    frame["x".repeat(MAX_KEY_BYTES + 1)] = json!(null);
    assert_eq!(receive(&mut parser(), frame), Err(Blocker::Protocol));
}

#[test]
fn depth_collection_and_node_budgets_are_enforced() {
    let mut nested = json!(null);
    for _ in 0..MAX_DEPTH - 1 {
        nested = json!([nested]);
    }
    let mut frame = init(SESSION);
    frame["opaque"] = nested.clone();
    assert!(receive(&mut parser(), frame.clone()).is_ok());
    frame["opaque"] = json!([nested]);
    assert_eq!(receive(&mut parser(), frame), Err(Blocker::Protocol));
    for (size, accepted) in [(MAX_COLLECTION, true), (MAX_COLLECTION + 1, false)] {
        let mut frame = init(SESSION);
        frame["opaque"] = json!(vec![0; size]);
        assert_eq!(receive(&mut parser(), frame).is_ok(), accepted);
        let fields: serde_json::Map<String, Value> =
            (0..size).map(|n| (n.to_string(), json!(null))).collect();
        let mut frame = init(SESSION);
        frame["opaque"] = Value::Object(fields);
        assert_eq!(receive(&mut parser(), frame).is_ok(), accepted);
    }
    let mut frame = init(SESSION);
    frame["opaque"] = json!(vec![vec![0; MAX_COLLECTION]; 16]);
    assert!(frame.to_string().len() < MAX_FRAME_BYTES);
    assert_eq!(receive(&mut parser(), frame), Err(Blocker::Protocol));
}

#[test]
fn errors_do_not_contain_native_ids_keys_or_provider_content() {
    let mut parser = initialized();
    let mut frame = result(OTHER, false);
    frame["error_detail"] = json!(PRIVATE);
    let error = receive(&mut parser, frame).unwrap_err();
    assert_eq!(format!("{error:?}"), "StaleLease");
    assert_quarantined(&mut parser);
}

#[test]
fn duplicate_or_escaped_keys_cannot_replace_identity_or_result_flags() {
    for suffix in [
        r#", "is_error":true, "is_error":false"#,
        r#", "is_\u0065rror":true"#,
        r#", "session_\u0069d":"11111111-2222-4333-8444-555555555555"#,
        r#", "opaque":{"nested":1,"nested":2}"#,
    ] {
        let mut line = result(SESSION, false).to_string();
        line.pop();
        line.push_str(suffix);
        line.push('}');
        let mut parser = initialized();
        assert_eq!(parser.receive(KEY, &line), Err(Blocker::Protocol));
        assert_quarantined(&mut parser);
    }
    let mut frame = assistant(SESSION);
    frame["message"]["content"][0]["text"] =
        json!(r#"text with {\"escaped\":\"quote\"}, colon: and \u0065"#);
    assert_eq!(
        receive(&mut initialized(), frame),
        Ok(Some(ClaudeObservation::Progress))
    );
}

#[test]
fn closed_telemetry_before_init_and_after_result_never_changes_evidence() {
    let mut p = parser();
    for n in 1..=2 {
        let v = json!({"type":"command_lifecycle","session_id":SESSION,
            "uuid":format!("00000000-0000-4000-8000-{n:012}")});
        assert_eq!(receive(&mut p, v), Ok(None));
        assert!(!p.initialized);
        assert!(!p.terminal_result_seen());
    }
    receive(&mut p, init(SESSION)).unwrap();
    assert_eq!(
        receive(
            &mut p,
            json!({"type":"rate_limit_event","session_id":SESSION,
        "uuid":"00000000-0000-4000-8000-000000000003"})
        ),
        Ok(None)
    );
    assert_eq!(
        receive(&mut p, result(SESSION, false)),
        Ok(Some(ClaudeObservation::CompletedProposal))
    );
    assert_eq!(
        receive(
            &mut p,
            json!({"type":"command_lifecycle","session_id":SESSION,
        "uuid":"00000000-0000-4000-8000-000000000004"})
        ),
        Ok(None)
    );
    assert!(p.terminal_result_seen());
    assert_eq!(p.finish(KEY), Ok(()));
    assert_eq!(
        receive(&mut p, result(SESSION, false)),
        Err(Blocker::Protocol)
    );
}

#[test]
fn telemetry_foreign_extra_duplicate_and_bound_fail_closed() {
    for mutate in 0..4 {
        let mut p = parser();
        let mut v = json!({"type":"command_lifecycle","session_id":SESSION,
            "uuid":"00000000-0000-4000-8000-000000000001"});
        match mutate {
            0 => v["session_id"] = json!(OTHER),
            1 => v["request"] = json!({"subtype":"permission"}),
            2 => v["uuid"] = json!("invalid"),
            _ => {
                receive(&mut p, v.clone()).unwrap();
            }
        }
        assert!(receive(&mut p, v).is_err());
        assert_quarantined(&mut p);
    }
    let mut p = parser();
    for n in 0..128 {
        receive(
            &mut p,
            json!({"type":"command_lifecycle","session_id":SESSION,
            "uuid":format!("00000000-0000-4000-8000-{n:012}")}),
        )
        .unwrap();
    }
    assert!(receive(
        &mut p,
        json!({"type":"command_lifecycle","session_id":SESSION,
        "uuid":"00000000-0000-4000-8000-000000000128"})
    )
    .is_err());
    assert_quarantined(&mut p);
}
