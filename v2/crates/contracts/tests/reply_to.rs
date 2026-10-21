use orkestr_v2_contracts::{MessageRequest, ReplyTo};
use serde_json::json;

#[test]
fn a_plain_message_body_is_unchanged_and_a_quoted_one_carries_its_context() {
    let plain: MessageRequest =
        serde_json::from_value(json!({"client_message_id": "k", "text": "t"})).unwrap();
    let (input, reply_to) = plain.into_parts();
    assert_eq!(
        (
            input.client_message_id.as_str(),
            input.text.as_str(),
            reply_to
        ),
        ("k", "t", None)
    );

    let quoted: MessageRequest = serde_json::from_value(json!({"client_message_id": "k", "text": "t",
        "reply_to": {"message_id": "true_c_A", "author": "orkestr", "text": "earlier", "is_own_reply": true}})).unwrap();
    let reply_to = quoted.into_parts().1.unwrap();
    assert!(reply_to.valid() && reply_to.is_own_reply && !reply_to.unavailable);
    assert_eq!(reply_to.text, "earlier");
}

#[test]
fn unknown_fields_and_empty_quotes_are_refused() {
    assert!(serde_json::from_value::<MessageRequest>(
        json!({"client_message_id": "k", "text": "t", "extra": 1})
    )
    .is_err());
    assert!(serde_json::from_value::<MessageRequest>(
        json!({"client_message_id": "k", "text": "t", "reply_to": {"text": "x", "other": 1}})
    )
    .is_err());
    let empty: ReplyTo = serde_json::from_value(json!({})).unwrap();
    assert!(
        !empty.valid(),
        "a quote with no id, text or unavailable mark carries nothing"
    );
    let unavailable: ReplyTo = serde_json::from_value(json!({"unavailable": true})).unwrap();
    assert!(unavailable.valid());
}
