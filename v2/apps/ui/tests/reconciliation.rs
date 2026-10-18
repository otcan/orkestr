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

#[test]
fn cancellation_metadata_failure_retry_with_schema1_2_interleaving_stays_unconfirmed() {
    let view = original();
    let before = fingerprint(&view);
    let mut wire: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/fixture-cancellation-requested.json"
    ))
    .unwrap();
    wire["sequence"] = 9.into();
    let event: ConversationEvent = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(
        replay_sequence(&view, "fixture_cancellation_requested", Some("9"), &event),
        Ok(9)
    );
    assert!(orkestr_v2_ui::replay_notice(&event).contains("unconfirmed"));
    for (name, source, sequence) in [
        (
            "message_accepted",
            include_str!("../../../fixtures/event.json"),
            3,
        ),
        (
            "fixture_provider_observed",
            include_str!("../../../fixtures/fixture-provider-observed.json"),
            4,
        ),
        (
            "fixture_cancellation_requested",
            include_str!("../../../fixtures/fixture-cancellation-requested.json"),
            9,
        ),
    ] {
        let mut value: serde_json::Value = serde_json::from_str(source).unwrap();
        value["sequence"] = sequence.into();
        let event: ConversationEvent = serde_json::from_value(value).unwrap();
        assert_eq!(
            replay_sequence(&view, name, Some(&sequence.to_string()), &event),
            Ok(sequence)
        );
    }
    // Message/schema1 at 3, observation/schema2 at 4, cancellation/schema3 at 9.
    let failed = run(
        &view,
        9,
        vec![
            Ok(page(&[3], 9, Some(3))),
            Err("page two unavailable".into()),
        ],
    )
    .0;
    assert!(failed.is_err());
    assert_eq!(fingerprint(&view), before);
    let result = run(
        &view,
        9,
        vec![Ok(page(&[3], 9, Some(3))), Ok(page(&[7], 9, None))],
    )
    .0
    .unwrap();
    assert_eq!(result.watermark, 9);
    assert_eq!(
        result.messages.keys().copied().collect::<Vec<_>>(),
        vec![1, 3, 7]
    );
    let replayed = run(&result, 9, vec![Ok(page(&[], 9, None))]).0.unwrap();
    assert_eq!(fingerprint(&result), fingerprint(&replayed));
    wire["payload_ref_or_safe_payload"]["outcome"] = "not_dispatched".into();
    let event: ConversationEvent = serde_json::from_value(wire).unwrap();
    assert!(orkestr_v2_ui::replay_notice(&event).contains("no provider delivery"));
    assert!(orkestr_v2_ui::replay_notice(&event).contains("Stop remain unavailable"));
}

#[test]
fn cancellation_schema_identity_and_forbidden_fields_fail_closed() {
    let view = original();
    let wire: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/fixture-cancellation-requested.json"
    ))
    .unwrap();
    for (key, value) in [
        ("schema_version", serde_json::json!(2)),
        ("native_id", serde_json::json!("synthetic")),
    ] {
        let mut bad = wire.clone();
        bad[key] = value;
        let frame = orkestr_v2_ui::decode_stream(
            serde_json::json!({"status":200,"event":"fixture_cancellation_requested","id":"1","body":bad}),
        );
        assert_eq!(frame.event, "resync_required");
    }
    let event: ConversationEvent = serde_json::from_value(wire.clone()).unwrap();
    assert!(replay_sequence(&view, "fixture_cancellation_requested", Some("2"), &event).is_err());
    assert!(replay_sequence(&view, "fixture_provider_observed", Some("1"), &event).is_err());
    let mut bad = wire.clone();
    bad["scope"] = serde_json::json!({"kind":"global"});
    assert!(replay_sequence(
        &view,
        "fixture_cancellation_requested",
        Some("1"),
        &serde_json::from_value(bad).unwrap()
    )
    .is_err());
    let mut bad = wire;
    bad["payload_ref_or_safe_payload"]["outcome"] = "stopped".into();
    assert!(serde_json::from_value::<ConversationEvent>(bad).is_err());
    assert_eq!(view.watermark, 1);
}

