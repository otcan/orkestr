use super::super::tests::{setup, Case};
use super::super::thread_asks::tests::{asking_turn, conversation};
use super::*;
use crate::history_import::timers::{TimerImportRequest, TimerTarget};
use orkestr_v2_contracts::{AgentTimerOperation, AgentTimerSchedule};

const DAY: i64 = 86_400_000;

async fn grant(f: &Case, c: &ConversationId) -> String {
    f.store
        .issue_agent_timer_grant(&f.token, &f.owner, c)
        .await
        .unwrap()
        .grant
}
fn once(key: &str, due_ms: i64) -> AgentTimerCreate {
    AgentTimerCreate {
        request_key: key.into(),
        label: format!("Reminder {key}"),
        schedule: AgentTimerSchedule::Once { due_ms },
        text: format!("Remind the owner about {key}."),
    }
}
fn daily(key: &str, minutes: Vec<u8>, start: u16, end: u16) -> AgentTimerCreate {
    AgentTimerCreate {
        request_key: key.into(),
        label: format!("Daily {key}"),
        schedule: AgentTimerSchedule::Calendar {
            timezone: "Europe/Berlin".into(),
            weekdays: vec![],
            start_minute: start,
            end_minute: end,
            every_hours: 1,
            minutes,
        },
        text: "Daily check.".into(),
    }
}
fn control(key: &str, operation: AgentTimerOperation, until_ms: Option<i64>) -> AgentTimerControl {
    AgentTimerControl {
        request_key: key.into(),
        operation,
        until_ms,
    }
}
fn refused(code: &'static str) -> R<AgentTimerReceipt> {
    Err(ResourceError::Conflict(code))
}
/// An owner-created timer of `c` (like biofuture's imported CHECK timer).
async fn owner_timer(f: &Case, c: &ConversationId, id: &str) -> Uuid {
    let namespace = Uuid::new_v4();
    let receipt = f
        .store
        .import_dormant_timer_for(
            &f.token,
            &f.owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "synthetic-v1".into(),
                source_timer_id: id.into(),
                source_enabled: true,
                schedule: TimerSchedule::Interval {
                    every_ms: 3_600_000,
                },
            },
            &TimerTarget {
                conversation_id: c.clone(),
                label: format!("Owner {id}"),
                source_thread_id: "synthetic-thread".into(),
            },
        )
        .await
        .unwrap();
    f.store
        .enable_durable_timer(
            &f.token,
            &f.owner,
            &crate::history_import::timers::authority::DurableTimerEnable {
                timer: crate::history_import::timers::TimerEnableRequest {
                    namespace,
                    expected_revision: receipt.revision,
                    request_key: format!("enable-{id}"),
                    conversation_id: c.clone(),
                },
                instruction: "Owner check".into(),
            },
        )
        .await
        .unwrap();
    namespace
}

#[tokio::test]
async fn grant_lifecycle_and_scope() {
    let f = setup().await;
    let c = f.conversation.clone();
    let other = conversation(&f, "Other").await;
    // No grant: unauthorized, and nothing is audited.
    assert_eq!(
        f.store.agent_timers(&"0".repeat(64), &c).await,
        Err(ResourceError::Unauthorized)
    );
    let first = grant(&f, &c).await;
    let read = f
        .store
        .agent_timer_grant(&f.token, &f.owner, &c)
        .await
        .unwrap();
    assert!(read.issued && read.generation == 1);
    // A grant only works for its own conversation.
    assert_eq!(
        f.store.agent_timers(&first, &other).await,
        Err(ResourceError::Unauthorized)
    );
    // Without a running Deep turn the grant does nothing.
    assert_eq!(
        f.store.agent_timers(&first, &c).await,
        Err(ResourceError::Conflict("agent_timer_no_running_turn"))
    );
    assert_eq!(
        f.store
            .create_agent_timer(&first, &c, &once("idle", now_ms() + DAY))
            .await,
        refused("agent_timer_no_running_turn")
    );
    // Rotation invalidates the old grant; revocation invalidates all.
    let second = grant(&f, &c).await;
    asking_turn(&f, &c, "turn").await;
    assert_eq!(
        f.store.agent_timers(&first, &c).await,
        Err(ResourceError::Unauthorized)
    );
    assert!(f.store.agent_timers(&second, &c).await.is_ok());
    let revoked = f
        .store
        .revoke_agent_timer_grant(&f.token, &f.owner, &c)
        .await
        .unwrap();
    assert!(!revoked.issued && revoked.generation == 2);
    assert_eq!(
        f.store.agent_timers(&second, &c).await,
        Err(ResourceError::Unauthorized)
    );
    // A thread-ask grant is not a timer grant.
    let ask = f
        .store
        .issue_thread_ask_grant(&f.token, &f.owner, &c, &Default::default())
        .await
        .unwrap()
        .grant;
    assert_eq!(
        f.store.agent_timers(&ask, &c).await,
        Err(ResourceError::Unauthorized)
    );
    let directory = f
        .store
        .agent_timer_grant_directory(&f.token, &f.owner)
        .await
        .unwrap();
    assert_eq!(directory.conversations.len(), 2);
    assert!(directory.conversations.iter().all(|e| e.eligible));
    let outcomes = f
        .store
        .agent_timer_audit_outcomes(&f.owner, &c)
        .await
        .unwrap();
    assert_eq!(
        outcomes,
        vec![(
            "create".to_owned(),
            "agent_timer_no_running_turn".to_owned()
        )]
    );
}

