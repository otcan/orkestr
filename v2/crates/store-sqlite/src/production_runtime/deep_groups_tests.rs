//! Deep burst grouping: only while Deep was busy, bounded, consumed once.
use super::deep_groups::{DEEP_GROUP_MAX_INPUTS, DEEP_GROUP_TEXT_BUDGET};
use super::observation_tests::input;
use super::tests::{ready, setup, Case};
use super::*;
use orkestr_v2_contracts::{
    ConversationProvider, ConversationSettingsUpdate, ExecutionAcceptanceRequest, InputAuthor,
    MessageInput, Receipt,
};
use std::time::Duration;

async fn say(f: &Case, key: &str, text: &str, author: Option<InputAuthor>) -> Receipt {
    f.store
        .admit_attributed(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: key.into(),
                text: text.into(),
            },
            None,
            None,
            None,
            author,
        )
        .await
        .unwrap()
        .receipt
}

async fn owner(f: &Case, key: &str) -> Receipt {
    say(
        f,
        key,
        &format!("owner says {key}"),
        Some(InputAuthor::Owner),
    )
    .await
}

async fn deep(f: &Case) -> Binding {
    f.handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep
}

/// Claim and admit the next Deep turn; None when nothing is claimable.
async fn admit(f: &Case, key: &str) -> Option<RunAdmissionResult> {
    let b = deep(f).await;
    let claim = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &b.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()?;
    Some(
        f.handle
            .admit_run(&claim, &b.session_id, b.generation, key)
            .await
            .unwrap(),
    )
}

/// Reserve and consume: the exact text the provider receives.
async fn dispatch(f: &Case, run: &RunAdmissionResult, key: &str) -> String {
    let DispatchClaimResult::Reserved(reservation) =
        f.handle.claim_provider_dispatch(run, key).await.unwrap()
    else {
        panic!("reservation")
    };
    let ExecutionConsumption::Dispatch(capability) =
        f.handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!("consumption")
    };
    capability.text().to_owned()
}

async fn start(f: &Case, p: &ProviderAdmission) {
    f.handle
        .append_provider_event(&f.owner, p, &input(p, 1, ProviderEvent::Started))
        .await
        .unwrap();
}

/// Completion proposal plus owner acceptance: the Deep binding is ready again.
async fn finish(f: &Case, p: &ProviderAdmission, key: &str) {
    let done = f
        .handle
        .append_provider_event(
            &f.owner,
            p,
            &input(p, 2, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    let revision = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap()
        .revision;
    f.store
        .accept_execution(
            &f.owner,
            &f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: p.run.run_id.clone(),
                completion_event_id: done.event_id,
                expected_revision: revision,
                request_key: key.into(),
            },
        )
        .await
        .unwrap();
}

/// A first Deep turn that is running (busy) until `finish`.
async fn busy(f: &Case) -> ProviderAdmission {
    ready(f).await;
    owner(f, "first").await;
    let run = admit(f, "first-run").await.unwrap();
    dispatch(f, &run, "first-reserve").await;
    start(f, &run.provider).await;
    run.provider
}

async fn group(f: &Case, run: &RunAdmissionResult) -> Vec<String> {
    f.store
        .deep_run_group_authenticated(
            &f.token,
            &f.owner,
            &f.conversation,
            &run.provider.run.run_id,
        )
        .await
        .unwrap()
        .into_iter()
        .map(|(_, _, key)| key)
        .collect()
}

async fn queued(f: &Case) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM reasoning_inbox WHERE conversation_id=? AND state='queued'",
    )
    .bind(f.conversation.to_string())
    .fetch_one(&f.store.pool)
    .await
    .unwrap()
}

