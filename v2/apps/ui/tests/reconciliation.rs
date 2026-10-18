use orkestr_v2_contracts::{ConversationEvent, ConversationSnapshot};
use orkestr_v2_ui::{reconcile, replay_sequence, Projection};
use std::{
    collections::VecDeque,
    future::Future,
    pin::pin,
    task::{Context, Poll, Waker},
};
fn ready<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("deterministic fetch unexpectedly pending"),
    }
}
fn page(sequences: &[i64], watermark: i64, next: Option<i64>) -> ConversationSnapshot {
    let mut page: ConversationSnapshot =
        serde_json::from_str(include_str!("../../../fixtures/conversation-snapshot.json")).unwrap();
    let base = page.messages[0].clone();
    page.messages = sequences
        .iter()
        .map(|sequence| {
            let mut message = base.clone();
            message.sequence = *sequence;
            message.text = format!("owner text {sequence}");
            message
        })
        .collect();
    page.last_sequence = watermark;
    page.next_cursor = next;
    page
}
fn original() -> Projection {
    let mut view = Projection::default();
    view.page(page(&[1], 1, None)).unwrap();
    view
}
fn fingerprint(view: &Projection) -> serde_json::Value {
    serde_json::json!({"cursor":view.watermark,"scope":view.scope,"conversation":view.conversation_id,"messages":view.messages})
}
fn run(
    view: &Projection,
    required: i64,
    pages: Vec<Result<ConversationSnapshot, String>>,
) -> (Result<Projection, String>, Vec<i64>) {
    let id = view.conversation_id.clone().unwrap();
    let mut pages = VecDeque::from(pages);
    let mut cursors = vec![];
    let result = ready(reconcile(&id, view.watermark, view, required, |cursor| {
        cursors.push(cursor);
        std::future::ready(pages.pop_front().expect("unexpected fetch"))
    }));
    (result, cursors)
}
#[test]
fn second_page_failure_is_atomic_and_retry_interleaves_metadata_without_skipping_text() {
    let view = original();
    let before = fingerprint(&view);
    let mut wire: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/fixture-provider-observed.json"
    ))
    .unwrap();
    wire["sequence"] = 9.into();
    let metadata: ConversationEvent = serde_json::from_value(wire).unwrap();
    assert_eq!(
        replay_sequence(&view, "fixture_provider_observed", Some("9"), &metadata),
        Ok(9)
    );
    // Journal: message 1, metadata 2, message 3, metadata 4, message 7, metadata 9.
    let (failed, cursors) = run(
        &view,
        9,
        vec![
            Ok(page(&[3], 9, Some(3))),
            Err("synthetic page two outage".into()),
        ],
    );
    assert!(failed.is_err());
    assert_eq!(cursors, vec![1, 3]);
    assert_eq!(fingerprint(&view), before);
    let (retry, cursors) = run(
        &view,
        9,
        vec![Ok(page(&[3], 9, Some(3))), Ok(page(&[7], 9, None))],
    );
    let committed = retry.unwrap();
    assert_eq!(cursors, vec![1, 3]);
    assert_eq!(committed.watermark, 9);
    assert_eq!(
        committed.messages.keys().copied().collect::<Vec<_>>(),
        vec![1, 3, 7]
    );
    assert_eq!(committed.messages[&3].text, "owner text 3");
    assert_eq!(committed.messages[&7].text, "owner text 7");
    assert_eq!(fingerprint(&view), before);
    let (again, cursors) = run(&committed, 9, vec![Ok(page(&[], 9, None))]);
    assert_eq!(cursors, vec![9]);
    assert_eq!(fingerprint(&again.unwrap()), fingerprint(&committed));
}
#[test]
fn page_two_validation_failure_and_backward_or_nonadvancing_cursors_preserve_original() {
    let view = original();
    let before = fingerprint(&view);
    for pages in [
        vec![Ok(page(&[3], 9, Some(3))), Ok(page(&[7], 8, None))], // watermark regresses across pages
        vec![Ok(page(&[3], 9, Some(3))), Ok(page(&[3], 9, None))], // repeated row
        vec![Ok(page(&[3], 9, Some(3))), Ok(page(&[7], 9, Some(3)))], // nonadvancing next
        vec![Ok(page(&[], 0, None))],                              // backwards initial watermark
        vec![Ok(page(&[], 1, None))], // unchanged watermark cannot acknowledge event 9
        vec![Ok(page(&[3], 9, Some(10)))], // next beyond watermark
    ] {
        assert!(run(&view, 9, pages).0.is_err());
        assert_eq!(fingerprint(&view), before);
    }
}
#[test]
fn later_page_watermark_does_not_skip_unscanned_events_and_bad_scope_is_atomic() {
    let view = original();
    let committed = run(
        &view,
        9,
        vec![Ok(page(&[3], 9, Some(3))), Ok(page(&[7, 11], 12, None))],
    )
    .0
    .unwrap();
    assert_eq!(committed.watermark, 9);
    assert!(committed.messages.contains_key(&11));
    // Subsequent replay can safely replay row 11 from pinned watermark 9.
    let replayed = run(&committed, 12, vec![Ok(page(&[11], 12, None))])
        .0
        .unwrap();
    assert_eq!(replayed.watermark, 12);
    assert_eq!(replayed.messages.len(), 4);
    let mut bad = page(&[7], 9, None);
    bad.scope = orkestr_v2_contracts::Scope::Global;
    assert!(run(&view, 9, vec![Ok(page(&[3], 9, Some(3))), Ok(bad)])
        .0
        .is_err());
    assert_eq!(view.watermark, 1);
}

#[test]
fn malformed_canonical_variant_uses_real_rust_decoder_resync() {
    let mut wire: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/fixture-provider-observed.json"
    ))
    .unwrap();
    wire["schema_version"] = 99.into();
    let frame = orkestr_v2_ui::decode_stream(
        serde_json::json!({"status":200,"event":"fixture_provider_observed","id":"9","body":wire}),
    );
    assert_eq!(frame.event, "resync_required");
    assert!(frame.id.is_none());
    assert!(frame.body.is_none());
}
