//! Synthetic native notifications only: full final output is immutable evidence.
use orkestr_runtime::{
    codex_rpc::{TurnStream, ASYNC_QUESTION_PREFIX},
    ports::{Blocker, ProviderEvent},
};
use serde_json::{json, Value};

fn active() -> TurnStream {
    let mut stream = TurnStream::new("thread", 4).unwrap();
    stream
        .receive(&json!({"id":4,"result":{"turn":{"id":"turn","status":"inProgress"}}}).to_string())
        .unwrap();
    stream
}
fn item(method: &str, id: &str, text: &str, phase: Value) -> Value {
    json!({"method":method,"params":{"threadId":"thread","turnId":"turn",
        "item":{"type":"agentMessage","id":id,"text":text,"phase":phase}}})
}
fn delta(id: Option<&str>, text: &str) -> Value {
    let mut value = json!({"method":"item/agentMessage/delta","params":{
        "threadId":"thread","turnId":"turn","delta":text}});
    if let Some(id) = id {
        value["params"]["itemId"] = json!(id);
    }
    value
}
fn done() -> Value {
    json!({"method":"turn/completed","params":{"threadId":"thread",
        "turn":{"id":"turn","status":"completed"}}})
}
fn receive(stream: &mut TurnStream, frame: Value) -> Vec<ProviderEvent> {
    stream.receive(&frame.to_string()).unwrap();
    std::iter::from_fn(|| stream.next_event()).collect()
}
fn completed_item(
    stream: &mut TurnStream,
    id: &str,
    text: &str,
    phase: Value,
) -> Vec<ProviderEvent> {
    let mut output = receive(stream, item("item/started", id, "", phase.clone()));
    output.extend(receive(stream, delta(Some(id), text)));
    output.extend(receive(stream, item("item/completed", id, text, phase)));
    output
}
fn refuse(stream: &mut TurnStream, frame: Value) {
    assert!(stream.receive(&frame.to_string()).is_err());
    assert_eq!(stream.receive(&done().to_string()), Err(Blocker::Protocol));
    assert!(stream.terminal().is_none());
}

#[test]
fn fragmented_final_answer_is_complete_and_separate_from_commentary() {
    let mut stream = active();
    completed_item(
        &mut stream,
        "comment",
        "Checking the request.",
        json!("commentary"),
    );
    receive(
        &mut stream,
        item("item/started", "answer", "", json!("final_answer")),
    );
    let mut output = Vec::new();
    for fragment in ["First sentence", ". ", "Unicode 🦀 answer", "."] {
        output.extend(receive(&mut stream, delta(Some("answer"), fragment)));
    }
    let final_text = "First sentence. Unicode 🦀 answer.";
    output.extend(receive(
        &mut stream,
        item(
            "item/completed",
            "answer",
            final_text,
            json!("final_answer"),
        ),
    ));
    let mut terminal = done();
    terminal["params"]["turn"]["itemsView"] = json!("summary");
    terminal["params"]["turn"]["items"] = json!([{
        "type":"agentMessage","id":"answer","text":final_text,"phase":"final_answer"}]);
    output.extend(receive(&mut stream, terminal));
    assert_eq!(
        output[output.len() - 2],
        ProviderEvent::Progress(final_text.into())
    );
    assert_eq!(
        output.last(),
        Some(&ProviderEvent::CompletedProposal { synthetic: false })
    );
    stream.finish().unwrap();
}

#[test]
fn final_selection_is_restored_after_other_items_without_combining_them() {
    let mut stream = active();
    completed_item(&mut stream, "partial", "Draft", json!("partial_answer"));
    completed_item(&mut stream, "answer", "The answer.", json!("final_answer"));
    completed_item(
        &mut stream,
        "comment",
        "Finished checking.",
        json!("commentary"),
    );
    assert_eq!(
        receive(&mut stream, done()),
        vec![
            ProviderEvent::Progress("The answer.".into()),
            ProviderEvent::CompletedProposal { synthetic: false }
        ]
    );
}

