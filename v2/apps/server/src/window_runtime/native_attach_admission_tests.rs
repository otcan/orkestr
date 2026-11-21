//! Native-attach holds at window admission and dispatch. A held conversation
//! only queues: no fresh window and no join, by admission or by dispatch. The
//! same intent is admitted once after release, also by a restarted process
//! that rebinds the same Root directory. A deploy drain counts a held
//! conversation that has only queued intents as quiet.
use super::*;
use crate::native_attach::fixture::Holds;

fn held(f: &Fixture, holds: &Holds, capacity: u32) -> Controller {
    let mut controller = f.controller(capacity);
    controller.config.native_attach = Some(holds.holds.clone());
    controller
}

async fn queue_state(
    f: &Fixture,
    conversation: &ConversationId,
    request: &ExecutionWindowRequest,
) -> QueuedWindowState {
    f.store
        .queued_execution_window_authenticated(BROWSER, conversation, request)
        .await
        .unwrap()
        .unwrap()
        .state
}

#[tokio::test]
async fn a_held_conversation_queues_until_release_then_its_intent_is_admitted_once() {
    let f = fixture().await;
    let holds = Holds::new();
    let (chat, other) = (f.conversation("held").await, f.conversation("free").await);
    holds.hold(&chat);
    let controller = held(&f, &holds, 8);
    let request = f.request(&chat, "while-held").await;
    let WindowOutcome::Queued(queued) = controller
        .process(BROWSER, &f.owner, &chat, &request)
        .await
        .unwrap()
    else {
        panic!("a held conversation must queue, never open a window")
    };
    assert_eq!(queued.state, QueuedWindowState::Queued);
    // Dispatch passes keep it queued while the hold lasts.
    for _ in 0..3 {
        controller.queue.wake();
        controller.dispatch_once().await;
    }
    assert_eq!(f.windows(&chat).await, 0);
    assert_eq!(
        queue_state(&f, &chat, &request).await,
        QueuedWindowState::Queued
    );
    // Another conversation is not held: its intent is admitted at once.
    let free = f.request(&other, "not-held").await;
    assert!(matches!(
        controller.process(BROWSER, &f.owner, &other, &free).await,
        Ok(WindowOutcome::Admitted(_)) | Err(_)
    ));
    assert_eq!(f.windows(&other).await, 1);
    // Released: the next pass admits the same intent, exactly once.
    holds.release(&chat);
    controller.queue.wake();
    controller.dispatch_once().await;
    assert_eq!(
        queue_state(&f, &chat, &request).await,
        QueuedWindowState::Dispatched
    );
    assert_eq!(f.windows(&chat).await, 1);
    for _ in 0..3 {
        controller.queue.wake();
        controller.dispatch_once().await;
    }
    assert_eq!(f.windows(&chat).await, 1);
    controller.queue.close().await;
}

