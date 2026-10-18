fn verify_restored_rows(root: &Path, rows: &Rows) {
    let input = request(root);
    let owner: OwnerId = serde_json::from_value(load(root, "owner")).unwrap();
    for (namespace, source, active, kind) in [
        (
            input.original_namespace,
            &input.bundle.original,
            false,
            "original",
        ),
        (
            input.delta_namespace,
            &input.bundle.native_delta,
            true,
            "native_delta",
        ),
    ] {
        let row = rows["history_imports"]
            .iter()
            .find(|r| r["namespace"] == json!(namespace))
            .unwrap();
        assert_eq!(row["owner_id"], json!(owner));
        assert_eq!(row["source_digest"], json!(source.source_digest));
        assert_eq!(
            row["source_conversation_id"],
            json!(source.source_conversation_id)
        );
        assert_eq!(row["source_watermark"], json!(source.source_watermark));
        assert_eq!(row["message_count"], json!(source.messages.len()));
        assert_eq!(row["active"], json!(i64::from(active)));
        assert_eq!(row["revision"], json!(if active { 1 } else { 2 }));
        let message = rows["history_messages"]
            .iter()
            .find(|r| r["namespace"] == json!(namespace))
            .unwrap();
        assert_eq!(message["ordinal"], json!(0));
        assert_eq!(
            message["source_message_id"],
            json!(source.messages[0].message_id)
        );
        assert_eq!(
            message["source_sequence"],
            json!(source.messages[0].sequence)
        );
        assert_eq!(message["actor_kind"], json!(source.messages[0].actor_kind));
        assert_eq!(message["text"], json!(source.messages[0].text));
        let child = rows["history_recovery_children"]
            .iter()
            .find(|r| r["namespace"] == json!(namespace))
            .unwrap();
        assert_eq!(child["owner_id"], json!(owner));
        assert_eq!(child["restore_id"], json!(input.restore_id));
        assert_eq!(child["kind"], json!(kind));
        assert_eq!(child["source_digest"], json!(source.source_digest));
        assert_eq!(child["initial_active"], json!(i64::from(active)));
        assert_eq!(child["initial_revision"], json!(if active { 1 } else { 2 }));
    }
    let outer = &rows["history_recovery_restores"][0];
    assert_eq!(outer["owner_id"], json!(owner));
    assert_eq!(outer["restore_id"], json!(input.restore_id));
    assert_eq!(outer["bundle_digest"], json!(input.bundle.bundle_digest));
    assert_eq!(outer["revision"], json!(1));
    let receipt: Value = serde_json::from_str(outer["initial_receipt"].as_str().unwrap()).unwrap();
    assert_eq!(receipt["restore_id"], json!(input.restore_id));
    assert_eq!(receipt["bundle_digest"], json!(input.bundle.bundle_digest));
    assert_eq!(
        receipt["original"]["namespace"],
        json!(input.original_namespace)
    );
    assert_eq!(
        receipt["native_delta"]["namespace"],
        json!(input.delta_namespace)
    );
}
