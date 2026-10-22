use orkestr_v2_contracts::AcceptedResult;
use orkestr_v2_ui::chat_timeline::{merge_replies, ordered, Input, Row};
use serde_json::json;
use std::collections::BTreeMap;

fn reply(sequence: i64) -> AcceptedResult {
    serde_json::from_value(json!({"run_id":"00000000-0000-4000-8000-000000000001", "completion_event_id":"00000000-0000-4000-8000-000000000002", "acceptance_event_id":"00000000-0000-4000-8000-000000000003", "acceptance_sequence":sequence,"payload_id":"00000000-0000-4000-8000-000000000004","payload_removed":false})).unwrap()
}
fn input(sequence: i64) -> Input {
    Input {
        id: "synthetic-message".into(),
        sequence,
        actor: "owner".into(),
        text: "Question".into(),
        reply_to: None,
    }
}
#[test]
fn transcript_interleaves_input_and_accepted_reply_by_canonical_event_order() {
    let rows = ordered(&[input(9), input(1)], &[reply(5)], &[]).unwrap();
    assert_eq!(
        rows.iter().map(Row::sequence).collect::<Vec<_>>(),
        [1, 5, 9]
    );
    assert!(matches!(rows[1], Row::Reply(_)));
    assert_ne!(rows[0].key(), rows[1].key());
}
#[test]
fn conflicting_and_noncanonical_order_is_not_presented_as_chat() {
    assert!(ordered(&[input(5)], &[reply(5)], &[]).is_err());
    assert!(ordered(&[input(0)], &[], &[]).is_err());
}
#[test]
fn accepted_identity_cannot_be_replaced_and_removal_is_sticky() {
    let original = reply(5);
    let mut rows = BTreeMap::new();
    merge_replies(&mut rows, std::slice::from_ref(&original)).unwrap();
    let mut removed = original.clone();
    removed.payload_removed = true;
    merge_replies(&mut rows, &[removed]).unwrap();
    merge_replies(&mut rows, std::slice::from_ref(&original)).unwrap();
    assert!(rows[&5].payload_removed);
    let mut changed = original;
    changed.payload_id = None;
    assert!(merge_replies(&mut rows, &[changed]).is_err());
    assert!(rows[&5].payload_id.is_some());
}

#[test]
fn a_quoted_reply_shows_as_a_bubble_without_the_duplicate_relay_line() {
    use orkestr_v2_contracts::{Message, ReplyTo};
    let quote = ReplyTo {
        message_id: Some("true_chat_ABC".into()),
        author: Some("orkestr".into()),
        sent_at: None,
        text: "Should I look into it?".into(),
        is_own_reply: true,
        unavailable: false,
    };
    let message = Message {
        message_id: serde_json::from_value(json!("00000000-0000-4000-8000-000000000002")).unwrap(),
        sequence: 1,
        actor_kind: "owner".into(),
        text: "[WhatsApp: Group]\n\n[Replying to Orkestr message from 21:50: \"Should I look…\"]\n\nno need".into(),
        reply_to: Some(quote.clone()),
        origin: None,
    };
    let input = Input::from(&message);
    assert_eq!(input.text, "[WhatsApp: Group]\n\nno need");
    assert_eq!(input.reply_to, Some(quote));
    assert_eq!(
        orkestr_v2_ui::chat_timeline::quote_label(input.reply_to.as_ref().unwrap()),
        "Replying to Orkestr"
    );
    let plain = Message {
        reply_to: None,
        ..message
    };
    assert!(
        Input::from(&plain).text.contains("[Replying to"),
        "no quote means the text is shown unchanged"
    );
    let gone = ReplyTo {
        unavailable: true,
        text: String::new(),
        message_id: None,
        is_own_reply: false,
        ..input.reply_to.unwrap()
    };
    assert_eq!(
        orkestr_v2_ui::chat_timeline::quote_label(&gone),
        "Replying to an unavailable message"
    );
}

fn post(after_sequence: i64, created_ms: i64, n: u8) -> orkestr_v2_contracts::ConversationPost {
    serde_json::from_value(
        json!({"id": format!("00000000-0000-4000-8000-0000000000{n:02}"),
        "conversation_id": "00000000-0000-4000-8000-0000000000aa", "request_key": format!("k{n}"),
        "author": "coordinator", "label": "Coordinator", "provider": null, "model": null,
        "text": "Deploy finished.", "after_sequence": after_sequence, "created_ms": created_ms,
        "delivered_ms": null}),
    )
    .unwrap()
}

