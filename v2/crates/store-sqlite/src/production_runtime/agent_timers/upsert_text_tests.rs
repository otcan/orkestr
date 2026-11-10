//! ORK-756: a timer's own turn (or any turn while one of its runs is
//! unfinished) can change the text of its next firing, without fencing that
//! run, without moving the planned occurrence and without duplicating runs.
use super::super::super::thread_asks::tests::{finish, owner_input};
use super::*;
use orkestr_v2_contracts::ExecutionControlRequest;

async fn fire(f: &Case, namespace: Uuid, due_ms: i64) {
    sqlx::query("UPDATE dormant_timers SET next_due_ms=? WHERE namespace=?")
        .bind(due_ms)
        .bind(namespace.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    let issuer = f.handle.authorize_timer_scheduler(namespace).await.unwrap();
    f.handle
        .admit_authorized_timer_turn(&issuer, namespace, false)
        .await
        .unwrap();
}
/// The text every firing received, oldest first.
async fn fired_texts(f: &Case, namespace: Uuid) -> Vec<String> {
    sqlx::query_scalar("SELECT m.text FROM dormant_timer_inputs i JOIN messages m ON m.id=i.message_id WHERE i.namespace=? ORDER BY i.scope_sequence")
        .bind(namespace.to_string())
        .fetch_all(&f.store.pool)
        .await
        .unwrap()
}
async fn held_inputs(f: &Case, namespace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM ordinary_input_holds h JOIN dormant_timer_inputs i ON i.event_id=h.event_id WHERE i.namespace=?")
        .bind(namespace.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}
async fn updates(f: &Case, namespace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM agent_timer_instruction_updates WHERE namespace=?")
        .bind(namespace.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}
async fn next_due(f: &Case, namespace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT next_due_ms FROM dormant_timers WHERE namespace=?")
        .bind(namespace.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}
/// A later owner turn of `c`; `asking_turn` only starts the first one.
async fn owner_turn(f: &Case, c: &ConversationId, key: &str) -> ProviderAdmission {
    owner_input(f, c, key).await;
    next_turn(f, c, key).await
}
async fn armed_watcher(f: &Case, c: &ConversationId, g: &str) -> Uuid {
    let (_, owner_turn) = asking_turn(f, c, "turn").await;
    let watcher = f
        .store
        .upsert_agent_timer(g, c, &upsert("w0", "Watcher", now_ms() + DAY, "Check."))
        .await
        .unwrap()
        .timer
        .namespace;
    finish(f, c, &owner_turn, "Set.", "turn").await;
    watcher
}

#[tokio::test]
async fn a_timer_turn_changes_its_own_text_for_the_next_firing_only() {
    let f = setup().await;
    let c = conversation(&f, "text-next-firing").await;
    let g = grant(&f, &c).await;
    let watcher = armed_watcher(&f, &c, &g).await;
    let gen = generation(&f, watcher).await;
    // The watcher fires; its own turn is running.
    fire(&f, watcher, 1).await;
    let timer_turn = next_turn(&f, &c, "timer-turn").await;
    assert_eq!(
        f.store.agent_timers(&g, &c).await.unwrap().timers[0].state,
        "exhausted"
    );
    // New text from the running turn: accepted, on the same timer and
    // generation, armed again, and that running turn is not fenced.
    let moved = f
        .store
        .upsert_agent_timer(
            &g,
            &c,
            &upsert("w1", "Watcher", now_ms() + DAY, "Next check."),
        )
        .await
        .unwrap();
    assert!(moved.changed);
    assert_eq!(moved.timer.namespace, watcher);
    assert_eq!(moved.timer.state, "enabled");
    assert_eq!(generation(&f, watcher).await, gen);
    assert_eq!(agent_rows(&f, &c).await, 1);
    assert_eq!(updates(&f, watcher).await, 1);
    assert_eq!(held_inputs(&f, watcher).await, 0, "the run is not fenced");
    // The owner's detail view shows the text the next firing will use.
    let shown = f
        .store
        .dormant_timer_detail(&f.token, &f.owner, watcher)
        .await
        .unwrap();
    assert!(shown.instruction.unwrap().ends_with("\n\nNext check."));
    // A lost-response retry of the same key applies nothing twice.
    let replay = f
        .store
        .upsert_agent_timer(
            &g,
            &c,
            &upsert("w1", "Watcher", now_ms() + DAY, "Next check."),
        )
        .await
        .unwrap();
    assert!(!replay.changed);
    assert_eq!(updates(&f, watcher).await, 1);
    finish(&f, &c, &timer_turn, "Checked.", "timer-turn").await;

    // The turn that was running kept its text; the next firing has the new
    // one; each firing ran exactly once.
    fire(&f, watcher, 2).await;
    let texts = fired_texts(&f, watcher).await;
    assert_eq!(texts.len(), 2, "one input per firing: {texts:?}");
    assert!(texts[0].ends_with("\n\nCheck."), "{}", texts[0]);
    assert!(texts[1].ends_with("\n\nNext check."), "{}", texts[1]);
    assert!(texts[1].contains("written by the agent"), "{}", texts[1]);
    let claims: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM dormant_timer_claims WHERE namespace=? AND cancelled=0",
    )
    .bind(watcher.to_string())
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(claims, 2);
    assert_eq!(held_inputs(&f, watcher).await, 0);
    let next = next_turn(&f, &c, "timer-turn-2").await;
    finish(&f, &c, &next, "Done.", "timer-turn-2").await;
}

#[tokio::test]
async fn the_newest_text_wins_and_a_repeat_of_it_is_a_no_op() {
    let f = setup().await;
    let c = conversation(&f, "text-newest").await;
    let g = grant(&f, &c).await;
    let watcher = armed_watcher(&f, &c, &g).await;
    fire(&f, watcher, 1).await;
    let timer_turn = next_turn(&f, &c, "timer-turn").await;
    let due = now_ms() + DAY;
    for (key, text) in [("w1", "First follow-up."), ("w2", "Second follow-up.")] {
        assert!(
            f.store
                .upsert_agent_timer(&g, &c, &upsert(key, "Watcher", due, text))
                .await
                .unwrap()
                .changed
        );
    }
    assert_eq!(updates(&f, watcher).await, 2);
    // Same text and schedule under a fresh key: nothing changes.
    let same = f
        .store
        .upsert_agent_timer(&g, &c, &upsert("w3", "Watcher", due, "Second follow-up."))
        .await
        .unwrap();
    assert!(!same.changed);
    assert_eq!(updates(&f, watcher).await, 2);
    finish(&f, &c, &timer_turn, "Checked.", "timer-turn").await;
    fire(&f, watcher, 2).await;
    let texts = fired_texts(&f, watcher).await;
    assert!(texts[1].ends_with("\n\nSecond follow-up."), "{}", texts[1]);
}

#[tokio::test]
async fn a_text_change_alone_keeps_the_planned_occurrence_of_a_queued_timer() {
    let f = setup().await;
    let c = conversation(&f, "text-keeps-due").await;
    let g = grant(&f, &c).await;
    let (_, set) = asking_turn(&f, &c, "set").await;
    let rule = daily("daily-0", vec![0], 480, 1140);
    let recurring = AgentTimerCreate {
        label: "Daily".into(),
        text: "Old daily text.".into(),
        ..rule.clone()
    };
    let watcher = f
        .store
        .upsert_agent_timer(&g, &c, &recurring)
        .await
        .unwrap()
        .timer
        .namespace;
    finish(&f, &c, &set, "Set.", "set").await;
    // An owner turn is running; the timer fires and its input is queued.
    let running = owner_turn(&f, &c, "busy").await;
    fire(&f, watcher, 1).await;
    let planned = next_due(&f, watcher).await;
    let gen = generation(&f, watcher).await;
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM dormant_timers WHERE namespace=?")
        .bind(watcher.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    let changed_text = AgentTimerCreate {
        request_key: "daily-1".into(),
        text: "New daily text.".into(),
        ..recurring.clone()
    };
    let moved = f
        .store
        .upsert_agent_timer(&g, &c, &changed_text)
        .await
        .unwrap();
    assert!(moved.changed);
    assert_eq!(moved.timer.state, "enabled");
    assert_eq!(next_due(&f, watcher).await, planned, "the slot is kept");
    assert_eq!(generation(&f, watcher).await, gen);
    let new_revision: i64 =
        sqlx::query_scalar("SELECT revision FROM dormant_timers WHERE namespace=?")
            .bind(watcher.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(new_revision, revision + 1, "a change bumps the revision");
    assert_eq!(held_inputs(&f, watcher).await, 0);
    finish(&f, &c, &running, "Done.", "busy").await;
    let queued = next_turn(&f, &c, "queued-run").await;
    finish(&f, &c, &queued, "Done.", "queued-run").await;
    fire(&f, watcher, 2).await;
    let texts = fired_texts(&f, watcher).await;
    assert!(texts[0].ends_with("\n\nOld daily text."), "{}", texts[0]);
    assert!(texts[1].ends_with("\n\nNew daily text."), "{}", texts[1]);
}

#[tokio::test]
async fn a_later_generation_never_uses_a_recorded_text() {
    let f = setup().await;
    let c = conversation(&f, "text-generation").await;
    let g = grant(&f, &c).await;
    let watcher = armed_watcher(&f, &c, &g).await;
    let first = generation(&f, watcher).await;
    fire(&f, watcher, 1).await;
    let timer_turn = next_turn(&f, &c, "timer-turn").await;
    f.store
        .upsert_agent_timer(
            &g,
            &c,
            &upsert("w1", "Watcher", now_ms() + DAY, "Recorded."),
        )
        .await
        .unwrap();
    finish(&f, &c, &timer_turn, "Checked.", "timer-turn").await;
    // No run left: another new text takes the ordinary new-generation path.
    let running = owner_turn(&f, &c, "next").await;
    f.store
        .upsert_agent_timer(
            &g,
            &c,
            &upsert("w2", "Watcher", now_ms() + DAY, "Fresh grant."),
        )
        .await
        .unwrap();
    assert!(generation(&f, watcher).await > first);
    assert_eq!(updates(&f, watcher).await, 1);
    finish(&f, &c, &running, "Done.", "next").await;
    fire(&f, watcher, 2).await;
    let texts = fired_texts(&f, watcher).await;
    assert!(texts[1].ends_with("\n\nFresh grant."), "{}", texts[1]);
}

#[tokio::test]
async fn a_stop_still_refuses_new_text_while_a_run_is_unfinished() {
    let f = setup().await;
    let c = conversation(&f, "text-stop").await;
    let g = grant(&f, &c).await;
    let watcher = armed_watcher(&f, &c, &g).await;
    let stopped = owner_turn(&f, &c, "stopped").await;
    fire(&f, watcher, 1).await;
    let status = f
        .store
        .execution_status(&f.owner, &c)
        .await
        .unwrap()
        .unwrap();
    f.handle
        .stop_execution(
            &f.owner,
            &c,
            &ExecutionControlRequest {
                expected_control_revision: None,
                run_id: stopped.run.run_id.clone(),
                expected_revision: status.revision,
                request_key: "stop".into(),
            },
        )
        .await
        .unwrap();
    // A later turn tries to move the timer; the Stop invalidated this
    // generation and the fired input is still held, so no new generation.
    let later = owner_turn(&f, &c, "later").await;
    assert_eq!(
        f.store
            .upsert_agent_timer(&g, &c, &upsert("w1", "Watcher", now_ms() + DAY, "New."))
            .await,
        refused("agent_timer_busy")
    );
    assert_eq!(updates(&f, watcher).await, 0);
    finish(&f, &c, &later, "Done.", "later").await;
}