#[test]
fn legacy_missing_phase_or_item_identity_keeps_full_last_message() {
    for identity in [None, Some("legacy")] {
        let mut stream = active();
        for fragment in ["Whole ", "legacy", "."] {
            receive(&mut stream, delta(identity, fragment));
        }
        assert_eq!(
            receive(&mut stream, done()),
            vec![
                ProviderEvent::Progress("Whole legacy.".into()),
                ProviderEvent::CompletedProposal { synthetic: false }
            ]
        );
    }
    let mut stream = active();
    completed_item(&mut stream, "first", "Earlier message", Value::Null);
    let mut output = completed_item(&mut stream, "last", "Legacy answer.", Value::Null);
    output.extend(receive(&mut stream, done()));
    assert_eq!(
        output.last(),
        Some(&ProviderEvent::CompletedProposal { synthetic: false })
    );
    assert_eq!(
        output[output.len() - 2],
        ProviderEvent::Progress("Legacy answer.".into())
    );
}

#[test]
fn unknown_started_phase_can_become_final_and_completed_only_is_supported() {
    let mut stream = active();
    receive(&mut stream, item("item/started", "answer", "", Value::Null));
    receive(&mut stream, delta(Some("answer"), "Final answer."));
    receive(
        &mut stream,
        item(
            "item/completed",
            "answer",
            "Final answer.",
            json!("final_answer"),
        ),
    );
    assert_eq!(
        receive(&mut stream, done()),
        vec![ProviderEvent::CompletedProposal { synthetic: false }]
    );
    let mut stream = active();
    let mut output = receive(
        &mut stream,
        item(
            "item/completed",
            "answer",
            "Complete without deltas.",
            json!("final_answer"),
        ),
    );
    output.extend(receive(&mut stream, done()));
    assert_eq!(
        output,
        vec![
            ProviderEvent::Progress("Complete without deltas.".into()),
            ProviderEvent::CompletedProposal { synthetic: false }
        ]
    );
}

#[test]
fn unknown_completed_summary_phase_retains_the_known_final_boundary() {
    let mut stream = active();
    receive(
        &mut stream,
        item("item/started", "answer", "", json!("final_answer")),
    );
    receive(&mut stream, delta(Some("answer"), "Declared final."));
    receive(
        &mut stream,
        item("item/completed", "answer", "Declared final.", Value::Null),
    );
    completed_item(
        &mut stream,
        "comment",
        "Later commentary.",
        json!("commentary"),
    );
    let mut terminal = done();
    terminal["params"]["turn"]["itemsView"] = json!("summary");
    terminal["params"]["turn"]["items"] = json!([{
        "type":"agentMessage","id":"answer","text":"Declared final.","phase":null}]);
    assert_eq!(
        receive(&mut stream, terminal),
        vec![
            ProviderEvent::Progress("Declared final.".into()),
            ProviderEvent::CompletedProposal { synthetic: false }
        ]
    );
}

#[test]
fn native_terminal_selection_skips_later_whitespace_only_messages() {
    for phase in [Value::Null, json!("final_answer")] {
        let mut stream = active();
        completed_item(&mut stream, "msg-1", "Complete response.", phase.clone());
        completed_item(&mut stream, "msg-2", " \t\u{2003} ", phase.clone());
        let mut terminal = done();
        terminal["params"]["turn"]["itemsView"] = json!("summary");
        terminal["params"]["turn"]["items"] = json!([{
            "type":"agentMessage","id":"msg-1","text":"Complete response.","phase":phase}]);
        assert_eq!(
            receive(&mut stream, terminal),
            vec![
                ProviderEvent::Progress("Complete response.".into()),
                ProviderEvent::CompletedProposal { synthetic: false }
            ]
        );
    }
    for phase in [Value::Null, json!("final_answer")] {
        let mut stream = active();
        completed_item(&mut stream, "empty", " \t ", phase);
        // Whitespace-only output completes with the explicit no-reply notice.
        let events = receive(&mut stream, done());
        assert!(
            matches!(&events[..], [ProviderEvent::Progress(text), ProviderEvent::CompletedProposal { .. }]
            if text.starts_with("(The turn completed without a reply"))
        );
    }
}

#[test]
fn snapshots_have_linear_storage_bound_even_for_single_byte_deltas() {
    let mut stream = active();
    receive(
        &mut stream,
        item("item/started", "answer", "", json!("final_answer")),
    );
    let mut snapshots = Vec::new();
    for _ in 0..8192 {
        snapshots.extend(receive(&mut stream, delta(Some("answer"), "x")));
    }
    snapshots.extend(receive(
        &mut stream,
        item(
            "item/completed",
            "answer",
            &"x".repeat(8192),
            json!("final_answer"),
        ),
    ));
    snapshots.extend(receive(&mut stream, done()));
    let texts: Vec<_> = snapshots
        .iter()
        .filter_map(|event| match event {
            ProviderEvent::Progress(text) => Some(text),
            _ => None,
        })
        .collect();
    // Deltas are never snapshots: exactly one, the completed full text.
    assert_eq!(texts.len(), 1);
    assert_eq!(texts[0].len(), 8192);
}