#[test]
fn confirmed_fixture_stop_mixed_replay_is_atomic_and_retry_applies_once() {
    let view = original();
    let before = fingerprint(&view);
    for (name, source, sequence) in [
        (
            "message_accepted",
            include_str!("../../../fixtures/event.json"),
            3,
        ),
        (
            "fixture_provider_observed",
            include_str!("../../../fixtures/fixture-provider-observed.json"),
            4,
        ),
        (
            "fixture_cancellation_requested",
            include_str!("../../../fixtures/fixture-cancellation-requested.json"),
            8,
        ),
        (
            "fixture_provider_stopped",
            include_str!("../../../fixtures/fixture-provider-stopped.json"),
            9,
        ),
    ] {
        let mut wire: serde_json::Value = serde_json::from_str(source).unwrap();
        wire["sequence"] = sequence.into();
        let event: ConversationEvent = serde_json::from_value(wire).unwrap();
        assert_eq!(
            replay_sequence(&view, name, Some(&sequence.to_string()), &event),
            Ok(sequence)
        );
        if sequence == 9 {
            let notice = orkestr_v2_ui::replay_notice(&event);
            assert!(notice.contains("receipt cancelled"));
            assert!(notice.contains("Ordinary runtime and Stop remain unavailable"));
        }
    }
    let (failed, cursors) = run(
        &view,
        9,
        vec![Ok(page(&[3], 9, Some(3))), Err("second-page outage".into())],
    );
    assert!(failed.is_err());
    assert_eq!(cursors, vec![1, 3]);
    assert_eq!(fingerprint(&view), before);
    // A watermark behind the stop cannot acknowledge it, even after both pages.
    assert!(run(
        &view,
        9,
        vec![Ok(page(&[3], 8, Some(3))), Ok(page(&[7], 8, None))]
    )
    .0
    .is_err());
    assert_eq!(fingerprint(&view), before);
    let committed = run(
        &view,
        9,
        vec![Ok(page(&[3], 9, Some(3))), Ok(page(&[7], 9, None))],
    )
    .0
    .unwrap();
    assert_eq!(committed.watermark, 9);
    assert_eq!(
        committed.messages.keys().copied().collect::<Vec<_>>(),
        vec![1, 3, 7]
    );
    let retry = run(&committed, 9, vec![Ok(page(&[], 9, None))]).0.unwrap();
    assert_eq!(fingerprint(&retry), fingerprint(&committed));
}

#[test]
fn stopped_metadata_rejects_bad_identity_schema_receipt_and_provider_sequence() {
    let view = original();
    let before = fingerprint(&view);
    let wire: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/fixture-provider-stopped.json"
    ))
    .unwrap();
    for (path, value) in [
        (vec!["schema_version"], serde_json::json!(2)),
        (vec!["native_id"], serde_json::json!("synthetic")),
        (
            vec!["payload_ref_or_safe_payload", "run_sequence"],
            serde_json::json!(0),
        ),
        (
            vec!["payload_ref_or_safe_payload", "run_sequence"],
            serde_json::json!(-1),
        ),
        (
            vec!["payload_ref_or_safe_payload", "receipt_state"],
            serde_json::json!("unknown"),
        ),
        (
            vec!["payload_ref_or_safe_payload", "run_id"],
            serde_json::json!("invalid"),
        ),
        (
            vec!["payload_ref_or_safe_payload", "session_id"],
            serde_json::json!("invalid"),
        ),
        (
            vec!["payload_ref_or_safe_payload", "fence"],
            serde_json::json!(1),
        ),
    ] {
        let mut bad = wire.clone();
        let mut slot = &mut bad;
        for key in path {
            slot = &mut slot[key];
        }
        *slot = value;
        let frame = orkestr_v2_ui::decode_stream(
            serde_json::json!({"status":200,"event":"fixture_provider_stopped","id":"1","body":bad}),
        );
        assert_eq!(frame.event, "resync_required");
    }
    let event: ConversationEvent = serde_json::from_value(wire.clone()).unwrap();
    assert!(replay_sequence(&view, "fixture_provider_stopped", Some("2"), &event).is_err());
    assert!(replay_sequence(&view, "fixture_cancellation_requested", Some("1"), &event).is_err());
    for (key, value) in [
        ("scope", serde_json::json!({"kind":"global"})),
        (
            "aggregate_id",
            serde_json::json!("00000000-0000-4000-8000-000000000099"),
        ),
        ("sequence", serde_json::json!(0)),
    ] {
        let mut bad = wire.clone();
        bad[key] = value;
        let event = serde_json::from_value(bad).unwrap();
        assert!(replay_sequence(&view, "fixture_provider_stopped", Some("1"), &event).is_err());
    }
    assert_eq!(fingerprint(&view), before);
}

