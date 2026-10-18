use orkestr_v2_contracts::{ConversationEvent, ConversationSnapshot};
use orkestr_v2_ui::{replay_sequence, Projection};
fn snapshot() -> ConversationSnapshot {
    serde_json::from_str(include_str!("../../../fixtures/conversation-snapshot.json")).unwrap()
}
fn metadata() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/fixture-provider-observed.json"
    ))
    .unwrap()
}
#[test]
fn legacy_fixture_roundtrips_unchanged_and_matches_original_sse() {
    let value: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/event.json")).unwrap();
    let event: ConversationEvent = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&event).unwrap(), value);
    let mut view = Projection::default();
    view.page(snapshot()).unwrap();
    assert_eq!(
        replay_sequence(&view, "message_accepted", Some("1"), &event),
        Ok(1)
    );
}
#[test]
fn mixed_journal_gaps_advance_only_from_snapshot_without_fabricating_messages() {
    let mut view = Projection::default();
    view.page(snapshot()).unwrap();
    let mut wire = metadata();
    wire["sequence"] = 9.into();
    let event: ConversationEvent = serde_json::from_value(wire).unwrap();
    assert_eq!(
        replay_sequence(&view, "fixture_provider_observed", Some("9"), &event),
        Ok(9)
    );
    assert_eq!(view.watermark, 1); // validation alone cannot skip messages in the gap
    let mut page = snapshot();
    page.messages[0].sequence = 7;
    page.last_sequence = 9;
    view.page(page).unwrap();
    assert_eq!(view.watermark, 9);
    assert_eq!(view.messages.len(), 2);
    let mut empty = snapshot();
    empty.messages.clear();
    empty.last_sequence = 12;
    view.page(empty).unwrap();
    assert_eq!(view.watermark, 12);
    assert_eq!(view.messages.len(), 2);
}
#[test]
fn wrong_scope_conversation_cursor_name_schema_or_unknown_variant_fail_closed() {
    let mut view = Projection::default();
    view.page(snapshot()).unwrap();
    let event: ConversationEvent = serde_json::from_value(metadata()).unwrap();
    assert!(replay_sequence(&view, "message_accepted", Some("1"), &event).is_err());
    assert!(replay_sequence(&view, "fixture_provider_observed", Some("2"), &event).is_err());
    for (key, value) in [
        (
            "aggregate_id",
            serde_json::json!("00000000-0000-4000-8000-000000000099"),
        ),
        ("scope", serde_json::json!({"kind":"global"})),
    ] {
        let mut wire = metadata();
        wire[key] = value;
        let event = serde_json::from_value(wire).unwrap();
        assert!(replay_sequence(&view, "fixture_provider_observed", Some("1"), &event).is_err());
    }
    let mut wire = metadata();
    wire["schema_version"] = 3.into();
    assert!(serde_json::from_value::<ConversationEvent>(wire).is_err());
    let mut wire = metadata();
    wire["payload_ref_or_safe_payload"]["kind"] = "future_variant".into();
    assert!(serde_json::from_value::<ConversationEvent>(wire).is_err());
    let mut wire = metadata();
    wire["payload_ref_or_safe_payload"]["observation"]
        .as_object_mut()
        .unwrap()
        .remove("synthetic");
    assert!(serde_json::from_value::<ConversationEvent>(wire).is_err());
}

fn production() -> serde_json::Value {
    let mut wire = metadata();
    wire["schema_version"] = 5.into();
    wire["sequence"] = 9.into();
    wire["aggregate_version"] = 9.into();
    wire["payload_ref_or_safe_payload"]["kind"] = "provider_observed".into();
    wire["payload_ref_or_safe_payload"]["observation"] =
        serde_json::json!({"kind":"completed_proposal"});
    wire
}
#[test]
fn production_replay_is_metadata_only_and_completion_is_awaiting_review() {
    let mut view = Projection::default();
    view.page(snapshot()).unwrap();
    let event: ConversationEvent = serde_json::from_value(production()).unwrap();
    assert_eq!(event.sse_name(), "provider_observed");
    assert_eq!(
        replay_sequence(&view, "provider_observed", Some("9"), &event),
        Ok(9)
    );
    assert_eq!(view.watermark, 1);
    assert_eq!(view.messages.len(), 1);
    assert_eq!(
        orkestr_v2_ui::replay_notice(&event),
        "Provider finished; awaiting review."
    );
    assert!(replay_sequence(&view, "fixture_provider_observed", Some("9"), &event).is_err());
    assert!(replay_sequence(&view, "provider_observed", Some("8"), &event).is_err());
}
#[test]
fn malformed_production_schema_metadata_resyncs_and_wrong_scope_is_rejected() {
    for (key, value) in [
        ("schema_version", 4.into()),
        ("aggregate_version", 8.into()),
        ("sequence", 0.into()),
    ] {
        let mut wire = production();
        wire[key] = value;
        let decoded = orkestr_v2_ui::decode_stream(
            serde_json::json!({"status":200,"event":"provider_observed","id":"9","body":wire}),
        );
        assert_eq!(decoded.event, "resync_required");
    }
    for (key, value) in [
        ("run_sequence", 0.into()),
        ("native_session", "must-not-render".into()),
        ("text", "must-not-render".into()),
    ] {
        let mut wire = production();
        wire["payload_ref_or_safe_payload"][key] = value;
        assert!(serde_json::from_value::<ConversationEvent>(wire).is_err());
    }
    let mut wire = production();
    wire["payload_ref_or_safe_payload"]["observation"] = serde_json::json!({"kind":"completed"});
    assert!(serde_json::from_value::<ConversationEvent>(wire).is_err());
    let mut view = Projection::default();
    view.page(snapshot()).unwrap();
    let mut wrong = production();
    wrong["scope"] = serde_json::json!({"kind":"global"});
    let event = serde_json::from_value(wrong).unwrap();
    assert!(replay_sequence(&view, "provider_observed", Some("9"), &event).is_err());
    let mut wrong = production();
    wrong["aggregate_id"] = "00000000-0000-4000-8000-000000000099".into();
    let event = serde_json::from_value(wrong).unwrap();
    assert!(replay_sequence(&view, "provider_observed", Some("9"), &event).is_err());
}