#[test]
fn streaming_deltas_are_never_progress_only_completed_items_are() {
    let mut stream = active();
    receive(
        &mut stream,
        item("item/started", "comment", "", json!("commentary")),
    );
    for fragment in ["Two Doc", "uSign mails", " arrived."] {
        assert!(receive(&mut stream, delta(Some("comment"), fragment)).is_empty());
    }
    assert_eq!(
        receive(
            &mut stream,
            item(
                "item/completed",
                "comment",
                "Two DocuSign mails arrived.",
                json!("commentary"),
            ),
        ),
        vec![ProviderEvent::Progress(
            "Two DocuSign mails arrived.".into()
        )]
    );
}

/// otcanClaw-PA 2026-10-29 (run c66a3858): the first response stream started
/// the final answer, sent "Two Doc" and went idle; after its 300 s stream idle
/// timeout Codex retried as a new response whose final answer completed with a
/// new item id. The first item never completed, and the turn was refused
/// although its answer was complete.
#[test]
fn stream_retry_abandons_the_unfinished_item_and_completes_with_the_retry() {
    for view in [None, Some("full"), Some("summary")] {
        let mut stream = active();
        completed_item(&mut stream, "comment", "Checking.", json!("commentary"));
        receive(
            &mut stream,
            item("item/started", "attempt-1", "", json!("final_answer")),
        );
        assert!(receive(&mut stream, delta(Some("attempt-1"), "Two Doc")).is_empty());
        let answer = "Two DocuSign mails arrived today.";
        let output = completed_item(&mut stream, "attempt-2", answer, json!("final_answer"));
        assert_eq!(output, vec![ProviderEvent::Progress(answer.into())]);
        let mut terminal = done();
        if let Some(view) = view {
            terminal["params"]["turn"]["itemsView"] = json!(view);
            terminal["params"]["turn"]["items"] = json!([
                {"type":"agentMessage","id":"comment","text":"Checking.","phase":"commentary"},
                {"type":"agentMessage","id":"attempt-2","text":answer,"phase":"final_answer"}]);
        }
        // The answer was already the latest snapshot: completion only.
        assert_eq!(
            receive(&mut stream, terminal),
            vec![ProviderEvent::CompletedProposal { synthetic: false }]
        );
        stream.finish().unwrap();
    }
    // An abandoned phase-less attempt is never selected as the reply.
    let mut stream = active();
    receive(
        &mut stream,
        item("item/started", "attempt-1", "", Value::Null),
    );
    receive(&mut stream, delta(Some("attempt-1"), "Half a sen"));
    completed_item(
        &mut stream,
        "attempt-2",
        "Checked the inbox.",
        json!("commentary"),
    );
    let events = receive(&mut stream, done());
    let ProviderEvent::Progress(text) = &events[0] else {
        panic!("reply expected")
    };
    assert!(text.ends_with("Checked the inbox.") && !text.contains("Half a sen"));
}

#[test]
fn an_item_still_open_at_the_end_of_the_turn_is_refused() {
    // After a completed final answer, a later message that never completed
    // is missing evidence, not an abandoned retry.
    let mut stream = active();
    completed_item(&mut stream, "answer", "The answer.", json!("final_answer"));
    receive(
        &mut stream,
        item("item/started", "late", "", json!("commentary")),
    );
    receive(&mut stream, delta(Some("late"), "unfinished"));
    refuse(&mut stream, done());
    // A full terminal view must still list every completed item.
    let mut stream = active();
    receive(
        &mut stream,
        item("item/started", "attempt-1", "", json!("final_answer")),
    );
    receive(&mut stream, delta(Some("attempt-1"), "Two Doc"));
    completed_item(&mut stream, "attempt-2", "Answer.", json!("final_answer"));
    let mut terminal = done();
    terminal["params"]["turn"]["itemsView"] = json!("full");
    terminal["params"]["turn"]["items"] = json!([]);
    refuse(&mut stream, terminal);
}