#[test]
fn posts_follow_their_event_and_are_ordered_by_creation_time() {
    // Two posts after the reply at 5 (given out of order), one after the input at 9.
    let rows = ordered(
        &[input(9), input(1)],
        &[reply(5)],
        &[post(5, 30, 2), post(9, 40, 3), post(5, 20, 1)],
    )
    .unwrap();
    let keys: Vec<_> = rows
        .iter()
        .map(|row| match row {
            Row::Input(i) => format!("i{}", i.sequence),
            Row::Reply(r) => format!("r{}", r.acceptance_sequence),
            Row::Post(p) => p.request_key.clone(),
        })
        .collect();
    assert_eq!(keys, ["i1", "r5", "k1", "k2", "i9", "k3"]);
    // A post written before anything happened leads an empty or full history.
    let rows = ordered(&[input(1)], &[], &[post(0, 10, 4)]).unwrap();
    assert!(matches!(rows[0], Row::Post(_)));
    assert_eq!(ordered(&[], &[], &[post(0, 10, 4)]).unwrap().len(), 1);
    // Posts older than the row before the oldest one on screen are left out.
    let rows = ordered(&[input(50)], &[], &[post(10, 10, 5), post(49, 11, 6)]).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].key(), "post-00000000-0000-4000-8000-000000000006");
    // Event order conflicts are still refused with posts present.
    assert!(ordered(&[input(5)], &[reply(5)], &[post(5, 1, 7)]).is_err());
}

#[test]
fn the_adapter_chat_rules_line_is_hidden_from_the_owner_bubble() {
    use orkestr_v2_contracts::Message;
    use orkestr_v2_ui::chat_timeline::without_rules_line;
    let rules = "[Chat rules v0123456789ab: before answering, read /srv/chat/CHAT.md (cat it) unless you already read this version in this session, and follow it.]";
    let message = Message {
        message_id: serde_json::from_value(json!("00000000-0000-4000-8000-000000000002")).unwrap(),
        sequence: 1,
        actor_kind: "owner".into(),
        text: format!("{rules}\n\n[WhatsApp: Group]\n\nhello"),
        reply_to: None,
        origin: None,
    };
    assert_eq!(Input::from(&message).text, "[WhatsApp: Group]\n\nhello");
    assert_eq!(
        without_rules_line("[Chat rules are fun]"),
        "[Chat rules are fun]"
    );
    assert_eq!(
        without_rules_line("hello\n\n[Chat rules v1: x]"),
        "hello\n\n[Chat rules v1: x]"
    );
}

mod web_replies {
    use orkestr_v2_ui::chat_timeline::{
        clip, quote, quote_label, reply_line, split_reply_line, with_reply_line,
        without_reply_line, QuoteAuthor,
    };

    #[test]
    fn a_web_reply_reads_like_a_whatsapp_reply_and_is_a_valid_quote() {
        let own = quote(
            "run-1",
            QuoteAuthor::Assistant,
            "Should I look into\n\nthe report next?",
        );
        assert!(own.valid() && own.is_own_reply);
        assert_eq!(own.text, "Should I look into the report next?");
        assert_eq!(
            reply_line(&own),
            "[Replying to Orkestr message: \"Should I look into the report next?\"]"
        );
        assert_eq!(quote_label(&own), "Replying to Orkestr");
        let mine = quote("m-1", QuoteAuthor::Owner, "my note");
        assert_eq!(reply_line(&mine), "[Replying to your message: \"my note\"]");
        assert_eq!(quote_label(&mine), "Replying to you");
        let other = quote("m-2", QuoteAuthor::Other, "member note");
        assert_eq!(quote_label(&other), "Replying to an earlier message");
        let text = with_reply_line("no need", &own);
        assert_eq!(
            text,
            "[Replying to Orkestr message: \"Should I look into the report next?\"]\n\nno need"
        );
        assert_eq!(without_reply_line(&text), "no need");
    }

    #[test]
    fn long_quotes_are_bounded_by_characters_not_bytes() {
        let long = "ü".repeat(900);
        let q = quote(&"x".repeat(400), QuoteAuthor::Owner, &long);
        assert!(q.valid(), "within the stored quote bounds");
        assert_eq!(q.text.chars().count(), 500);
        assert!(q.text.ends_with('\u{2026}'));
        assert_eq!(q.message_id.as_ref().unwrap().len(), 300);
        assert_eq!(clip(&long, 80).chars().count(), 80);
        assert_eq!(clip("  a \n b  ", 80), "a b");
    }

    #[test]
    fn a_reply_line_in_v1_history_becomes_a_quote() {
        let (label, snippet, rest) = split_reply_line(
            "[Replying to Orkestr message from 21:50: \"x y\"]\n\nno need\n\nmore",
        )
        .unwrap();
        assert_eq!(
            (label.as_str(), snippet.as_str(), rest.as_str()),
            ("Replying to Orkestr", "x y", "no need\n\nmore")
        );
        let (label, snippet, _) =
            split_reply_line("[Replying to an unavailable message]\n\nok").unwrap();
        assert_eq!(
            (label.as_str(), snippet.as_str()),
            ("Replying to an unavailable message", "")
        );
        assert_eq!(
            split_reply_line("[Replying to your message: \"a\"]\n\nb")
                .unwrap()
                .0,
            "Replying to you"
        );
        assert!(split_reply_line("plain text").is_none());
        assert!(split_reply_line("[Replying to x: \"y\"] without blank line").is_none());
        assert!(split_reply_line("[Note]\n\ntext").is_none());
    }
}