#[test]
fn production_cancellation_and_confirmed_stop_validate_without_control_authority() {
    let mut view = Projection::default();
    view.page(snapshot()).unwrap();
    for (raw, name, schema, notice) in [
        (
            include_str!("../../../fixtures/production-cancellation-requested.json"),
            "cancellation_requested",
            6,
            "Stop requested; confirmation pending.",
        ),
        (
            include_str!("../../../fixtures/production-provider-stopped.json"),
            "provider_stopped",
            7,
            "Cancelled; provider stop confirmed.",
        ),
    ] {
        let wire: serde_json::Value = serde_json::from_str(raw).unwrap();
        let event: ConversationEvent = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(
            replay_sequence(&view, name, Some(&event.sequence().to_string()), &event),
            Ok(event.sequence())
        );
        assert_eq!(orkestr_v2_ui::replay_notice(&event), notice);
        for (key, value) in [
            ("schema_version", serde_json::json!(5)),
            ("sequence", serde_json::json!(0)),
            ("aggregate_version", serde_json::json!(999)),
        ] {
            let mut bad = wire.clone();
            bad[key] = value;
            assert_eq!(
                orkestr_v2_ui::decode_stream(
                    serde_json::json!({"status":200,"event":name,"id":"1","body":bad})
                )
                .event,
                "resync_required"
            );
        }
        for (key, value) in [
            ("run_id", serde_json::json!("bad")),
            ("native_session", serde_json::json!("forbidden")),
            ("text", serde_json::json!("forbidden")),
        ] {
            let mut bad = wire.clone();
            bad["payload_ref_or_safe_payload"][key] = value;
            assert!(serde_json::from_value::<ConversationEvent>(bad).is_err());
        }
        let mut bad = wire.clone();
        bad["scope"] = serde_json::json!({"kind":"global"});
        let event = serde_json::from_value(bad).unwrap();
        assert!(replay_sequence(&view, name, Some("1"), &event).is_err());
        let mut bad = wire.clone();
        if schema == 7 {
            let mut wrong_receipt = wire.clone();
            wrong_receipt["payload_ref_or_safe_payload"]["receipt_state"] = "unknown".into();
            assert!(serde_json::from_value::<ConversationEvent>(wrong_receipt).is_err());
            bad["payload_ref_or_safe_payload"]["run_sequence"] = 0.into();
        } else {
            bad["payload_ref_or_safe_payload"]["outcome"] = "stopped".into();
        }
        assert!(serde_json::from_value::<ConversationEvent>(bad).is_err());
    }
    let mut wire: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/production-cancellation-requested.json"
    ))
    .unwrap();
    wire["payload_ref_or_safe_payload"]["outcome"] = "not_dispatched".into();
    assert_eq!(
        orkestr_v2_ui::replay_notice(&serde_json::from_value(wire).unwrap()),
        "Cancelled before provider delivery."
    );
    assert_eq!(view.watermark, 1);
    assert_eq!(view.messages.len(), 1);
}

#[test]
fn removable_progress_reference_is_schema8_only_and_never_inline_text() {
    let wire: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/provider-observed-progress.json"
    ))
    .unwrap();
    let event: ConversationEvent = serde_json::from_value(wire.clone()).unwrap();
    let mut view = Projection::default();
    view.page(snapshot()).unwrap();
    assert_eq!(
        replay_sequence(&view, "provider_observed", Some("1"), &event),
        Ok(1)
    );
    assert_eq!(
        orkestr_v2_ui::replay_notice(&event),
        "Provider progress available."
    );
    for (key, value) in [
        ("schema_version", serde_json::json!(5)),
        ("aggregate_version", serde_json::json!(2)),
    ] {
        let mut bad = wire.clone();
        bad[key] = value;
        assert!(serde_json::from_value::<ConversationEvent>(bad).is_err());
    }
    for value in [
        serde_json::json!({"kind":"progress_ref","payload_id":"00000000-0000-0000-0000-000000000000"}),
        serde_json::json!({"kind":"progress_ref","payload_id":"bad"}),
        serde_json::json!({"kind":"progress_ref","payload_id":"00000000-0000-0000-0000-000000000008","text":"untrusted"}),
        serde_json::json!({"kind":"completed_proposal"}),
    ] {
        let mut bad = wire.clone();
        bad["payload_ref_or_safe_payload"]["observation"] = value;
        assert_eq!(
            orkestr_v2_ui::decode_stream(
                serde_json::json!({"status":200,"event":"provider_observed","id":"1","body":bad})
            )
            .event,
            "resync_required"
        );
    }
    assert_eq!(view.messages.len(), 1);
    assert_eq!(view.watermark, 1);
}