#[test]
fn completed_item_and_terminal_summary_must_agree_with_deltas() {
    let mut stream = active();
    receive(
        &mut stream,
        item("item/started", "answer", "", json!("final_answer")),
    );
    receive(&mut stream, delta(Some("answer"), "Actual answer."));
    refuse(
        &mut stream,
        item(
            "item/completed",
            "answer",
            "Different answer.",
            json!("final_answer"),
        ),
    );
    for mutation in 0..4 {
        let mut stream = active();
        completed_item(
            &mut stream,
            "answer",
            "Actual answer.",
            json!("final_answer"),
        );
        let mut terminal = done();
        let mut summary = item(
            "item/completed",
            "answer",
            "Actual answer.",
            json!("final_answer"),
        )["params"]["item"]
            .clone();
        match mutation {
            0 => summary["text"] = json!("Wrong"),
            1 => summary["id"] = json!("foreign"),
            2 => summary["phase"] = json!("commentary"),
            _ => {}
        }
        terminal["params"]["turn"]["items"] = if mutation == 3 {
            json!([summary.clone(), summary])
        } else {
            json!([summary])
        };
        terminal["params"]["turn"]["itemsView"] = json!("summary");
        refuse(&mut stream, terminal);
    }
    for (items, view) in [(json!([false]), json!("summary")), (json!([]), Value::Null)] {
        let mut terminal = done();
        terminal["params"]["turn"]["items"] = items;
        terminal["params"]["turn"]["itemsView"] = view;
        refuse(&mut active(), terminal);
    }
}

#[test]
fn invalid_phase_identity_replay_and_ambiguous_final_refuse() {
    for bad in [
        item("item/started", "a", "", json!("analysis")),
        item("item/started", "", "", Value::Null),
        delta(Some(""), "x"),
        delta(None, ""),
    ] {
        refuse(&mut active(), bad);
    }
    let mut stream = active();
    completed_item(&mut stream, "a", "First", json!("final_answer"));
    refuse(
        &mut stream,
        item("item/completed", "a", "First", json!("final_answer")),
    );
    let mut stream = active();
    completed_item(&mut stream, "a", "First", json!("final_answer"));
    receive(
        &mut stream,
        item("item/started", "b", "", json!("final_answer")),
    );
    refuse(
        &mut stream,
        item("item/completed", "b", "Second", json!("final_answer")),
    );
}

#[test]
fn missing_item_completion_commentary_only_and_cross_scope_refuse() {
    let mut stream = active();
    receive(
        &mut stream,
        item("item/started", "a", "", json!("final_answer")),
    );
    receive(&mut stream, delta(Some("a"), "unfinished"));
    refuse(&mut stream, done());
    for key in ["threadId", "turnId"] {
        let mut bad = item("item/started", "a", "", Value::Null);
        bad["params"][key] = json!("foreign");
        refuse(&mut active(), bad);
    }
}

#[test]
fn commentary_only_or_textless_completion_replies_instead_of_failing() {
    let mut stream = active();
    completed_item(&mut stream, "a", "Checked the inbox.", json!("commentary"));
    completed_item(
        &mut stream,
        "b",
        "Collected the evidence.",
        json!("commentary"),
    );
    let events = receive(&mut stream, done());
    assert_eq!(
        events.last(),
        Some(&ProviderEvent::CompletedProposal { synthetic: false })
    );
    let ProviderEvent::Progress(text) = &events[0] else {
        panic!("reply expected")
    };
    assert!(
        text.starts_with("(Ended without a final answer")
            && text.ends_with("Collected the evidence.")
    );
    let mut stream = active();
    let events = receive(&mut stream, done());
    assert!(
        matches!(&events[..], [ProviderEvent::Progress(text), ProviderEvent::CompletedProposal { .. }]
        if text.starts_with("(The turn completed without a reply"))
    );
}

#[test]
fn text_bytes_and_number_of_items_remain_bounded() {
    let mut stream = active();
    receive(&mut stream, delta(None, &"🦀".repeat(2048)));
    refuse(&mut stream, delta(None, "x"));
    let mut stream = active();
    for index in 0..128 {
        receive(&mut stream, delta(Some(&format!("item-{index}")), "x"));
    }
    refuse(&mut stream, delta(Some("item-129"), "x"));
}