async fn grouping(f: &Case, revision: i64, on: Option<bool>) {
    f.store
        .update_conversation_settings(
            &f.token,
            &f.owner,
            &f.conversation,
            &ConversationSettingsUpdate {
                expected_revision: revision,
                provider: ConversationProvider::Codex,
                model: None,
                reasoning_effort: None,
                honor_no_reply: true,
                reply_prefix: None,
                reply_footer: None,
                review_before_accepting: false,
                deep_grouping: on,
                parallel_deep: None,
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn a_burst_queued_while_deep_was_busy_is_one_numbered_turn() {
    let f = setup().await;
    let first = busy(&f).await;
    // Three separate messages, 3 s apart (not one split message).
    for (key, ago) in [("a", 9_000), ("b", 6_000), ("c", 3_000)] {
        let receipt = owner(&f, key).await;
        arrived_ago(&f, &receipt, ago).await;
    }
    finish(&f, &first, "accept-first").await;
    let run = admit(&f, "grouped").await.unwrap();
    assert_eq!(group(&f, &run).await, ["a", "b", "c"]);
    let text = dispatch(&f, &run, "grouped-reserve").await;
    assert!(
        text.starts_with("[Grouped turn: 3 owner messages"),
        "{text}"
    );
    assert!(text.contains("Answer every item explicitly"));
    let (one, two, three) = (
        text.find("\n\n1. [source: message ").unwrap(),
        text.find("\n\n2. [source: message ").unwrap(),
        text.find("\n\n3. [source: message ").unwrap(),
    );
    assert!(one < two && two < three, "arrival order");
    assert!(text[one..two].contains("owner says a"));
    assert!(text[three..].contains("owner says c"));
    // Each grouped input is consumed by this one run: nothing is left to
    // claim, and the next turn cannot take any of them again.
    assert_eq!(queued(&f).await, 0);
    let consumed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM reasoning_inbox WHERE admitted_run_id=? AND state='consumed'",
    )
    .bind(run.provider.run.run_id.to_string())
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(consumed, 3);
    start(&f, &run.provider).await;
    finish(&f, &run.provider, "accept-grouped").await;
    assert!(admit(&f, "nothing-left").await.is_none());
}

#[tokio::test]
async fn a_single_input_and_an_idle_deep_keep_the_plain_turn() {
    let f = setup().await;
    // Deep idle (no earlier run): two inputs are still two turns.
    ready(&f).await;
    owner(&f, "x").await;
    owner(&f, "y").await;
    let run = admit(&f, "idle").await.unwrap();
    assert!(group(&f, &run).await.is_empty());
    assert_eq!(dispatch(&f, &run, "idle-reserve").await, "owner says x");
    assert_eq!(queued(&f).await, 1);
    start(&f, &run.provider).await;
    finish(&f, &run.provider, "accept-idle").await;
    // `y` waited behind a busy Deep, but alone: unchanged single turn.
    let lone = admit(&f, "lone").await.unwrap();
    assert!(group(&f, &lone).await.is_empty());
    assert_eq!(dispatch(&f, &lone, "lone-reserve").await, "owner says y");
    start(&f, &lone.provider).await;
    finish(&f, &lone.provider, "accept-lone").await;
    // Inputs that arrive after Deep finished (idle again) are not grouped.
    owner(&f, "later-1").await;
    owner(&f, "later-2").await;
    let later = admit(&f, "later").await.unwrap();
    assert!(group(&f, &later).await.is_empty());
    assert_eq!(queued(&f).await, 1);
}

#[tokio::test]
async fn a_group_is_capped_at_twelve_inputs_and_a_byte_budget() {
    let f = setup().await;
    let first = busy(&f).await;
    for n in 0..DEEP_GROUP_MAX_INPUTS + 2 {
        owner(&f, &format!("burst-{n:02}")).await;
    }
    finish(&f, &first, "accept-first").await;
    let run = admit(&f, "capped").await.unwrap();
    let keys = group(&f, &run).await;
    assert_eq!(keys.len(), DEEP_GROUP_MAX_INPUTS);
    assert_eq!(keys.first().unwrap(), "burst-00");
    assert_eq!(keys.last().unwrap(), "burst-11");
    assert_eq!(queued(&f).await, 2, "the rest waits, in order");
    let text = dispatch(&f, &run, "capped-reserve").await;
    assert!(text.contains("\n\n12. [source: message "));
    start(&f, &run.provider).await;
    // A burst of large inputs stops at the byte budget, in arrival order.
    let big = "x".repeat(DEEP_GROUP_TEXT_BUDGET / 3);
    for key in ["big-1", "big-2", "big-3", "big-4"] {
        say(&f, key, &big, Some(InputAuthor::Owner)).await;
    }
    finish(&f, &run.provider, "accept-capped").await;
    let rest = admit(&f, "rest").await.unwrap();
    // burst-12, burst-13 (small), big-1 and big-2 fit; big-3 would not.
    assert_eq!(
        group(&f, &rest).await,
        ["burst-12", "burst-13", "big-1", "big-2"]
    );
    assert_eq!(queued(&f).await, 2);
    assert!(dispatch(&f, &rest, "rest-reserve").await.len() < 32 * 1024);
}

#[tokio::test]
async fn a_crash_before_admission_requeues_the_whole_group_exactly_once() {
    let f = setup().await;
    let first = busy(&f).await;
    for key in ["a", "b", "c"] {
        owner(&f, key).await;
    }
    finish(&f, &first, "accept-first").await;
    // The head is claimed, then the process dies before admission commits:
    // nothing was consumed, so the lapsed claim gives the burst back whole.
    let b = deep(&f).await;
    let lost = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &b.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(queued(&f).await, 2);
    sqlx::query("UPDATE reasoning_inbox SET claim_deadline_ms=1 WHERE event_id=?")
        .bind(lost.event_id.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let handle = f.handle.reattach_supervisor(&reopened).await.unwrap();
    let b = handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let claim = handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &b.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.event_id, lost.event_id);
    assert!(claim.claim_generation > lost.claim_generation);
    let run = handle
        .admit_run(&claim, &b.session_id, b.generation, "after-crash")
        .await
        .unwrap();
    assert_eq!(group(&f, &run).await, ["a", "b", "c"]);
    // An admission replay (a crash after the commit) returns the same run
    // and consumes nothing more.
    let replay = handle
        .admit_run(&claim, &b.session_id, b.generation, "after-crash")
        .await
        .unwrap();
    assert_eq!(replay.provider.run.run_id, run.provider.run.run_id);
    assert_eq!(group(&f, &run).await, ["a", "b", "c"]);
    assert_eq!(queued(&f).await, 0);
    assert!(handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &b.session_id,
            Duration::from_secs(60)
        )
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn timer_member_and_unattributed_inputs_are_never_grouped_with_owner_inputs() {
    let f = setup().await;
    let first = busy(&f).await;
    owner(&f, "a").await;
    say(&f, "member", "member says hi", Some(InputAuthor::Member)).await;
    owner(&f, "b").await;
    finish(&f, &first, "accept-first").await;
    // The member input keeps its own turn, and the group never runs past it.
    let a = admit(&f, "a-run").await.unwrap();
    assert!(group(&f, &a).await.is_empty());
    assert_eq!(queued(&f).await, 2);
    dispatch(&f, &a, "a-reserve").await;
    start(&f, &a.provider).await;
    // A timer occurrence (here even an owner-attributed one) and an input
    // without a verified author keep their own turns too.
    let timer = owner(&f, "timer").await;
    let mut connection = f.store.pool.acquire().await.unwrap();
    sqlx::query("PRAGMA foreign_keys=OFF")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO dormant_timer_inputs(claim_id,owner_id,namespace,generation,input_digest,message_id,event_id,scope_sequence) VALUES(?,?,?,1,?,?,?,?)")
        .bind(Uuid::new_v4().to_string()).bind(f.owner.to_string()).bind(Uuid::new_v4().to_string())
        .bind("0".repeat(64)).bind(timer.message_id.to_string()).bind(timer.event_id.to_string()).bind(timer.sequence)
        .execute(&mut *connection).await.unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut *connection)
        .await
        .unwrap();
    drop(connection);
    say(&f, "unattributed", "no author", None).await;
    finish(&f, &a.provider, "accept-a").await;
    for key in ["member-run", "b-run", "timer-run", "unattributed-run"] {
        let run = admit(&f, key).await.unwrap();
        assert!(group(&f, &run).await.is_empty(), "{key}");
        dispatch(&f, &run, &format!("{key}-reserve")).await;
        start(&f, &run.provider).await;
        finish(&f, &run.provider, &format!("{key}-accept")).await;
    }
    assert_eq!(queued(&f).await, 0);
}

#[tokio::test]
async fn the_owner_switch_is_read_live_at_each_admission() {
    let f = setup().await;
    let first = busy(&f).await;
    grouping(&f, 0, Some(false)).await;
    owner(&f, "a").await;
    owner(&f, "b").await;
    finish(&f, &first, "accept-first").await;
    let off = admit(&f, "off").await.unwrap();
    assert!(group(&f, &off).await.is_empty());
    assert_eq!(dispatch(&f, &off, "off-reserve").await, "owner says a");
    start(&f, &off.provider).await;
    owner(&f, "c").await;
    // An update that omits the switch keeps it off.
    grouping(&f, 1, None).await;
    let settings = f
        .store
        .conversation_settings(&f.token, &f.owner, &f.conversation)
        .await
        .unwrap();
    assert!(!settings.deep_grouping);
    // Turned back on while the turn runs: the next admission groups.
    grouping(&f, 2, Some(true)).await;
    finish(&f, &off.provider, "accept-off").await;
    let on = admit(&f, "on").await.unwrap();
    assert_eq!(group(&f, &on).await, ["b", "c"]);
}

#[tokio::test]
async fn stop_holds_inputs_per_input_and_a_later_group_skips_them() {
    let f = setup().await;
    ready(&f).await;
    owner(&f, "first").await;
    let stopped = admit(&f, "stopped").await.unwrap();
    owner(&f, "held-1").await;
    owner(&f, "held-2").await;
    // Owner Stop: the queued inputs are held, each on its own.
    f.handle
        .request_cancel(&f.owner, &stopped.provider.run.run_id, "stop")
        .await
        .unwrap();
    owner(&f, "next").await;
    let next = admit(&f, "next-run").await.unwrap();
    assert!(group(&f, &next).await.is_empty());
    dispatch(&f, &next, "next-reserve").await;
    start(&f, &next.provider).await;
    owner(&f, "d").await;
    owner(&f, "e").await;
    finish(&f, &next.provider, "accept-next").await;
    let run = admit(&f, "grouped").await.unwrap();
    assert_eq!(group(&f, &run).await, ["d", "e"]);
    let held = f
        .handle
        .held_owner_inputs_authenticated(&f.token, &f.conversation, 0, 100)
        .await
        .unwrap();
    assert_eq!(held.held.len(), 2, "held inputs stay held, never grouped");
    assert_eq!(queued(&f).await, 2);
}

#[test]
fn a_shared_chat_rules_line_is_given_once_at_the_top() {
    let line = format!(
        "[Chat rules v{}: before answering, read /synthetic/rules.md (cat it) unless you already read this version in this session, and follow it.]",
        "a".repeat(12)
    );
    let item = |body: &str| format!("{line}\n\n[WhatsApp: synthetic]\n{body}");
    let text = super::deep_groups::render(
        &[
            (7, "m-1".into(), item("first")),
            (9, "m-2".into(), item("second")),
        ],
        false,
    );
    assert!(text.starts_with(&format!("{line}\n\n[Grouped turn: 2 owner messages")));
    assert_eq!(text.matches("[Chat rules v").count(), 1);
    assert!(text.contains("\n\n1. [source: message m-1, sequence 7]\n[WhatsApp: synthetic]\nfirst"));
    assert!(
        text.contains("\n\n2. [source: message m-2, sequence 9]\n[WhatsApp: synthetic]\nsecond")
    );
}

#[tokio::test]
async fn an_input_that_arrived_after_deep_went_idle_keeps_its_own_turn() {
    let f = setup().await;
    let first = busy(&f).await;
    owner(&f, "a").await;
    owner(&f, "b").await;
    finish(&f, &first, "accept-first").await;
    // Deep is idle now, but `a` was not admitted yet: a later input (a new
    // task, or a deadline continuation re-admitted for an older adapter row)
    // never joins the burst that waited behind the finished turn.
    owner(&f, "late").await;
    let run = admit(&f, "grouped").await.unwrap();
    assert_eq!(group(&f, &run).await, ["a", "b"]);
    assert_eq!(queued(&f).await, 1);
    dispatch(&f, &run, "grouped-reserve").await;
    start(&f, &run.provider).await;
    finish(&f, &run.provider, "accept-grouped").await;
    let lone = admit(&f, "lone").await.unwrap();
    assert!(group(&f, &lone).await.is_empty());
    assert_eq!(dispatch(&f, &lone, "lone-reserve").await, "owner says late");
}

// Split messages (bursts): WhatsApp delivers one thought typed as several
// messages within a second or two. an owner chat on 2026-10-31:
// "Say :", "Field      notes." and ":)" arrived 0.5 s apart while
// Deep was idle; Deep answered "Say :" alone, then a second turn the rest.

const QUIET_MS: i64 = super::deep_groups::DEFAULT_DEEP_BURST_QUIET_MS;

/// A case whose supervisor handle uses the server's default quiet window.
async fn burst_case() -> Case {
    let mut f = setup().await;
    f.handle = f.handle.clone().with_deep_burst_quiet_ms(QUIET_MS);
    assert_eq!(f.handle.deep_burst_quiet_ms(), QUIET_MS);
    f
}

/// Core recorded the input as arriving `ms` milliseconds ago.
async fn arrived_ago(f: &Case, receipt: &Receipt, ms: i64) {
    sqlx::query("UPDATE events SET occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',printf('-%.3f seconds',?1/1000.0)) WHERE id=?2")
        .bind(ms)
        .bind(receipt.event_id.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_split_owner_message_waits_for_its_burst_and_is_one_deep_turn() {
    let f = burst_case().await;
    ready(&f).await;
    // The exact PA burst, Deep idle: 15:03:44.03, 44.52 and 45.07.
    let parts = [
        ("say", "Say :", 1_040),
        ("field", "Field      notes.", 550),
        ("smile", ":)", 10),
    ];
    let mut receipts = Vec::new();
    for (key, text, ago) in parts {
        let receipt = say(&f, key, text, Some(InputAuthor::Owner)).await;
        arrived_ago(&f, &receipt, ago).await;
        receipts.push(receipt);
    }
    // The last part is 10 ms old: Deep waits, nothing is claimed or consumed.
    assert!(admit(&f, "too-early").await.is_none());
    assert_eq!(queued(&f).await, 3);
    // Quiet for the window: one Deep turn takes the whole burst, in order.
    for (receipt, (_, _, ago)) in receipts.iter().zip(parts) {
        arrived_ago(&f, receipt, ago + QUIET_MS).await;
    }
    let run = admit(&f, "burst").await.unwrap();
    assert_eq!(group(&f, &run).await, ["say", "field", "smile"]);
    assert_eq!(queued(&f).await, 0, "every part consumed by the one run");
    let text = dispatch(&f, &run, "burst-reserve").await;
    assert!(
        text.starts_with("[Split message: the owner sent this as 3 WhatsApp messages"),
        "{text}"
    );
    assert!(text.contains("answer it once") && !text.contains("Answer every item"));
    let (one, two, three) = (
        text.find("\n1. [source: message").unwrap(),
        text.find("\n2. [source: message").unwrap(),
        text.find("\n3. [source: message").unwrap(),
    );
    assert!(one < two && two < three);
    assert!(text[one..two].contains("Say :"));
    assert!(text[two..three].contains("Field      notes."));
    assert!(text[three..].trim_end().ends_with(":)"));
    start(&f, &run.provider).await;
    finish(&f, &run.provider, "accept-burst").await;
    assert!(admit(&f, "nothing-left").await.is_none());
}

#[tokio::test]
async fn a_message_after_the_quiet_window_keeps_its_own_turn() {
    let f = burst_case().await;
    ready(&f).await;
    let first = owner(&f, "first").await;
    let later = owner(&f, "ten-seconds-later").await;
    arrived_ago(&f, &first, 15_000).await;
    arrived_ago(&f, &later, 5_000).await;
    // Ten seconds apart: two thoughts, never one burst, and no wait.
    let run = admit(&f, "first-run").await.unwrap();
    assert!(group(&f, &run).await.is_empty());
    assert_eq!(
        dispatch(&f, &run, "first-reserve").await,
        "owner says first"
    );
    assert_eq!(queued(&f).await, 1);
    start(&f, &run.provider).await;
    finish(&f, &run.provider, "accept-first").await;
    let next = admit(&f, "later-run").await.unwrap();
    assert!(group(&f, &next).await.is_empty());
    assert_eq!(
        dispatch(&f, &next, "later-reserve").await,
        "owner says ten-seconds-later"
    );
}

#[tokio::test]
async fn a_member_message_inside_the_window_is_never_merged_with_the_owner() {
    let f = burst_case().await;
    ready(&f).await;
    let a = owner(&f, "a").await;
    let member = say(&f, "member", "member says hi", Some(InputAuthor::Member)).await;
    let b = owner(&f, "b").await;
    for receipt in [&a, &member, &b] {
        arrived_ago(&f, receipt, QUIET_MS + 100).await;
    }
    // The burst stops at the member: the owner's turn is `a` alone, the
    // member keeps its own turn, and `b` never joins `a` past it.
    let run = admit(&f, "a-run").await.unwrap();
    assert!(group(&f, &run).await.is_empty());
    assert_eq!(dispatch(&f, &run, "a-reserve").await, "owner says a");
    start(&f, &run.provider).await;
    finish(&f, &run.provider, "accept-a").await;
    // A member head never waits for a burst, even when fresh.
    arrived_ago(&f, &member, 0).await;
    let run = admit(&f, "member-run").await.unwrap();
    assert!(group(&f, &run).await.is_empty());
    assert_eq!(dispatch(&f, &run, "member-reserve").await, "member says hi");
    start(&f, &run.provider).await;
    finish(&f, &run.provider, "accept-member").await;
    let run = admit(&f, "b-run").await.unwrap();
    assert!(group(&f, &run).await.is_empty());
    assert_eq!(dispatch(&f, &run, "b-reserve").await, "owner says b");
}

#[tokio::test]
async fn a_continuous_stream_holds_its_head_at_most_four_windows() {
    let f = burst_case().await;
    ready(&f).await;
    // One message a second for 11 s: the head stops waiting after 10 s.
    let mut keys = Vec::new();
    for n in 0..11 {
        let key = format!("stream-{n:02}");
        let receipt = owner(&f, &key).await;
        arrived_ago(&f, &receipt, 10_500 - n * 1_000).await;
        keys.push(key);
    }
    let run = admit(&f, "stream").await.unwrap();
    assert_eq!(
        group(&f, &run).await,
        keys,
        "every part so far joins the turn"
    );
    assert_eq!(queued(&f).await, 0);
}

#[tokio::test]
async fn the_owner_switch_off_never_waits_or_groups_a_burst() {
    let f = burst_case().await;
    ready(&f).await;
    grouping(&f, 0, Some(false)).await;
    owner(&f, "x").await;
    owner(&f, "y").await;
    let run = admit(&f, "x-run").await.unwrap();
    assert!(group(&f, &run).await.is_empty());
    assert_eq!(dispatch(&f, &run, "x-reserve").await, "owner says x");
    assert_eq!(queued(&f).await, 1);
}

#[tokio::test]
async fn a_burst_that_straddles_the_end_of_a_busy_turn_stays_one_group() {
    let f = burst_case().await;
    ready(&f).await;
    let earlier = owner(&f, "first").await;
    arrived_ago(&f, &earlier, 60_000).await;
    let first = admit(&f, "first-run").await.unwrap();
    dispatch(&f, &first, "first-reserve").await;
    start(&f, &first.provider).await;
    let first = first.provider;
    let a = owner(&f, "a").await;
    let b = owner(&f, "b").await;
    finish(&f, &first, "accept-first").await;
    // `c` is the third part of the same split message, sent just after the
    // turn ended: it still joins the burst that waited behind it.
    let c = owner(&f, "c").await;
    for (receipt, ago) in [(&a, 3_400), (&b, 3_000), (&c, 2_600)] {
        arrived_ago(&f, receipt, ago).await;
    }
    let run = admit(&f, "grouped").await.unwrap();
    assert_eq!(group(&f, &run).await, ["a", "b", "c"]);
    let text = dispatch(&f, &run, "grouped-reserve").await;
    assert!(
        text.starts_with("[Split message: the owner sent this as 3"),
        "{text}"
    );
}