/// Test only: a direct Core read or update, as `expired_join_http_tests`.
fn sql(f: &Fixture, statement: &str, args: serde_json::Value) -> serde_json::Value {
    let script = "import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); \
        rows=c.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall(); c.commit(); \
        print(json.dumps(rows))";
    let out = std::process::Command::new("python3")
        .args(["-I", "-S", "-B", "-c", script])
        .arg(f.root.join("core.sqlite3"))
        .arg(statement)
        .arg(args.to_string())
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

#[tokio::test]
async fn a_follow_up_never_joins_the_live_window_of_a_held_conversation() {
    let f = fixture().await;
    let holds = Holds::new();
    let chat = f.conversation("live").await;
    let live = f.occupy(&chat, "live").await;
    // The window's task activated it: a follow-up could join it.
    sql(
        &f,
        "UPDATE execution_windows SET state='active' WHERE id=?",
        serde_json::json!([live.window_id.to_string()]),
    );
    let controller = held(&f, &holds, 8);
    controller.queue.swept.store(true, Ordering::Release);
    holds.hold(&chat);
    let mut request = f.request(&chat, "follow-up").await;
    request.window_id = Some(live.window_id);
    request.expected_generation = live.generation;
    let WindowOutcome::Queued(queued) = controller
        .process(BROWSER, &f.owner, &chat, &request)
        .await
        .unwrap()
    else {
        panic!("a held conversation's follow-up must queue, never join")
    };
    assert_eq!(queued.state, QueuedWindowState::Queued);
    controller.queue.wake();
    controller.dispatch_once().await;
    assert_eq!(
        queue_state(&f, &chat, &request).await,
        QueuedWindowState::Queued
    );
    // The input never entered the live window, and no run was admitted.
    assert_eq!(
        sql(
            &f,
            "SELECT (SELECT count(*) FROM execution_window_inputs WHERE event_id=?1),\
             (SELECT count(*) FROM production_runs WHERE event_id=?1)",
            serde_json::json!([request.input_event_id.to_string()]),
        ),
        serde_json::json!([[0, 0]])
    );
    controller.queue.close().await;
}

#[tokio::test]
async fn window_admission_http_answers_202_queued_for_a_held_conversation() {
    use crate::held_inputs::tests::fixture::{headers, state, AUTHORITY, COOKIE};
    use axum::response::IntoResponse;
    use sha2::{Digest, Sha256};
    let f = fixture().await;
    let holds = Holds::new();
    let chat = f.conversation("http").await;
    holds.hold(&chat);
    f.store
        .save_session(&format!("browser:{COOKIE}"), &f.owner)
        .await
        .unwrap();
    let mut app = state(f.store.clone());
    app.window_controller = Some(Arc::new(held(&f, &holds, 8)));
    let mut h = headers(Some(COOKIE), AUTHORITY);
    h.insert("origin", format!("http://{AUTHORITY}").parse().unwrap());
    let csrf = Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{COOKIE}").as_bytes());
    h.insert("x-orkestr-csrf", format!("{csrf:x}").parse().unwrap());
    let request = f.request(&chat, "http-held").await;
    let reply = crate::window_http::admit(
        axum::extract::State(app.clone()),
        h,
        axum::extract::Path(chat.to_string()),
        Ok(axum::Json(request.clone())),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response);
    assert_eq!(reply.status(), axum::http::StatusCode::ACCEPTED);
    assert_eq!(f.windows(&chat).await, 0);
    assert_eq!(
        queue_state(&f, &chat, &request).await,
        QueuedWindowState::Queued
    );
}

#[tokio::test]
async fn a_restarted_process_still_honours_the_hold_and_admits_after_release() {
    let f = fixture().await;
    let holds = Holds::new();
    let chat = f.conversation("restart").await;
    holds.hold(&chat);
    let first = held(&f, &holds, 8);
    let request = f.request(&chat, "before-restart").await;
    assert!(matches!(
        first.process(BROWSER, &f.owner, &chat, &request).await,
        Ok(WindowOutcome::Queued(_))
    ));
    first.queue.close().await;
    // A new process: Core reopened, the same Root directory bound afresh.
    let restarted = Fixture {
        root: f.root.clone(),
        store: Store::open(&f.root.join("core.sqlite3")).await.unwrap(),
        owner: f.owner.clone(),
        home: f.home.clone(),
    };
    let mut second = restarted.controller(8);
    second.config.native_attach = Some(holds.rebind());
    second.queue.remember(BROWSER);
    second.dispatch_once().await;
    assert_eq!(restarted.windows(&chat).await, 0);
    assert_eq!(
        queue_state(&restarted, &chat, &request).await,
        QueuedWindowState::Queued
    );
    holds.release(&chat);
    second.queue.wake();
    second.dispatch_once().await;
    assert_eq!(
        queue_state(&restarted, &chat, &request).await,
        QueuedWindowState::Dispatched
    );
    assert_eq!(restarted.windows(&chat).await, 1);
    second.queue.close().await;
}

#[tokio::test]
async fn a_deploy_drain_counts_a_held_conversation_with_only_queued_intents_as_quiet() {
    let f = fixture().await;
    let holds = Holds::new();
    let chat = f.conversation("drain").await;
    holds.hold(&chat);
    let drain = Arc::new(crate::deploy_drain::DeployDrain::default());
    let mut controller = f.controller(8).with_deploy_drain(drain.clone());
    controller.config.native_attach = Some(holds.holds.clone());
    let request = f.request(&chat, "drain").await;
    assert!(matches!(
        controller.process(BROWSER, &f.owner, &chat, &request).await,
        Ok(WindowOutcome::Queued(_))
    ));
    drain.set(true);
    controller.drain_step().await;
    let status = drain.status();
    assert_eq!((status.unresolved_windows, status.queued_intents), (0, 1));
    assert!(status.drained, "a held conversation never delays a deploy");
    // The drain cut, withdrew or dispatched nothing because of the hold.
    assert_eq!(
        queue_state(&f, &chat, &request).await,
        QueuedWindowState::Queued
    );
    assert_eq!(f.windows(&chat).await, 0);
    drain.set(false);
    controller.queue.close().await;
}

/// A due timer occurrence of `conversation`, admitted by the durable timer
/// controller with its Deep window intent (a `timer-window:` queue row).
async fn timer_intent(f: &Fixture, conversation: &ConversationId) {
    use orkestr_v2_store_sqlite::history_import::timers::{
        authority::DurableTimerEnable, TimerEnableRequest, TimerImportRequest, TimerSchedule,
    };
    const MACHINE: &str = "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef";
    const CREATOR: &str = "browser:synthetic-timer-creator";
    f.store.save_session(MACHINE, &f.owner).await.unwrap();
    f.store.save_session(CREATOR, &f.owner).await.unwrap();
    let bound = f
        .store
        .authorize_supervisor(
            MACHINE,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "synthetic-timer-provider".into(),
                supervisor_key: "timer-controller".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let namespace = Uuid::new_v4();
    f.store
        .import_dormant_timer(
            CREATOR,
            &f.owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "synthetic-source".into(),
                source_timer_id: "synthetic-weekly".into(),
                source_enabled: true,
                schedule: TimerSchedule::Interval {
                    every_ms: 7 * 86_400_000,
                },
            },
        )
        .await
        .unwrap();
    f.store
        .enable_durable_timer(
            CREATOR,
            &f.owner,
            &DurableTimerEnable {
                timer: TimerEnableRequest {
                    namespace,
                    expected_revision: 1,
                    request_key: "synthetic-enable".into(),
                    conversation_id: conversation.clone(),
                },
                instruction: "Synthetic timer instruction".into(),
            },
        )
        .await
        .unwrap();
    sql(
        f,
        "UPDATE dormant_timers SET next_due_ms=next_due_ms-30*86400000 WHERE namespace=?",
        serde_json::json!([namespace.to_string()]),
    );
    let mut timers = crate::timer_http::durable::DurableTimerController::new(bound)
        .with_window_dispatch(Arc::new(|| {}));
    assert_eq!(timers.tick().await.unwrap().admitted, 1);
}

/// Item order and state of a conversation's queue rows, oldest first.
fn rows(f: &Fixture, conversation: &ConversationId) -> Vec<(String, String)> {
    let value = sql(
        f,
        "SELECT request_key,state FROM execution_window_queue WHERE conversation_id=? ORDER BY rowid",
        serde_json::json!([conversation.to_string()]),
    );
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn a_held_timer_intent_and_adapter_input_wait_unwithdrawn_then_dispatch_in_order() {
    let f = fixture().await;
    let holds = Holds::new();
    let chat = f.conversation("timer-held").await;
    holds.hold(&chat);
    let controller = held(&f, &holds, 8);
    // A timer comes due and an adapter input arrives while the owner's
    // terminal holds the chat: both are durable intents, neither runs.
    timer_intent(&f, &chat).await;
    let adapter = f.request(&chat, "adapter-while-held").await;
    assert!(matches!(
        controller.process(BROWSER, &f.owner, &chat, &adapter).await,
        Ok(WindowOutcome::Queued(_))
    ));
    let queued = rows(&f, &chat);
    assert_eq!(queued.len(), 2);
    assert!(queued[0].0.starts_with("timer"), "{queued:?}");
    assert_eq!(queued[1].0, adapter.request_key);
    for _ in 0..3 {
        controller.queue.wake();
        controller.dispatch_once().await;
    }
    assert_eq!(f.windows(&chat).await, 0);
    assert!(queued.iter().all(|(_, state)| state == "queued"));
    assert_eq!(rows(&f, &chat), queued, "never withdrawn while held");
    // Released: the timer's intent opens the window first; the adapter input
    // keeps its place behind it. Nothing is withdrawn.
    holds.release(&chat);
    controller.queue.wake();
    controller.dispatch_once().await;
    let states: Vec<_> = rows(&f, &chat)
        .into_iter()
        .map(|(_, state)| state)
        .collect();
    assert_eq!(states, vec!["dispatched", "queued"]);
    assert_eq!(f.windows(&chat).await, 1);
    controller.queue.close().await;
}
