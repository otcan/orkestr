use orkestr_v2_contracts::{ExecutionWindowRequest, Receipt};
use orkestr_v2_ui::outbox::{
    backoff_ms, intake_outcome, Item, Outbox, Outcome, Phase, Target, LIMIT, SENT_RETAIN_MS,
    WINDOW_REFUSALS_MAX,
};
use serde_json::json;

const A: &str = "00000000-0000-4000-8000-00000000000a";
const B: &str = "00000000-0000-4000-8000-00000000000b";

fn native(id: &str) -> Target {
    Target::Native(id.into())
}
fn key(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}
/// Reserve and activate one item, as a Send gesture does.
fn send(outbox: &mut Outbox, target: Target, text: &str, n: u32, now: f64) -> String {
    let local = format!("local-{n}");
    assert!(outbox.enqueue(Item::new(local.clone(), target, text.into(), None, vec![]).unwrap()));
    assert!(outbox.activate(&local, key(n), now));
    key(n)
}
fn receipt(n: u32) -> Receipt {
    serde_json::from_value(json!({"message_id": key(1000 + n), "event_id": key(2000 + n), "sequence": n, "status": "accepted"})).unwrap()
}
fn request(n: u32) -> ExecutionWindowRequest {
    serde_json::from_value(json!({"request_key": key(3000 + n), "input_message_id": key(1000 + n), "input_event_id": key(2000 + n),
        "input_request_key": key(n), "expected_generation": 0, "window_id": null, "predecessor_window_id": null})).unwrap()
}
fn sent() -> Outcome {
    Outcome::Sent {
        message_id: None,
        notice: "Sent.".into(),
    }
}

#[test]
fn empty_or_oversized_text_is_not_enqueued() {
    assert!(Item::new("l".into(), native(A), "  ".into(), None, vec![]).is_err());
    assert!(Item::new("l".into(), native(A), "x".repeat(32769), None, vec![]).is_err());
    assert!(Item::new(
        "l".into(),
        Target::V1("t".into()),
        "x".repeat(16385),
        None,
        vec![]
    )
    .is_err());
    assert!(Item::new("l".into(), native(A), "x".repeat(32768), None, vec![]).is_ok());
}

#[test]
fn several_sends_queue_in_order_and_one_chat_never_blocks_another() {
    let mut outbox = Outbox::default();
    let first = send(&mut outbox, native(A), "one", 1, 10.0);
    let second = send(&mut outbox, native(A), "two", 2, 11.0);
    let other = send(&mut outbox, native(B), "elsewhere", 3, 12.0);
    assert_eq!(outbox.head(&native(A), 20.0).unwrap().key, first);
    assert_eq!(outbox.head(&native(B), 20.0).unwrap().key, other);
    assert_eq!(outbox.due_targets(20.0), vec![native(A), native(B)]);
    // A transient failure of the head holds the rest of its chat back (order).
    outbox.apply(&first, Outcome::Transient("offline".into()), 20.0);
    assert!(outbox.head(&native(A), 20.5).is_none());
    assert_eq!(outbox.get(&first).unwrap().phase, Phase::Failed);
    assert!(outbox.get(&first).unwrap().retrying);
    assert_eq!(outbox.head(&native(A), 1020.0).unwrap().key, first);
    outbox.apply(&first, sent(), 22.0);
    assert_eq!(outbox.head(&native(A), 22.0).unwrap().key, second);
}

#[test]
fn a_reserved_item_holds_its_place_until_it_has_a_key() {
    let mut outbox = Outbox::default();
    outbox.enqueue(Item::new("local-1".into(), native(A), "first".into(), None, vec![]).unwrap());
    let second = send(&mut outbox, native(A), "second", 2, 5.0);
    assert!(
        outbox.head(&native(A), 5.0).is_none(),
        "the reserved first item blocks"
    );
    assert!(
        outbox.persistable().iter().all(|(k, _)| k == &second),
        "only keyed items persist"
    );
    assert!(outbox.activate("local-1", key(1), 6.0));
    assert_eq!(outbox.head(&native(A), 6.0).unwrap().text, "first");
    // A key can never be reused by another item.
    outbox.enqueue(Item::new("local-3".into(), native(A), "third".into(), None, vec![]).unwrap());
    assert!(!outbox.activate("local-3", key(1), 7.0));
    assert_eq!(outbox.abandon("local-3").unwrap().text, "third");
}

