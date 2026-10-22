use super::*;
use crate::history_import::timers::{authority::DurableTimerEnable, *};
use crate::production_runtime::tests::{config, ready, setup, Case};
use orkestr_v2_contracts::{ConversationId, ExecutionWindowRequest};

async fn enabled(f: &Case, schedule: TimerSchedule, key: &str) -> Uuid {
    let namespace = Uuid::new_v4();
    f.store
        .import_dormant_timer_for(
            &f.token,
            &f.owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "synthetic-v1".into(),
                source_timer_id: format!("timer-{key}"),
                source_enabled: true,
                schedule,
            },
            &TimerTarget {
                conversation_id: f.conversation.clone(),
                label: format!("Synthetic {key}"),
                source_thread_id: "synthetic-thread".into(),
            },
        )
        .await
        .unwrap();
    f.store
        .enable_durable_timer(
            &f.token,
            &f.owner,
            &DurableTimerEnable {
                timer: TimerEnableRequest {
                    namespace,
                    expected_revision: 1,
                    request_key: format!("enable-{key}"),
                    conversation_id: f.conversation.clone(),
                },
                instruction: format!("Synthetic scheduled task {key}"),
            },
        )
        .await
        .unwrap();
    namespace
}
/// Moves the stored next occurrence into the past, as after downtime.
async fn overdue(f: &Case, namespace: Uuid, missed_ms: i64) {
    sqlx::query("UPDATE dormant_timers SET next_due_ms=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)-? WHERE namespace=?")
        .bind(missed_ms)
        .bind(namespace.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
}
async fn count(f: &Case, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn many_missed_runs_coalesce_into_one_queued_deep_turn() {
    let f = setup().await;
    let every = 60_000;
    let namespace = enabled(&f, TimerSchedule::Interval { every_ms: every }, "missed").await;
    assert!(f
        .handle
        .due_timer_scheduler_candidates(None, 32)
        .await
        .unwrap()
        .is_empty());
    // A thousand missed minutes.
    overdue(&f, namespace, 1000 * every).await;
    assert_eq!(
        f.handle
            .due_timer_scheduler_candidates(None, 32)
            .await
            .unwrap(),
        vec![namespace]
    );
    let issuer = f.handle.authorize_timer_scheduler(namespace).await.unwrap();
    let receipt = f
        .handle
        .admit_authorized_timer_turn(&issuer, namespace, true)
        .await
        .unwrap();
    assert!(!receipt.duplicate);
    // Exactly one occurrence; the next one is computed from now, not replayed.
    assert!(f
        .handle
        .due_timer_scheduler_candidates(None, 32)
        .await
        .unwrap()
        .is_empty());
    assert!(f
        .handle
        .admit_authorized_timer_turn(&issuer, namespace, true)
        .await
        .is_err());
    assert_eq!(
        count(&f, "SELECT count(*) FROM dormant_timer_inputs").await,
        1
    );
    let queued: (String, String, String) =
        sqlx::query_as("SELECT request_key,input_request_key,state FROM execution_window_queue")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(
        queued.0,
        format!("timer-window:{}", receipt.input.event_id.0)
    );
    assert_eq!(queued.1, format!("timer:{}", receipt.claim.claim_id));
    assert_eq!(queued.2, "queued");
    let inputs = f
        .store
        .conversation_timer_inputs(&f.token, &f.owner, &f.conversation, 0, 10)
        .await
        .unwrap();
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0].namespace, namespace);
    assert_eq!(inputs[0].request_key, queued.1);
    assert_eq!(inputs[0].window.as_deref(), Some("queued"));
    assert_eq!(inputs[0].label.as_deref(), Some("Synthetic missed"));
    assert!(!inputs[0].held);
    assert!(f
        .store
        .conversation_timer_inputs(&f.token, &f.owner, &f.conversation, inputs[0].sequence, 10)
        .await
        .unwrap()
        .is_empty());
    // Disabling holds the outstanding occurrence; it will never execute.
    f.store
        .revoke_durable_timer(&f.token, &f.owner, namespace, 2, "disable".into())
        .await
        .unwrap();
    let inputs = f
        .store
        .conversation_timer_inputs(&f.token, &f.owner, &f.conversation, 0, 10)
        .await
        .unwrap();
    assert!(inputs[0].held);
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test]
async fn overlapping_ticks_admit_one_occurrence() {
    let f = setup().await;
    let namespace = enabled(
        &f,
        TimerSchedule::Interval {
            every_ms: 3_600_000,
        },
        "overlap",
    )
    .await;
    overdue(&f, namespace, 5_000).await;
    let first = f.handle.authorize_timer_scheduler(namespace).await.unwrap();
    let second = f.handle.authorize_timer_scheduler(namespace).await.unwrap();
    let (a, b) = tokio::join!(
        f.handle
            .admit_authorized_timer_turn(&first, namespace, true),
        f.handle
            .admit_authorized_timer_turn(&second, namespace, true),
    );
    assert_eq!(
        [a.is_ok(), b.is_ok()].iter().filter(|ok| **ok).count(),
        1,
        "exactly one tick wins"
    );
    assert_eq!(
        count(&f, "SELECT count(*) FROM dormant_timer_inputs").await,
        1
    );
    assert_eq!(count(&f, "SELECT count(*) FROM messages").await, 1);
    assert_eq!(
        count(&f, "SELECT count(*) FROM execution_window_queue").await,
        1
    );
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test]
async fn paused_disabled_and_unqueued_modes_create_no_window_intent() {
    let f = setup().await;
    // Imported but never enabled: dormant, never a candidate.
    let paused = Uuid::new_v4();
    f.store
        .import_dormant_timer_for(
            &f.token,
            &f.owner,
            &TimerImportRequest {
                namespace: paused,
                source_namespace: "synthetic-v1".into(),
                source_timer_id: "paused".into(),
                source_enabled: true,
                schedule: TimerSchedule::Interval { every_ms: 60_000 },
            },
            &TimerTarget {
                conversation_id: f.conversation.clone(),
                label: "Paused".into(),
                source_thread_id: "synthetic-thread".into(),
            },
        )
        .await
        .unwrap();
    let disabled = enabled(&f, TimerSchedule::Interval { every_ms: 60_000 }, "disabled").await;
    f.store
        .revoke_durable_timer(&f.token, &f.owner, disabled, 2, "off".into())
        .await
        .unwrap();
    overdue(&f, disabled, 600_000).await;
    assert!(f
        .handle
        .due_timer_scheduler_candidates(None, 32)
        .await
        .unwrap()
        .is_empty());
    let ordinary = enabled(&f, TimerSchedule::Interval { every_ms: 60_000 }, "ordinary").await;
    overdue(&f, ordinary, 1).await;
    let issuer = f.handle.authorize_timer_scheduler(ordinary).await.unwrap();
    f.handle
        .admit_authorized_timer_turn(&issuer, ordinary, false)
        .await
        .unwrap();
    assert_eq!(
        count(&f, "SELECT count(*) FROM dormant_timer_inputs").await,
        1
    );
    assert_eq!(
        count(&f, "SELECT count(*) FROM execution_window_queue").await,
        0
    );
    let listing = f
        .store
        .conversation_timers(&f.token, &f.owner, &f.conversation)
        .await
        .unwrap();
    let states: Vec<_> = listing
        .iter()
        .map(|t| {
            (
                t.label.clone().unwrap(),
                t.detail.receipt.state,
                t.source_enabled,
            )
        })
        .collect();
    assert_eq!(
        states,
        vec![
            ("Paused".into(), TimerState::Paused, true),
            ("Synthetic disabled".into(), TimerState::Disabled, true),
            ("Synthetic ordinary".into(), TimerState::Enabled, true),
        ]
    );
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test]
async fn mapping_is_immutable_and_enable_must_target_it() {
    let f = setup().await;
    let namespace = Uuid::new_v4();
    let request = TimerImportRequest {
        namespace,
        source_namespace: "synthetic-v1".into(),
        source_timer_id: "mapped".into(),
        source_enabled: false,
        schedule: TimerSchedule::ZonedClock {
            timezone: "Europe/Berlin".into(),
            weekday: Some(5),
            minute_of_day: 1205,
        },
    };
    let target = TimerTarget {
        conversation_id: f.conversation.clone(),
        label: "Weekly review".into(),
        source_thread_id: "synthetic-thread".into(),
    };
    let first = f
        .store
        .import_dormant_timer_for(&f.token, &f.owner, &request, &target)
        .await
        .unwrap();
    let replay = f
        .store
        .import_dormant_timer_for(&f.token, &f.owner, &request, &target)
        .await
        .unwrap();
    assert_eq!(first, replay);
    assert_eq!(first.state, TimerState::Paused);
    let other = ConversationId(Uuid::new_v4());
    sqlx::query("INSERT INTO conversations(id,owner_id,standalone) VALUES(?,?,1)")
        .bind(other.to_string())
        .bind(f.owner.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    for changed in [
        TimerTarget {
            label: "Renamed".into(),
            ..target.clone()
        },
        TimerTarget {
            conversation_id: other.clone(),
            ..target.clone()
        },
    ] {
        assert!(matches!(
            f.store
                .import_dormant_timer_for(&f.token, &f.owner, &request, &changed)
                .await,
            Err(HistoryError::Conflict)
        ));
    }
    let enable = |conversation: ConversationId| DurableTimerEnable {
        timer: TimerEnableRequest {
            namespace,
            expected_revision: 1,
            request_key: format!("enable-{}", conversation.0),
            conversation_id: conversation,
        },
        instruction: "Synthetic weekly review".into(),
    };
    assert!(matches!(
        f.store
            .enable_durable_timer(&f.token, &f.owner, &enable(other))
            .await,
        Err(HistoryError::Conflict)
    ));
    let granted = f
        .store
        .enable_durable_timer(&f.token, &f.owner, &enable(f.conversation.clone()))
        .await
        .unwrap();
    assert_eq!(granted.conversation_id, f.conversation);
    let detail = f
        .store
        .dormant_timer_detail(&f.token, &f.owner, namespace)
        .await
        .unwrap();
    // Friday 20:05 Berlin, strictly in the future.
    let due = detail.receipt.next_due_ms.unwrap();
    let local = jiff::Timestamp::from_millisecond(due)
        .unwrap()
        .to_zoned(jiff::tz::TimeZone::get("Europe/Berlin").unwrap());
    assert_eq!(
        (
            local.weekday().to_monday_one_offset(),
            local.hour(),
            local.minute()
        ),
        (5, 20, 5)
    );
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test]
async fn fast_presentation_of_a_timer_never_carries_its_instructions() {
    let f = setup().await;
    let roles = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap();
    let fast = f
        .handle
        .confirm_native_session(NativeSessionConfirmation {
            session_id: roles.fast.session_id,
            expected_generation: roles.fast.generation,
            native_session_id: "synthetic-native-fast".into(),
            protocol_version: "codex-rpc-1".into(),
            source_event_key: "fast-ready:1".into(),
        })
        .await
        .unwrap();
    use orkestr_v2_application::IntakeStore;
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &orkestr_v2_contracts::MessageInput {
                client_message_id: "timer:synthetic-claim".into(),
                text: "Synthetic scheduled task with side effects".into(),
            },
        )
        .await
        .unwrap();
    let row = sqlx::query(
        "SELECT id,message_id,sequence FROM events WHERE conversation_id=? AND kind='message_accepted'",
    )
    .bind(f.conversation.to_string())
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    let (event, message): (String, String) = (row.get("id"), row.get("message_id"));
    // Mark it as a timer occurrence (provenance rows elided for this unit).
    let mut connection = f.store.pool.acquire().await.unwrap();
    sqlx::query("PRAGMA foreign_keys=OFF")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO dormant_timer_inputs(claim_id,owner_id,namespace,generation,input_digest,message_id,event_id,scope_sequence) VALUES(?,?,?,1,?,?,?,?)")
        .bind(Uuid::new_v4().to_string()).bind(f.owner.to_string()).bind(Uuid::new_v4().to_string())
        .bind("0".repeat(64)).bind(&message).bind(&event).bind(row.get::<i64, _>("sequence"))
        .execute(&mut *connection).await.unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut *connection)
        .await
        .unwrap();
    drop(connection);
    let admitted = f
        .handle
        .admit_fast(
            &f.token,
            &FastAdmissionInput {
                source_message_id: orkestr_v2_contracts::MessageId(message.parse().unwrap()),
                source_event_id: orkestr_v2_contracts::EventId(event.parse().unwrap()),
                fast_binding_id: fast.session_id,
                expected_binding_generation: fast.generation,
                request_key: "fast-timer-text".into(),
            },
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reserved) = f
        .handle
        .claim_provider_dispatch(&admitted, "fast-timer-text")
        .await
        .unwrap()
    else {
        panic!("fast dispatch not reserved")
    };
    let ExecutionConsumption::Dispatch(capability) =
        f.handle.consume_execution(&reserved).await.unwrap()
    else {
        panic!("fast dispatch not consumed")
    };
    assert_eq!(capability.text(), super::dispatch::FAST_TIMER_TEXT);
    assert!(!capability.text().contains("side effects"));
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

