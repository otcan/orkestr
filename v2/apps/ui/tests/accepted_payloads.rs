//! ORK-797: answer texts load in batches, stay once read, and retry quietly.
use orkestr_v2_contracts::{AcceptedResult, ProviderPayload, ProviderPayloads};
use orkestr_v2_ui::accepted_payloads::{
    adds_work, answer, batches, retry_window_ms, sort_batch, wanted, Answer, PayloadCache,
    ATTEMPTS, HINT_AFTER_MS,
};
use serde_json::json;

const C: &str = "00000000-0000-4000-8000-000000000001";
const OTHER: &str = "00000000-0000-4000-8000-000000000002";
fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}
fn row(n: u32) -> AcceptedResult {
    serde_json::from_value(json!({"run_id":id(1000 + n),"completion_event_id":id(2000 + n),
        "acceptance_event_id":id(3000 + n),"acceptance_sequence":n,"payload_id":id(4000 + n),"payload_removed":false}))
    .unwrap()
}
fn payload(n: u32, text: Option<&str>) -> ProviderPayload {
    serde_json::from_value(
        json!({"payload_id":id(4000 + n),"conversation_id":C,"run_id":id(1000 + n),"text":text}),
    )
    .unwrap()
}
fn batch(payloads: Vec<ProviderPayload>) -> ProviderPayloads {
    serde_json::from_value(json!({"conversation_id":C,"payloads":payloads})).unwrap()
}
fn sequences(rows: &[AcceptedResult]) -> Vec<i64> {
    rows.iter().map(|r| r.acceptance_sequence).collect()
}

#[test]
fn one_batch_reads_every_uncached_answer_newest_first() {
    let rows: Vec<_> = (1..=25).map(row).collect();
    let mut cache = PayloadCache::default();
    let todo = wanted(C, &rows, &cache);
    assert_eq!(todo.len(), 25);
    assert_eq!(todo[0].acceptance_sequence, 25, "the newest answer first");
    // 25 answers are one request, not 25.
    assert_eq!(batches(&todo).len(), 1);
    assert_eq!(batches(&(1..=120).map(row).collect::<Vec<_>>()).len(), 3);
    // Removed and text-less replies need no read; cached ones are not read again.
    let mut removed = row(26);
    removed.payload_removed = true;
    let mut empty = row(27);
    empty.payload_id = None;
    cache.insert(payload(25, Some("cached")));
    let todo = wanted(C, &[rows.clone(), vec![removed, empty]].concat(), &cache);
    assert_eq!(sequences(&todo), (1..=24).rev().collect::<Vec<_>>());
}

#[test]
fn batch_answers_are_checked_against_their_replies() {
    let asked: Vec<_> = (1..=3).map(row).collect();
    // 2 is left out (unknown, or too large for the batch), 3 names another run.
    let mut foreign = payload(3, Some("not this reply"));
    foreign.run_id = serde_json::from_value(json!(id(1999))).unwrap();
    let sorted = sort_batch(C, &asked, &batch(vec![payload(1, Some("one")), foreign]));
    assert_eq!(sorted.read.len(), 1);
    assert_eq!(sorted.read[0].1.text.as_deref(), Some("one"));
    assert_eq!(
        sequences(&sorted.alone),
        [2, 3],
        "the rest is read one by one"
    );
    // A batch for another conversation, with an ID nobody asked for, or with
    // an ID twice proves nothing: everything is read alone.
    let mut elsewhere = batch(vec![payload(1, Some("one"))]);
    elsewhere.conversation_id = serde_json::from_value(json!(OTHER)).unwrap();
    let unasked = batch(vec![payload(1, Some("one")), payload(9, Some("nine"))]);
    let twice = batch(vec![payload(1, Some("one")), payload(1, Some("one"))]);
    for answer in [elsewhere, unasked, twice] {
        let sorted = sort_batch(C, &asked, &answer);
        assert!(sorted.read.is_empty());
        assert_eq!(sequences(&sorted.alone), [1, 2, 3]);
    }
}

#[test]
fn a_read_text_stays_and_a_removal_is_final() {
    let mut cache = PayloadCache::default();
    let reply = row(1);
    assert_eq!(answer(C, &reply, &cache, false), Answer::Loading);
    assert_eq!(answer(C, &reply, &cache, true), Answer::Failed);
    cache.insert(payload(1, Some("shown")));
    // Once read, a failure elsewhere never blanks the text.
    assert_eq!(
        answer(C, &reply, &cache, true),
        Answer::Read(Some("shown".into()))
    );
    // A removal is never undone by a late read.
    cache.insert(payload(1, None));
    cache.insert(payload(1, Some("late read")));
    assert_eq!(answer(C, &reply, &cache, false), Answer::Read(None));
    cache.insert(payload(2, Some("removed on this page")));
    cache.removed(C, &id(4002));
    cache.insert(payload(2, Some("late read")));
    assert_eq!(answer(C, &row(2), &cache, false), Answer::Read(None));
    // A cached text never shows for a reply it does not belong to.
    let mut moved = row(1);
    moved.run_id = serde_json::from_value(json!(id(1999))).unwrap();
    assert_eq!(answer(C, &moved, &cache, false), Answer::Loading);
    assert_eq!(answer(OTHER, &row(1), &cache, false), Answer::Loading);
    let mut withdrawn = row(3);
    cache.insert(payload(3, Some("text")));
    withdrawn.payload_removed = true;
    assert!(cache.get(C, &withdrawn).is_none());
}

#[test]
fn the_cache_is_per_session_and_bounded() {
    let mut cache = PayloadCache::default();
    cache.scope(1);
    cache.insert(payload(1, Some("first session")));
    cache.scope(1);
    assert_eq!(cache.len(), 1, "the same session keeps its texts");
    cache.scope(2);
    assert!(
        cache.is_empty(),
        "a new session never sees the last one's texts"
    );
    let big = "x".repeat(8192);
    for n in 0..2000 {
        cache.insert(payload(n, Some(&big)));
    }
    assert!(cache.len() <= 1000);
    assert!(cache.len() * big.len() <= 8 * 1024 * 1024);
    assert!(cache.get(C, &row(1999)).is_some(), "the newest stay");
    assert!(cache.get(C, &row(0)).is_none(), "the oldest go");
}

#[test]
fn only_new_answers_restart_the_reader() {
    let current: Vec<_> = (1..=3).map(row).collect();
    assert!(
        !adds_work(&current, &current[1..]),
        "fewer to read: keep going"
    );
    assert!(!adds_work(&current, &[]));
    assert!(adds_work(&current, &[row(4)]));
}

#[test]
fn retries_back_off_with_jitter_and_end() {
    let windows: Vec<_> = (1..ATTEMPTS).map(retry_window_ms).collect();
    assert_eq!(windows[0], (750, 1250));
    assert_eq!(windows[1], (1500, 2500));
    for pair in windows.windows(2) {
        assert!(pair[1].0 >= pair[0].0, "never faster than before");
    }
    assert!(windows
        .iter()
        .all(|(low, high)| low < high && *high <= 37_500));
    assert_eq!(retry_window_ms(40), (22_500, 37_500));
    // Every read fails for over a minute before "could not be loaded".
    let least: u32 = windows.iter().map(|w| w.0).sum();
    assert!(least >= 60_000, "{least}");
    assert_eq!(HINT_AFTER_MS, 3000);
}