#[test]
fn retries_keep_the_key_and_the_frozen_work_request() {
    let mut outbox = Outbox::default();
    let k = send(&mut outbox, native(A), "hello", 1, 0.0);
    outbox.apply(&k, Outcome::Saved(receipt(1)), 1.0);
    outbox.apply(&k, Outcome::Prepared(request(1)), 2.0);
    outbox.apply(&k, Outcome::Transient("503".into()), 3.0);
    let item = outbox.get(&k).unwrap();
    assert_eq!(item.window.as_ref().unwrap().request_key, key(3001));
    assert_eq!(item.message_id.as_deref(), Some(key(1001).as_str()));
    // A manual Retry of a transient failure keeps both the key and the request.
    assert!(outbox.retry(&k, Some(key(99)), 4.0));
    let item = outbox.get(&k).unwrap();
    assert_eq!(
        (item.key.as_str(), item.phase),
        (k.as_str(), Phase::Sending)
    );
    assert!(item.window.is_some());
}

#[test]
fn backoff_grows_and_caps() {
    assert_eq!(
        (1..=9).map(backoff_ms).collect::<Vec<_>>(),
        [1000.0, 2000.0, 4000.0, 8000.0, 16000.0, 32000.0, 60000.0, 60000.0, 60000.0]
    );
    let mut outbox = Outbox::default();
    let k = send(&mut outbox, native(A), "x", 1, 0.0);
    outbox.apply(&k, Outcome::Transient("a".into()), 0.0);
    outbox.apply(&k, Outcome::Transient("b".into()), 1000.0);
    assert_eq!(outbox.get(&k).unwrap().next_at_ms, 3000.0);
    assert_eq!(outbox.next_due_in(1500.0), Some(1500.0));
    // Reconnect or a visible tab retries at once.
    outbox.wake(1600.0);
    assert!(outbox.head(&native(A), 1600.0).is_some());
}

#[test]
fn stale_work_tuples_are_replaced_a_few_times_then_need_the_owner() {
    let mut outbox = Outbox::default();
    let k = send(&mut outbox, native(A), "x", 1, 0.0);
    outbox.apply(&k, Outcome::Saved(receipt(1)), 0.0);
    for _ in 1..WINDOW_REFUSALS_MAX {
        outbox.apply(&k, Outcome::Prepared(request(1)), 0.0);
        outbox.apply(&k, Outcome::WindowConflict, 0.0);
        assert_eq!(outbox.get(&k).unwrap().phase, Phase::Sending);
        assert!(outbox.get(&k).unwrap().window.is_none());
    }
    outbox.apply(&k, Outcome::WindowConflict, 0.0);
    let item = outbox.get(&k).unwrap();
    assert_eq!((item.phase, item.retrying), (Phase::Failed, false));
    // A refused item does not block later messages of the same chat.
    let next = send(&mut outbox, native(A), "y", 2, 1.0);
    assert_eq!(outbox.head(&native(A), 1.0).unwrap().key, next);
    // Retry starts over with a fresh tuple but keeps the saved message's key.
    assert!(outbox.retry(&k, Some(key(50)), 2.0));
    assert_eq!(outbox.get(&k).unwrap().window_refusals, 0);
    assert_eq!(outbox.head(&native(A), 2.0).unwrap().key, k);
}