#[tokio::test]
async fn create_runs_only_in_the_grant_conversation_and_replays() {
    let f = setup().await;
    let c = f.conversation.clone();
    let other = conversation(&f, "Other").await;
    let g = grant(&f, &c).await;
    asking_turn(&f, &c, "turn").await;
    let due = now_ms() + DAY;
    let created = f
        .store
        .create_agent_timer(&g, &c, &once("biocytogen", due))
        .await
        .unwrap();
    assert!(created.changed);
    assert_eq!(created.timer.state, "enabled");
    assert_eq!(created.timer.next_due_ms, Some(due));
    assert!(created.timer.created_by_agent);
    assert_eq!(created.timer.label.as_deref(), Some("Reminder biocytogen"));
    // Mapped to the grant's conversation only, with an attributed instruction.
    let mine = f
        .store
        .conversation_timers(&f.token, &f.owner, &c)
        .await
        .unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(
        mine[0].detail.conversation_id.as_ref(),
        Some(&c),
        "enabled in the grant's conversation"
    );
    assert!(f
        .store
        .conversation_timers(&f.token, &f.owner, &other)
        .await
        .unwrap()
        .is_empty());
    let instruction: String =
        sqlx::query_scalar("SELECT instruction FROM durable_timer_authorities WHERE namespace=?")
            .bind(created.timer.namespace.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert!(instruction
        .starts_with("[Orkestr timer \"Reminder biocytogen\", set by this thread's agent"));
    assert!(instruction.ends_with("Remind the owner about biocytogen."));
    // The same key and body replays; another body under the key conflicts.
    let replay = f
        .store
        .create_agent_timer(&g, &c, &once("biocytogen", due))
        .await
        .unwrap();
    assert!(!replay.changed);
    assert_eq!(replay.timer.namespace, created.timer.namespace);
    assert_eq!(
        f.store
            .create_agent_timer(&g, &c, &once("biocytogen", due + 60_000))
            .await,
        refused("agent_timer_conflict")
    );
    let listed = f.store.agent_timers(&g, &c).await.unwrap();
    assert_eq!(listed.timers.len(), 1);
    // Another conversation's grant sees none of it, and cannot touch it.
    let og = grant(&f, &other).await;
    asking_turn(&f, &other, "other-turn").await;
    assert!(f
        .store
        .agent_timers(&og, &other)
        .await
        .unwrap()
        .timers
        .is_empty());
    assert_eq!(
        f.store
            .control_agent_timer(
                &og,
                &other,
                created.timer.namespace,
                &control("x", AgentTimerOperation::Cancel, None)
            )
            .await,
        refused("agent_timer_not_found")
    );
    assert_eq!(
        f.store
            .conversation_timers(&f.token, &f.owner, &c)
            .await
            .unwrap()[0]
            .detail
            .receipt
            .state,
        TimerState::Enabled
    );
    // The audit is append-only.
    assert!(sqlx::query("UPDATE agent_timer_audit SET outcome='x'")
        .execute(&f.store.pool)
        .await
        .is_err());
    assert!(sqlx::query("DELETE FROM agent_timers")
        .execute(&f.store.pool)
        .await
        .is_err());
}

#[tokio::test]
async fn caps_refuse_bad_schedules_and_floods() {
    let f = setup().await;
    let c = f.conversation.clone();
    let g = grant(&f, &c).await;
    asking_turn(&f, &c, "turn").await;
    let now = now_ms();
    for (request, code) in [
        (once("soon", now + 30_000), "agent_timer_too_soon"),
        (once("past", now - DAY), "agent_timer_too_soon"),
        (once("far", now + 500 * DAY), "agent_timer_too_far"),
        (
            daily("quarter", vec![0, 15, 30, 45], 480, 1080),
            "agent_timer_too_frequent",
        ),
    ] {
        assert_eq!(
            f.store.create_agent_timer(&g, &c, &request).await,
            refused(code)
        );
    }
    // Every 30 minutes is the floor; a daily rule is fine.
    assert!(
        f.store
            .create_agent_timer(&g, &c, &daily("half", vec![0, 30], 480, 1080))
            .await
            .unwrap()
            .changed
    );
    for i in 1..AGENT_TIMER_HOURLY_CREATES_MAX {
        f.store
            .create_agent_timer(&g, &c, &once(&format!("r{i}"), now + DAY + i))
            .await
            .unwrap();
    }
    assert_eq!(
        f.store
            .create_agent_timer(&g, &c, &once("one-too-many", now + 2 * DAY))
            .await,
        refused("agent_timer_rate_limited")
    );
    // A replay is never rate limited.
    assert!(
        !f.store
            .create_agent_timer(&g, &c, &once("r1", now + DAY + 1))
            .await
            .unwrap()
            .changed
    );
}

#[tokio::test]
async fn live_timer_cap_counts_only_live_agent_timers() {
    let f = setup().await;
    let c = f.conversation.clone();
    let g = grant(&f, &c).await;
    asking_turn(&f, &c, "turn").await;
    let mut conn = f.store.pool.acquire().await.unwrap();
    let (run, _) = running_deep(&mut conn, &f.owner, &c)
        .await
        .unwrap()
        .unwrap();
    drop(conn);
    // Fill the cap through the Core step itself (bypassing the hourly cap).
    let mut tx = f.store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    for i in 0..AGENT_TIMER_ACTIVE_MAX {
        let key = format!("cap{i}");
        agent_timer_create(
            &mut tx,
            &f.owner,
            &c,
            &AgentTimerNew {
                namespace: agent_namespace(&f.owner, &c, &key),
                label: "Cap",
                schedule: TimerSchedule::Once {
                    due_ms: now_ms() + DAY,
                },
                instruction: "cap".into(),
                request_key: &key,
                request_digest: &"0".repeat(64),
                run_id: &run,
                grant_generation: 1,
            },
        )
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    assert_eq!(
        f.store
            .create_agent_timer(&g, &c, &once("over", now_ms() + DAY))
            .await,
        refused("agent_timer_limit_reached")
    );
    // A cancelled one frees its slot (owner-created timers never count).
    owner_timer(&f, &c, "check").await;
    let first = agent_namespace(&f.owner, &c, "cap0");
    f.store
        .control_agent_timer(
            &g,
            &c,
            first,
            &control("c0", AgentTimerOperation::Cancel, None),
        )
        .await
        .unwrap();
    assert!(f
        .store
        .create_agent_timer(&g, &c, &once("over", now_ms() + DAY))
        .await
        .is_err_and(|e| e == ResourceError::Conflict("agent_timer_rate_limited")));
}

#[tokio::test]
async fn cancel_pause_resume_and_skip_own_timers() {
    let f = setup().await;
    let c = f.conversation.clone();
    let g = grant(&f, &c).await;
    asking_turn(&f, &c, "turn").await;
    // The owner's (imported) check timer of this conversation can be paused
    // by its agent, like biofuture's CHECK timer after its end date.
    let check = owner_timer(&f, &c, "check").await;
    let now = now_ms();
    let paused = f
        .store
        .control_agent_timer(
            &g,
            &c,
            check,
            &control("p1", AgentTimerOperation::Pause, Some(now + DAY)),
        )
        .await
        .unwrap();
    assert!(paused.changed && !paused.timer.created_by_agent);
    assert_eq!(paused.timer.pause_until_ms, Some(now + DAY));
    assert!(paused.timer.next_due_ms.unwrap() >= now + DAY);
    assert_eq!(
        f.store
            .control_agent_timer(
                &g,
                &c,
                check,
                &control("p2", AgentTimerOperation::Pause, Some(now + 61 * DAY))
            )
            .await,
        refused("agent_timer_pause_invalid")
    );
    let resumed = f
        .store
        .control_agent_timer(
            &g,
            &c,
            check,
            &control("r1", AgentTimerOperation::Resume, None),
        )
        .await
        .unwrap();
    assert!(resumed.changed && resumed.timer.pause_until_ms.is_none());
    assert!(
        !f.store
            .control_agent_timer(
                &g,
                &c,
                check,
                &control("r2", AgentTimerOperation::Resume, None)
            )
            .await
            .unwrap()
            .changed
    );
    // Skip the next run of a recurring timer: the one after it is next.
    let before = resumed.timer.next_due_ms.unwrap();
    let skipped = f
        .store
        .control_agent_timer(
            &g,
            &c,
            check,
            &control("s1", AgentTimerOperation::SkipNext, None),
        )
        .await
        .unwrap();
    assert!(skipped.timer.next_due_ms.unwrap() > before);
    assert_eq!(skipped.timer.pause_until_ms, Some(before + 1));
    // A retried skip with the same key never skips a second run.
    let retried = f
        .store
        .control_agent_timer(
            &g,
            &c,
            check,
            &control("s1", AgentTimerOperation::SkipNext, None),
        )
        .await
        .unwrap();
    assert!(!retried.changed);
    assert_eq!(retried.timer.next_due_ms, skipped.timer.next_due_ms);
    // A one-shot reminder cannot be skipped, only cancelled.
    let reminder = f
        .store
        .create_agent_timer(&g, &c, &once("k2", now + DAY))
        .await
        .unwrap()
        .timer
        .namespace;
    assert_eq!(
        f.store
            .control_agent_timer(
                &g,
                &c,
                reminder,
                &control("s2", AgentTimerOperation::SkipNext, None)
            )
            .await,
        refused("agent_timer_skip_once")
    );
    let cancelled = f
        .store
        .control_agent_timer(
            &g,
            &c,
            reminder,
            &control("c1", AgentTimerOperation::Cancel, None),
        )
        .await
        .unwrap();
    assert!(cancelled.changed);
    assert_eq!(cancelled.timer.state, "disabled");
    assert_eq!(cancelled.timer.next_due_ms, None);
    assert!(
        !f.store
            .control_agent_timer(
                &g,
                &c,
                reminder,
                &control("c2", AgentTimerOperation::Cancel, None)
            )
            .await
            .unwrap()
            .changed
    );
    assert_eq!(
        f.store
            .control_agent_timer(
                &g,
                &c,
                reminder,
                &control("p3", AgentTimerOperation::Pause, None)
            )
            .await,
        refused("agent_timer_ended")
    );
    // An unknown namespace is not found; the attempt is audited.
    assert_eq!(
        f.store
            .control_agent_timer(
                &g,
                &c,
                Uuid::new_v4(),
                &control("x", AgentTimerOperation::Cancel, None)
            )
            .await,
        refused("agent_timer_not_found")
    );
    let outcomes = f
        .store
        .agent_timer_audit_outcomes(&f.owner, &c)
        .await
        .unwrap();
    assert_eq!(
        outcomes[0],
        ("cancel".into(), "agent_timer_not_found".into())
    );
    assert!(outcomes.contains(&("skip_next".into(), "accepted".into())));
    assert!(outcomes.contains(&("cancel".into(), "replayed".into())));
}

#[tokio::test]
async fn refusals_are_throttled_without_writes() {
    let f = setup().await;
    let c = f.conversation.clone();
    let g = grant(&f, &c).await;
    // No running turn: each attempt is a refusal, audited up to the budget.
    for i in 0..AGENT_TIMER_REFUSALS_MAX {
        assert_eq!(
            f.store
                .create_agent_timer(&g, &c, &once(&format!("n{i}"), now_ms() + DAY))
                .await,
            refused("agent_timer_no_running_turn")
        );
    }
    assert_eq!(
        f.store
            .create_agent_timer(&g, &c, &once("over", now_ms() + DAY))
            .await,
        refused("agent_timer_rate_limited")
    );
    let audited = f
        .store
        .agent_timer_audit_outcomes(&f.owner, &c)
        .await
        .unwrap();
    assert_eq!(audited.len() as i64, AGENT_TIMER_REFUSALS_MAX);
}