/// The opener lost the window before any run: a fresh process marks it
/// uncertain past its deadline and closes it as a failed open.
async fn fail_open(
    f: &Case,
    browser: &str,
    window: Uuid,
    generation: u64,
) -> orkestr_v2_contracts::ExecutionWindowReconciliation {
    use orkestr_v2_contracts::{
        ExecutionWindowReconciliationActor as Actor,
        ExecutionWindowReconciliationDecision as Decision,
    };
    sqlx::query("UPDATE execution_windows SET opened_at_ms=opened_at_ms-900001,work_deadline_ms=work_deadline_ms-900001,expires_at_ms=expires_at_ms-900001 WHERE id=?")
        .bind(window.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    let fresh = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    fresh
        .reconcile_execution_window_authenticated(browser, &f.conversation, window, generation)
        .await
        .unwrap();
    let StrandedExecutionWindow::Pending(plan) = fresh
        .plan_stranded_execution_window_authenticated(
            browser,
            &f.conversation,
            window,
            generation,
            Decision::AbandonUnaccepted,
            Actor::Startup,
        )
        .await
        .unwrap()
    else {
        panic!("a failed open must plan")
    };
    fresh
        .reconcile_stranded_execution_window_authenticated(
            browser,
            &plan,
            Decision::AbandonUnaccepted,
            Actor::Startup,
        )
        .await
        .unwrap()
}

async fn queue_row(f: &Case) -> (String, Option<String>) {
    sqlx::query_as("SELECT state,window_id FROM execution_window_queue")
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}

/// Production 04:43Z/05:43Z: a timer window failed to open (its Fast
/// companion never became ready) and the occurrence was written off. Nothing
/// of it ran, so its Deep intent is queued again, exactly once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_timer_whose_window_failed_to_open_is_retried_once() {
    use orkestr_v2_contracts::ExecutionWindowOpenFailureCause as Cause;
    let f = setup().await;
    let browser = "synthetic-browser-timer-retry";
    f.store.save_session(browser, &f.owner).await.unwrap();
    ready(&f).await;
    let namespace = enabled(&f, TimerSchedule::Interval { every_ms: 60_000 }, "retry").await;
    overdue(&f, namespace, 1).await;
    let issuer = f.handle.authorize_timer_scheduler(namespace).await.unwrap();
    let timer = f
        .handle
        .admit_authorized_timer_turn(&issuer, namespace, true)
        .await
        .unwrap();
    let event = timer.input.event_id.clone();
    // Exactly what the server's queue dispatcher admits for the intent.
    let request = |generation: u64, predecessor: Option<Uuid>| ExecutionWindowRequest {
        request_key: format!("timer-window:{}", event.0),
        input_message_id: timer.input.message_id.clone(),
        input_event_id: event.clone(),
        input_request_key: format!("timer:{}", timer.claim.claim_id),
        expected_generation: generation,
        window_id: None,
        predecessor_window_id: predecessor,
    };
    let first = f
        .store
        .admit_execution_window_authenticated(browser, &f.conversation, &request(0, None))
        .await
        .unwrap()
        .status;
    assert_eq!(
        queue_row(&f).await,
        ("dispatched".into(), Some(first.window_id.to_string()))
    );
    let credential = f
        .handle
        .issue_execution_window_credential(
            &f.token,
            first.window_id,
            1,
            "timer-retry-boot",
            first.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    f.handle
        .bind_execution_window(&f.token, &credential)
        .await
        .unwrap();
    // Setup fails before any run; the window is closed as a failed open.
    let failed = fail_open(&f, browser, first.window_id, 1).await;
    assert_eq!(failed.open_failure_cause, Some(Cause::SetupIncomplete));
    assert_eq!(failed.released_input_event_ids, vec![event.clone()]);
    assert_eq!(queue_row(&f).await, ("queued".into(), None));
    let listed = f
        .store
        .conversation_timer_inputs(browser, &f.owner, &f.conversation, 0, 10)
        .await
        .unwrap();
    assert_eq!(listed[0].window.as_deref(), Some("queued"));
    // The dispatcher opens the next window for the same occurrence.
    let fresh = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let bootstrap = fresh
        .rebootstrap_execution_window_authenticated(
            browser,
            &f.conversation,
            config(ProductionTakeover::First),
        )
        .await
        .unwrap();
    let second = fresh
        .admit_execution_window_authenticated(
            browser,
            &f.conversation,
            &request(1, Some(first.window_id)),
        )
        .await
        .unwrap()
        .status;
    assert_eq!(second.generation, 2);
    assert_eq!(
        queue_row(&f).await,
        ("dispatched".into(), Some(second.window_id.to_string()))
    );
    let grant = bootstrap
        .store()
        .issue_execution_window_credential(
            bootstrap.credential(),
            second.window_id,
            2,
            "timer-retry-boot-2",
            second.expires_at_ms,
            &"d".repeat(64),
        )
        .await
        .unwrap();
    bootstrap
        .store()
        .bind_execution_window(bootstrap.credential(), &grant)
        .await
        .unwrap();
    // The retry fails to open too: it is still closed and released (one
    // archive row per failure), but never queued a third time.
    let again = fail_open(&f, browser, second.window_id, 2).await;
    assert_eq!(again.open_failure_cause, Some(Cause::SetupIncomplete));
    assert_eq!(again.released_input_event_ids, vec![event.clone()]);
    assert_eq!(
        queue_row(&f).await,
        ("dispatched".into(), Some(second.window_id.to_string()))
    );
    assert_eq!(
        count(
            &f,
            "SELECT count(*) FROM execution_window_open_failure_inputs"
        )
        .await,
        2
    );
    // Nothing ever ran for it: no run of any role exists.
    assert_eq!(count(&f, "SELECT count(*) FROM production_runs").await, 0);
}

/// A user input released by a failed open is never queued again by Core:
/// its sender (the adapter or the browser) decides.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_open_requeues_only_timer_occurrences() {
    use orkestr_v2_application::IntakeStore;
    use orkestr_v2_contracts::MessageInput;
    let f = setup().await;
    let browser = "synthetic-browser-user-open";
    f.store.save_session(browser, &f.owner).await.unwrap();
    ready(&f).await;
    let receipt = f
        .store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "user-open".into(),
                text: "synthetic user input".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let request = ExecutionWindowRequest {
        request_key: "window:user-open".into(),
        input_message_id: receipt.message_id,
        input_event_id: receipt.event_id,
        input_request_key: "user-open".into(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    };
    f.store
        .enqueue_execution_window_authenticated(browser, &f.conversation, &request)
        .await
        .unwrap();
    let first = f
        .store
        .admit_execution_window_authenticated(browser, &f.conversation, &request)
        .await
        .unwrap()
        .status;
    let credential = f
        .handle
        .issue_execution_window_credential(
            &f.token,
            first.window_id,
            1,
            "user-open-boot",
            first.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    f.handle
        .bind_execution_window(&f.token, &credential)
        .await
        .unwrap();
    fail_open(&f, browser, first.window_id, 1).await;
    assert_eq!(
        queue_row(&f).await,
        ("dispatched".into(), Some(first.window_id.to_string()))
    );
}
