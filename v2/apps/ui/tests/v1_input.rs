use orkestr_v2_ui::{
    v1_input::{self, Failed},
    Draft,
};

/// A synthetic, valid client message id.
fn id(n: u8) -> String {
    format!("00000000-0000-4000-8000-0000000000{n:02x}")
}

#[test]
fn a_retry_reuses_the_first_key_and_text() {
    let mut draft = Draft::default();
    draft.edit("Synthetic hello".into());
    let first = v1_input::prepare(&mut draft, id(1)).unwrap();
    assert_eq!(first.client_message_id, id(1));
    // The owner keeps typing while the first send is unconfirmed.
    draft.edit("Synthetic hello, edited".into());
    let retry = v1_input::prepare(&mut draft, id(2)).unwrap();
    assert_eq!(retry.client_message_id, id(1));
    assert_eq!(retry.text, "Synthetic hello");
    // Accepted: the edited text stays for the next message.
    draft.accepted();
    assert_eq!(draft.text, "Synthetic hello, edited");
    let next = v1_input::prepare(&mut draft, id(2)).unwrap();
    assert_eq!(next.client_message_id, id(2));
}

#[test]
fn bounds_and_failures() {
    let mut draft = Draft::default();
    draft.edit("   ".into());
    assert!(v1_input::prepare(&mut draft, id(1)).is_err());
    draft.edit("x".repeat(16 * 1024 + 1));
    assert!(v1_input::prepare(&mut draft, id(1)).is_err());
    assert!(draft.pending.is_none());
    draft.edit("ok".into());
    assert!(v1_input::prepare(&mut draft, "not-a-uuid".into()).is_err());
    assert!(
        draft.pending.is_none(),
        "an invalid request is never retained"
    );
    assert_eq!(v1_input::failed(504), Failed::Retry);
    assert_eq!(v1_input::failed(0), Failed::Retry);
    assert_eq!(v1_input::failed(409), Failed::Refused);
    assert_eq!(v1_input::failed(401), Failed::Expired);
    assert_eq!(v1_input::draft_key("t-1"), "v1:t-1");
    assert_eq!(v1_input::poll_ms(false, 0), 8000);
    assert_eq!(v1_input::poll_ms(true, 0), 2500);
    assert_eq!(v1_input::poll_ms(false, 3), 2500);
}
