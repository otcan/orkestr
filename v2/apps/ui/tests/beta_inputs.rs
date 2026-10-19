use orkestr_v2_ui::beta_inputs::{SavedInput, SavedInputs};
fn input(n: u32) -> SavedInput {
    let id = format!("00000000-0000-4000-8000-{n:012}");
    SavedInput {
        conversation: serde_json::from_str("\"00000000-0000-4000-8000-000000000999\"").unwrap(),
        input_request_key: format!("input-{n}"),
        receipt: serde_json::from_value(
            serde_json::json!({"message_id":id,"event_id":id,"sequence":n,"status":"accepted"}),
        )
        .unwrap(),
    }
}
#[test]
fn retained_receipts_survive_view_remount_until_explicit_admission() {
    let mut queue = SavedInputs::default();
    let first = input(1);
    let second = input(2);
    let scope = first.conversation.to_string();
    assert!(queue.retain_receipt(first.clone()));
    assert!(queue.retain_receipt(second.clone()));
    assert!(queue.retain_receipt(first.clone()));
    assert_eq!(queue.first(&scope).unwrap().receipt, first.receipt);
    queue.admitted(&first);
    assert_eq!(queue.first(&scope).unwrap().receipt, second.receipt);
    assert!(queue.first("foreign").is_none());
    queue.clear_owner();
    assert!(queue.first(&scope).is_none());
}
#[test]
fn bounded_queue_preserves_old_inputs_and_refuses_changed_retry() {
    let mut queue = SavedInputs::default();
    for n in 1..=128 {
        assert!(queue.retain_receipt(input(n)));
    }
    assert!(queue.is_full());
    assert!(!queue.retain_receipt(input(129)));
    let mut changed = input(1);
    changed.input_request_key = "other".into();
    assert!(!queue.retain_receipt(changed));
    assert_eq!(
        queue
            .first(&input(1).conversation.to_string())
            .unwrap()
            .input_request_key,
        "input-1"
    );
}