#[test]
fn definite_refusals_wait_for_the_owner_and_a_key_conflict_gets_a_new_key() {
    assert!(matches!(
        intake_outcome(422, "Too long."),
        Outcome::Refused(_)
    ));
    assert!(matches!(
        intake_outcome(409, "Conflict."),
        Outcome::KeyConflict(_)
    ));
    for status in [0, 429, 500, 502, 503, 504] {
        assert!(
            matches!(intake_outcome(status, ""), Outcome::Transient(_)),
            "{status}"
        );
    }
    let mut outbox = Outbox::default();
    let k = send(&mut outbox, native(A), "x", 1, 0.0);
    outbox.apply(&k, intake_outcome(409, "Conflict."), 0.0);
    assert!(outbox.head(&native(A), 100.0).is_none());
    assert!(outbox.retry(&k, Some(key(77)), 1.0));
    assert_eq!(outbox.head(&native(A), 1.0).unwrap().key, key(77));
    assert!(outbox.discard(&key(77)));
    assert!(outbox.items().is_empty());
}

#[test]
fn unsent_items_survive_a_reload_in_order() {
    let mut outbox = Outbox::default();
    let a = send(&mut outbox, native(A), "first", 1, 100.0);
    let b = send(&mut outbox, native(A), "second", 2, 200.0);
    let c = send(&mut outbox, native(B), "done", 3, 300.0);
    outbox.apply(&a, Outcome::Saved(receipt(1)), 150.0);
    outbox.apply(&c, sent(), 310.0);
    let mut stored: Vec<String> = outbox.persistable().into_iter().map(|(_, v)| v).collect();
    assert_eq!(stored.len(), 2, "sent items are not persisted");
    stored.reverse();
    stored.push("not json".into());
    let mut page = Outbox::default();
    assert_eq!(page.restore(&stored, 1000.0), 2);
    let keys: Vec<_> = page.items().iter().map(|i| i.key.clone()).collect();
    assert_eq!(keys, [a.clone(), b]);
    assert_eq!(
        page.items()[0].receipt,
        Some(receipt(1)),
        "the receipt is kept"
    );
    assert_eq!(page.head(&native(A), 1000.0).unwrap().key, a);
    // Restoring twice never duplicates; very old items are dropped.
    assert_eq!(page.restore(&stored, 1000.0), 0);
    assert_eq!(
        Outbox::default().restore(&stored, 8.0 * 24.0 * 3_600_000.0),
        0
    );
}

#[test]
fn sent_items_leave_after_the_timeline_shows_them_or_after_a_while() {
    let mut outbox = Outbox::default();
    let k = send(&mut outbox, native(A), "x", 1, 0.0);
    outbox.apply(
        &k,
        Outcome::Sent {
            message_id: Some("m".into()),
            notice: "Sent.".into(),
        },
        10.0,
    );
    assert_eq!(outbox.by_message("m").unwrap().phase, Phase::Sent);
    assert!(!outbox.has_expired_sent(10.0 + SENT_RETAIN_MS - 1.0));
    assert!(outbox.has_expired_sent(11.0 + SENT_RETAIN_MS));
    outbox.prune(20.0, |i| i.message_id.as_deref() == Some("m"));
    assert!(outbox.items().is_empty());
}

#[test]
fn a_full_outbox_drops_sent_items_first_and_never_unsent_ones() {
    let mut outbox = Outbox::default();
    for n in 0..LIMIT as u32 {
        send(&mut outbox, native(A), "x", n + 1, f64::from(n));
    }
    let extra = Item::new("local-x".into(), native(A), "x".into(), None, vec![]).unwrap();
    assert!(!outbox.enqueue(extra.clone()));
    outbox.apply(&key(1), sent(), 1.0);
    assert!(outbox.enqueue(extra));
    assert!(outbox.get(&key(1)).is_none());
}

#[test]
fn native_sends_carry_the_web_key_prefix_and_v1_keeps_a_bare_uuid() {
    let uuid = "00000000-0000-4000-8000-000000000001";
    assert_eq!(native("c").message_key(uuid), format!("web:{uuid}"));
    assert_eq!(Target::V1("t".into()).message_key(uuid), uuid);
}
