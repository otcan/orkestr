//! A Codex reply over the 32 KiB progress bound is cut, never refused.
//! Synthetic text only: Turkish letters take two UTF-8 bytes, so a reply of
//! 27,382 characters is 32,787 bytes and crosses the bound mid-stream.
use orkestr_runtime::{
    codex_rpc::{TurnStream, CLIPPED_NOTE},
    ports::ProviderEvent,
};
use orkestr_v2_application::runtime::MAX_PROVIDER_PROGRESS_BYTES as MAX;
use serde_json::{json, Value};

/// The synthetic reply's size: 19 bytes over the bound.
const SIZE: usize = MAX + 19;

fn active() -> TurnStream {
    let mut stream = TurnStream::new("thread", 4).unwrap();
    stream
        .receive(&json!({"id":4,"result":{"turn":{"id":"turn","status":"inProgress"}}}).to_string())
        .unwrap();
    stream
}
fn item(method: &str, text: &str) -> Value {
    json!({"method":method,"params":{"threadId":"thread","turnId":"turn",
        "item":{"type":"agentMessage","id":"answer","text":text,"phase":"final_answer"}}})
}
fn delta(text: &str) -> Value {
    json!({"method":"item/agentMessage/delta","params":{"threadId":"thread",
        "turnId":"turn","itemId":"answer","delta":text}})
}
fn done() -> Value {
    json!({"method":"turn/completed","params":{"threadId":"thread",
        "turn":{"id":"turn","status":"completed"}}})
}
fn receive(stream: &mut TurnStream, frame: &Value) -> Vec<ProviderEvent> {
    stream.receive(&frame.to_string()).unwrap();
    std::iter::from_fn(|| stream.next_event()).collect()
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

/// Exactly 32,787 bytes of synthetic Turkish prose; byte 32,768 falls inside
/// a two-byte letter (the broker test builds the same text).
fn turkish_reply() -> String {
    let sentence = "Çalışma planı güncellendi; bütçe, iş paketleri ve ölçütler şöyle sıralandı. ";
    let mut text = String::from(".");
    while text.len() + sentence.len() <= SIZE {
        text.push_str(sentence);
    }
    for letter in sentence.chars() {
        if text.len() + letter.len_utf8() > SIZE {
            break;
        }
        text.push(letter);
    }
    while text.len() < SIZE {
        text.push('.');
    }
    assert_eq!(text.len(), SIZE);
    assert!(text.chars().count() < text.len());
    assert!(!text.is_char_boundary(MAX));
    text
}

/// The longest prefix within `max` bytes on a character boundary, as the
/// broker cuts (`provider-broker/protocol.py` `clip_utf8`).
fn broker_cut(text: &str, max: usize) -> &str {
    let mut end = max.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The broker's completed item for a reply it cut.
fn cut_item(full: &str) -> Value {
    let mut value = item("item/completed", broker_cut(full, MAX));
    value["params"]["item"]["clipped"] = json!(true);
    value
}

fn assert_cut_reply(full: &str, events: &[ProviderEvent]) {
    let replies = progress(events);
    assert_eq!(replies.len(), 1, "one completed reply");
    let reply = replies[0];
    assert!(reply.len() <= MAX);
    assert!(reply.ends_with(CLIPPED_NOTE));
    let kept = reply.strip_suffix(CLIPPED_NOTE).unwrap();
    assert!(full.starts_with(kept));
    assert!(kept.len() > MAX - CLIPPED_NOTE.len() - 4);
    assert!(matches!(
        events.last(),
        Some(ProviderEvent::CompletedProposal { synthetic: false })
    ));
}

#[test]
fn streamed_turkish_reply_over_the_bound_completes_cut_with_the_note() {
    let full = turkish_reply();
    let mut stream = active();
    let mut events = receive(&mut stream, &item("item/started", ""));
    // Deltas split at character boundaries, as the native streams them.
    let chars: Vec<char> = full.chars().collect();
    for chunk in chars.chunks(37) {
        let text: String = chunk.iter().collect();
        events.extend(receive(&mut stream, &delta(&text)));
    }
    events.extend(receive(&mut stream, &cut_item(&full)));
    events.extend(receive(&mut stream, &done()));
    assert_cut_reply(&full, &events);
    assert!(stream.terminal().is_some());
}

#[test]
fn completed_cut_reply_without_deltas_is_delivered_with_the_note() {
    let full = turkish_reply();
    let mut stream = active();
    let mut events = receive(&mut stream, &item("item/started", ""));
    events.extend(receive(&mut stream, &cut_item(&full)));
    events.extend(receive(&mut stream, &done()));
    assert_cut_reply(&full, &events);
}

#[test]
fn reply_within_the_bound_is_unchanged() {
    // Exactly at the bound, streamed in deltas of 8 KiB (the broker's bound).
    let chunk = "ş".repeat(4096);
    let full = chunk.repeat(MAX / chunk.len());
    let mut stream = active();
    let mut events = receive(&mut stream, &item("item/started", ""));
    for _ in 0..MAX / chunk.len() {
        events.extend(receive(&mut stream, &delta(&chunk)));
    }
    events.extend(receive(&mut stream, &item("item/completed", &full)));
    events.extend(receive(&mut stream, &done()));
    assert_eq!(progress(&events), [full.as_str()]);
}

#[test]
fn cut_mark_is_only_true_and_must_match_the_streamed_cut() {
    let full = turkish_reply();
    for mark in [json!(false), json!("true"), json!(1), Value::Null] {
        let mut stream = active();
        receive(&mut stream, &item("item/started", ""));
        let mut frame = cut_item(&full);
        frame["params"]["item"]["clipped"] = mark;
        assert!(stream.receive(&frame.to_string()).is_err());
    }
    // Deltas crossed the bound, but the completed item claims no cut.
    let mut stream = active();
    receive(&mut stream, &item("item/started", ""));
    let chars: Vec<char> = full.chars().collect();
    for chunk in chars.chunks(2048) {
        let text: String = chunk.iter().collect();
        receive(&mut stream, &delta(&text));
    }
    let unmarked = item("item/completed", broker_cut(&full, MAX));
    assert!(stream.receive(&unmarked.to_string()).is_err());
}