#[test]
fn production_observation_gap_failure_retry_preserves_cursor_and_owner_text() {
    let view = original();
    let before = fingerprint(&view);
    let mut wire: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/fixture-provider-observed.json"
    ))
    .unwrap();
    wire["schema_version"] = 5.into();
    wire["sequence"] = 9.into();
    wire["aggregate_version"] = 9.into();
    wire["payload_ref_or_safe_payload"]["kind"] = "provider_observed".into();
    wire["payload_ref_or_safe_payload"]["observation"] =
        serde_json::json!({"kind":"completed_proposal"});
    let event = serde_json::from_value(wire).unwrap();
    let required = replay_sequence(&view, "provider_observed", Some("9"), &event).unwrap();
    let (failed, cursors) = run(
        &view,
        required,
        vec![
            Ok(page(&[3], 9, Some(3))),
            Err("synthetic page outage".into()),
        ],
    );
    assert!(failed.is_err());
    assert_eq!(cursors, vec![1, 3]);
    assert_eq!(fingerprint(&view), before);
    let (retry, cursors) = run(
        &view,
        required,
        vec![Ok(page(&[3], 9, Some(3))), Ok(page(&[7], 9, None))],
    );
    let committed = retry.unwrap();
    assert_eq!(cursors, vec![1, 3]);
    assert_eq!(committed.watermark, 9);
    assert_eq!(
        committed.messages.keys().copied().collect::<Vec<_>>(),
        vec![1, 3, 7]
    );
    assert_eq!(committed.messages[&7].text, "owner text 7");
    let (again, _) = run(&committed, required, vec![Ok(page(&[], 9, None))]);
    assert_eq!(fingerprint(&again.unwrap()), fingerprint(&committed));
}

#[test]
fn production_stop_journal_gaps_fail_atomically_and_retry_once() {
    for (raw, name) in [
        (
            include_str!("../../../fixtures/production-cancellation-requested.json"),
            "cancellation_requested",
        ),
        (
            include_str!("../../../fixtures/production-provider-stopped.json"),
            "provider_stopped",
        ),
    ] {
        let view = original();
        let before = fingerprint(&view);
        let mut wire: serde_json::Value = serde_json::from_str(raw).unwrap();
        wire["sequence"] = 11.into();
        wire["aggregate_version"] = 11.into();
        let event = serde_json::from_value(wire).unwrap();
        let required = replay_sequence(&view, name, Some("11"), &event).unwrap();
        let (failed, _) = run(
            &view,
            required,
            vec![Ok(page(&[3], 11, Some(3))), Err("page two failed".into())],
        );
        assert!(failed.is_err());
        assert_eq!(fingerprint(&view), before);
        let (retry, _) = run(
            &view,
            required,
            vec![Ok(page(&[3], 11, Some(3))), Ok(page(&[7], 11, None))],
        );
        let committed = retry.unwrap();
        assert_eq!(committed.watermark, 11);
        assert_eq!(
            committed.messages.keys().copied().collect::<Vec<_>>(),
            vec![1, 3, 7]
        );
        let (again, _) = run(&committed, required, vec![Ok(page(&[], 11, None))]);
        assert_eq!(fingerprint(&again.unwrap()), fingerprint(&committed));
    }
}
