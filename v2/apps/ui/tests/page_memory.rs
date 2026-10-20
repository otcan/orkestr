use orkestr_v2_ui::{
    beta_inputs::{SavedInput, SavedInputs},
    beta_window::WindowIntents,
    page_memory::{encode, key, restore, BYTES_MAX},
    send_intent::prepare,
    Draft,
};
use serde_json::json;
use std::collections::BTreeMap;

const ID: &str = "00000000-0000-4000-8000-000000000001";
const OTHER: &str = "00000000-0000-4000-8000-000000000002";
fn input(n: u32) -> SavedInput {
    SavedInput {conversation:serde_json::from_value(json!(ID)).unwrap(),input_request_key:format!("input-{n}"),receipt:serde_json::from_value(json!({"message_id":format!("00000000-0000-4000-8000-{n:012}"),"event_id":format!("00000000-0000-4000-8000-{:012}",n+100),"sequence":n,"status":"accepted"})).unwrap()}
}
fn page() -> (BTreeMap<String, Draft>, SavedInputs, WindowIntents) {
    (
        BTreeMap::new(),
        SavedInputs::default(),
        WindowIntents::default(),
    )
}

#[test]
fn reload_recovers_drafts_pending_send_receipt_and_exact_window_request() {
    let (mut drafts, mut saved, mut intents) = page();
    let mut sent = Draft::default();
    sent.edit("Original message".into());
    let pending = sent.prepare("input-3".into()).unwrap();
    sent.edit("Edited after send".into());
    drafts.insert(ID.into(), sent);
    let mut unsent = Draft::default();
    unsent.edit("Half-written thought".into());
    drafts.insert(OTHER.into(), unsent);
    drafts.insert(
        "00000000-0000-4000-8000-000000000003".into(),
        Draft::default(),
    );
    assert!(saved.retain_receipt(input(3)));
    let request = prepare(&input(3), None, "window-key".into()).unwrap();
    intents.prepare(ID, request.clone()).unwrap();

    let raw = encode(&drafts, &saved, &intents).unwrap();
    let (mut d2, mut s2, mut i2) = page();
    assert_eq!(restore(&raw, &mut d2, &mut s2, &mut i2), (2, 1, 1));
    let draft = d2.get(ID).unwrap();
    assert_eq!(draft.text, "Edited after send");
    assert_eq!(
        draft.pending.as_ref().unwrap().input.client_message_id,
        pending.client_message_id
    );
    assert_eq!(
        draft.pending.as_ref().unwrap().input.text,
        "Original message"
    );
    assert_eq!(d2.get(OTHER).unwrap().text, "Half-written thought");
    assert!(s2.request(ID, "input-3").is_some());
    assert_eq!(i2.pending(ID), Some(&request));
    // Admission of the restored send keeps newer edits.
    d2.get_mut(ID).unwrap().accepted();
    assert_eq!(d2.get(ID).unwrap().text, "Edited after send");
}

#[test]
fn unedited_restored_send_clears_after_admission() {
    let (mut drafts, saved, intents) = page();
    let mut sent = Draft::default();
    sent.edit("Same text".into());
    sent.prepare("input-4".into()).unwrap();
    drafts.insert(ID.into(), sent);
    let raw = encode(&drafts, &saved, &intents).unwrap();
    let (mut d2, mut s2, mut i2) = page();
    restore(&raw, &mut d2, &mut s2, &mut i2);
    d2.get_mut(ID).unwrap().accepted();
    assert!(d2.get(ID).unwrap().text.is_empty());
}

#[test]
fn newer_page_memory_wins_and_nothing_to_keep_encodes_none() {
    let (mut drafts, saved, intents) = page();
    assert!(encode(&drafts, &saved, &intents).is_none());
    let mut old = Draft::default();
    old.edit("Stored".into());
    drafts.insert(ID.into(), old);
    let raw = encode(&drafts, &saved, &intents).unwrap();
    let (mut d2, mut s2, mut i2) = page();
    let mut live = Draft::default();
    live.edit("Typed after reload".into());
    d2.insert(ID.into(), live);
    assert_eq!(restore(&raw, &mut d2, &mut s2, &mut i2).0, 0);
    assert_eq!(d2.get(ID).unwrap().text, "Typed after reload");
}

#[test]
fn malformed_foreign_or_invalid_records_are_ignored() {
    let (mut d, mut s, mut i) = page();
    for raw in [
        "not json",
        r#"{"version":2,"drafts":[],"saved":[],"intents":[]}"#,
        r#"{"version":1,"drafts":[],"saved":[],"intents":[],"extra":1}"#,
        r#"{"version":1,"drafts":[{"conversation":"../x","text":"t","pending":null}],"saved":[],"intents":[]}"#,
        r#"{"version":1,"drafts":[{"conversation":"00000000-0000-4000-8000-000000000001","text":"t","pending":{"client_message_id":"","text":"t"}}],"saved":[],"intents":[]}"#,
    ] {
        assert_eq!(restore(raw, &mut d, &mut s, &mut i), (0, 0, 0), "{raw}");
    }
    let mut bad = serde_json::to_value(input(5)).unwrap();
    bad["receipt"]["sequence"] = json!(0);
    let raw = json!({"version":1,"drafts":[],"saved":[bad],"intents":[]}).to_string();
    assert_eq!(restore(&raw, &mut d, &mut s, &mut i), (0, 0, 0));
    assert!(d.is_empty());
}

#[test]
fn keys_are_owner_scoped_and_size_is_bounded() {
    assert_eq!(
        key(ID).as_deref(),
        Some("orkestr.v2.page.00000000-0000-4000-8000-000000000001")
    );
    for bad in [
        "",
        "00000000-0000-0000-0000-000000000000",
        "00000000-0000-4000-8000-00000000000A",
        "x",
    ] {
        assert!(key(bad).is_none(), "{bad}");
    }
    let (mut drafts, saved, intents) = page();
    for n in 0..100 {
        let mut d = Draft::default();
        d.edit("x".repeat(32000));
        drafts.insert(format!("00000000-0000-4000-8000-{n:012}"), d);
    }
    let raw = encode(&drafts, &saved, &intents).unwrap();
    assert!(raw.len() <= BYTES_MAX);
}
