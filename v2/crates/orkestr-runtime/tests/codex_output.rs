//! Synthetic native notifications only: full final output is immutable evidence.
use orkestr_runtime::{
    codex_rpc::TurnStream,
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
        refuse(&mut stream, done());
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
    assert_eq!(texts.last().unwrap().len(), 8192);
    assert!(texts.len() <= 15);
    assert!(texts.iter().map(|text| text.len()).sum::<usize>() < 8192 * 4);
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
    let mut stream = active();
    completed_item(&mut stream, "a", "Commentary only", json!("commentary"));
    refuse(&mut stream, done());
    for key in ["threadId", "turnId"] {
        let mut bad = item("item/started", "a", "", Value::Null);
        bad["params"][key] = json!("foreign");
        refuse(&mut active(), bad);
    }
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
