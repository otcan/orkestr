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
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn a_burst_queued_while_deep_was_busy_is_one_numbered_turn() {
    let f = setup().await;
    let first = busy(&f).await;
    for key in ["a", "b", "c"] {
        owner(&f, key).await;
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
    let text = super::deep_groups::render(&[
        (7, "m-1".into(), item("first")),
        (9, "m-2".into(), item("second")),
    ]);
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