/// `request_user_input_async` as Codex 0.163 reports it: a completed agent
/// message with `phase: final_answer` and `delivery: async`.
fn question(id: &str, text: &str) -> Value {
    let mut value = item("item/completed", id, text, json!("final_answer"));
    value["params"]["item"]["delivery"] = json!("async");
    value["params"]["item"]["questions"] = json!([{"title": text}]);
    value
}
fn progress(events: &[ProviderEvent]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|event| match event {
            ProviderEvent::Progress(text) => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[test]
fn async_question_then_final_is_one_final_with_the_question_delivered_first() {
    // PA gen 20: a question at 05:55, the real final five minutes later.
    let mut stream = active();
    completed_item(
        &mut stream,
        "c",
        "Reading the booking.",
        json!("commentary"),
    );
    let asked = receive(
        &mut stream,
        question("call_q", "Which flight did you take?"),
    );
    assert_eq!(
        progress(&asked),
        vec![format!("{ASYNC_QUESTION_PREFIX}Which flight did you take?").as_str()]
    );
    completed_item(
        &mut stream,
        "c2",
        "Drafting the complaint.",
        json!("commentary"),
    );
    completed_item(
        &mut stream,
        "answer",
        "The complaint is drafted.",
        json!("final_answer"),
    );
    let mut terminal = done();
    terminal["params"]["turn"]["itemsView"] = json!("summary");
    terminal["params"]["turn"]["items"] = json!([{"type":"agentMessage","id":"call_q",
        "text":"Which flight did you take?","phase":"final_answer","delivery":"async"}]);
    let events = receive(&mut stream, terminal);
    let ProviderEvent::Progress(reply) = &events[0] else {
        panic!("final payload expected")
    };
    assert!(reply.starts_with("The complaint is drafted."));
    assert!(reply.ends_with("1. Which flight did you take?"));
    assert_eq!(
        events.last(),
        Some(&ProviderEvent::CompletedProposal { synthetic: false })
    );
    stream.finish().unwrap();
}

#[test]
fn two_async_questions_never_count_as_two_finals() {
    // PA gen 22: two questions two minutes apart, refused before this fix.
    let mut stream = active();
    receive(
        &mut stream,
        question("q1", "Where is the German passport scan?"),
    );
    let second = receive(&mut stream, question("q2", "Did you show both passports?"));
    assert_eq!(
        progress(&second),
        vec![format!("{ASYNC_QUESTION_PREFIX}Did you show both passports?").as_str()]
    );
    // A final that already repeats a question does not repeat it again.
    completed_item(
        &mut stream,
        "answer",
        "Draft ready. Did you show both passports?",
        json!("final_answer"),
    );
    let events = receive(&mut stream, done());
    let ProviderEvent::Progress(reply) = &events[0] else {
        panic!("final payload expected")
    };
    assert!(reply.starts_with("Draft ready. Did you show both passports?"));
    assert!(reply.contains("1. Where is the German passport scan?"));
    assert!(!reply.contains("2."));
    stream.finish().unwrap();
}

#[test]
fn async_question_with_item_lifecycle_and_questions_only_turn_reply_with_the_questions() {
    let mut stream = active();
    let mut started = item("item/started", "q", "", json!("final_answer"));
    started["params"]["item"]["delivery"] = json!("async");
    assert!(receive(&mut stream, started).is_empty());
    assert!(receive(&mut stream, delta(Some("q"), "Which period?")).is_empty());
    let asked = receive(&mut stream, question("q", "Which period?"));
    assert_eq!(progress(&asked).len(), 1);
    let events = receive(&mut stream, done());
    let ProviderEvent::Progress(reply) = &events[0] else {
        panic!("reply expected")
    };
    assert!(!reply.starts_with("(Ended without a final answer"));
    assert!(reply.ends_with("1. Which period?"));
}

#[test]
fn async_delivery_cannot_change_or_be_unknown() {
    let mut bad = question("q", "Which?");
    bad["params"]["item"]["delivery"] = json!("later");
    refuse(&mut active(), bad);
    // An item started as a plain final cannot complete as a question.
    let mut stream = active();
    receive(
        &mut stream,
        item("item/started", "a", "", json!("final_answer")),
    );
    refuse(&mut stream, question("a", "Which?"));
    // Two real finals are still refused.
    let mut stream = active();
    receive(&mut stream, question("q", "Which?"));
    completed_item(&mut stream, "a", "First", json!("final_answer"));
    receive(
        &mut stream,
        item("item/started", "b", "", json!("final_answer")),
    );
    refuse(
        &mut stream,
        item("item/completed", "b", "Second", json!("final_answer")),
    );
}
