use super::super::tests::{setup, Case};
use super::super::thread_asks::tests::{asking_turn, conversation, next_turn};
use super::*;
use crate::history_import::timers::{TimerImportRequest, TimerTarget};
use orkestr_v2_contracts::{
    AgentTimerCapMode, AgentTimerDailyCaps, AgentTimerLimitsUpdate, AgentTimerOperation,
    AgentTimerSchedule, AGENT_TIMER_DAILY_CREATES_MAX, AGENT_TIMER_OWNER_ONLY_DAILY_CREATES_MAX,
};

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

/// A dormant import (V1 may still run it) and an owner's indefinite pause are
/// the owner's: the agent can neither cancel the first nor end the second.
#[tokio::test]
async fn dormant_imports_and_indefinite_owner_pauses_stay_with_the_owner() {
    let f = setup().await;
    let c = f.conversation.clone();
    let g = grant(&f, &c).await;
    asking_turn(&f, &c, "turn").await;
    let dormant = Uuid::new_v4();
    f.store
        .import_dormant_timer_for(
            &f.token,
            &f.owner,
            &TimerImportRequest {
                namespace: dormant,
                source_namespace: "synthetic-v1".into(),
                source_timer_id: "still-v1".into(),
                source_enabled: true,
                schedule: TimerSchedule::Interval {
                    every_ms: 3_600_000,
                },
            },
            &TimerTarget {
                conversation_id: c.clone(),
                label: "Owner still-v1".into(),
                source_thread_id: "synthetic-thread".into(),
            },
        )
        .await
        .unwrap();
    for (key, operation, until) in [
        ("d1", AgentTimerOperation::Cancel, None),
        ("d2", AgentTimerOperation::Pause, Some(now_ms() + DAY)),
        ("d3", AgentTimerOperation::Resume, None),
        ("d4", AgentTimerOperation::SkipNext, None),
    ] {
        assert_eq!(
            f.store
                .control_agent_timer(&g, &c, dormant, &control(key, operation, until))
                .await,
            refused("agent_timer_dormant")
        );
    }
    let check = owner_timer(&f, &c, "held").await;
    f.store
        .pause_timer(&f.token, &f.owner, check, Some(FOREVER_MS))
        .await
        .unwrap();
    for (key, operation, until) in [
        ("o1", AgentTimerOperation::Pause, Some(now_ms() + DAY)),
        ("o2", AgentTimerOperation::Pause, None),
        ("o3", AgentTimerOperation::Resume, None),
    ] {
        assert_eq!(
            f.store
                .control_agent_timer(&g, &c, check, &control(key, operation, until))
                .await,
            refused("agent_timer_owner_paused")
        );
    }
    let policy = f
        .store
        .timer_policy(&f.token, &f.owner, check)
        .await
        .unwrap();
    assert_eq!(policy.pause_until_ms, Some(FOREVER_MS));
}

#[tokio::test]
async fn a_timer_turn_creates_one_shots_but_never_recurring_timers() {
    let f = setup().await;
    let c = f.conversation.clone();
    let g = grant(&f, &c).await;
    // The owner's check timer fires and starts the Deep turn.
    let check = owner_timer(&f, &c, "check").await;
    sqlx::query("UPDATE dormant_timers SET next_due_ms=0 WHERE namespace=?")
        .bind(check.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    let issuer = f.handle.authorize_timer_scheduler(check).await.unwrap();
    f.handle
        .admit_authorized_timer_turn(&issuer, check, false)
        .await
        .unwrap();
    next_turn(&f, &c, "timer-turn").await;
    // A recurring timer from a timer turn could keep itself going: refused.
    assert_eq!(
        f.store
            .create_agent_timer(&g, &c, &daily("chained", vec![0], 540, 540))
            .await,
        refused("agent_timer_timer_turn")
    );
    // A one-shot reminder fires once: allowed, under the same caps.
    let reminder = f
        .store
        .create_agent_timer(&g, &c, &once("reminder", now_ms() + DAY))
        .await
        .unwrap();
    assert!(reminder.changed && reminder.timer.created_by_agent);
    // It can still pause (and resume) itself after its window ended.
    let paused = f
        .store
        .control_agent_timer(
            &g,
            &c,
            check,
            &control(
                "self-pause",
                AgentTimerOperation::Pause,
                Some(now_ms() + DAY),
            ),
        )
        .await
        .unwrap();
    assert!(paused.changed);
    assert!(f
        .store
        .control_agent_timer(
            &g,
            &c,
            check,
            &control("self-skip", AgentTimerOperation::SkipNext, None)
        )
        .await
        .is_ok());
    let outcomes = f
        .store
        .agent_timer_audit_outcomes(&f.owner, &c)
        .await
        .unwrap();
    assert!(outcomes.contains(&("create".into(), "agent_timer_timer_turn".into())));
    assert!(outcomes.contains(&("create".into(), "accepted".into())));
}

/// `count` agent creates of `c` through the Core step, all `age_ms` old
/// (older than an hour, so only the daily cap sees them). Each fired: none
/// is live, like the one-shots of a busy chat.
async fn aged_creates(f: &Case, c: &ConversationId, prefix: &str, count: i64, age_ms: i64) {
    let mut conn = f.store.pool.acquire().await.unwrap();
    let (run, _) = running_deep(&mut conn, &f.owner, c).await.unwrap().unwrap();
    drop(conn);
    let mut tx = f.store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    for i in 0..count {
        let key = format!("{prefix}{i}");
        agent_timer_create(
            &mut tx,
            &f.owner,
            c,
            &AgentTimerNew {
                namespace: agent_namespace(&f.owner, c, &key),
                label: "Day",
                schedule: TimerSchedule::Once {
                    due_ms: now_ms() + DAY,
                },
                instruction: "day".into(),
                request_key: &key,
                request_digest: &"0".repeat(64),
                run_id: &run,
                grant_generation: 1,
            },
        )
        .await
        .unwrap();
    }
    // Test-only: age the provenance rows and mark the timers fired.
    sqlx::raw_sql(&format!(
        "DROP TRIGGER agent_timers_fixed; UPDATE agent_timers SET created_ms=created_ms-{age_ms} WHERE request_key LIKE '{prefix}%'; UPDATE dormant_timers SET state='exhausted',next_due_ms=NULL WHERE namespace IN (SELECT namespace FROM agent_timers WHERE request_key LIKE '{prefix}%'); CREATE TRIGGER agent_timers_fixed BEFORE UPDATE ON agent_timers BEGIN SELECT RAISE(ABORT,'agent timer provenance is fixed'); END;"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}
fn limits(mode: AgentTimerCapMode, daily_creates_max: Option<i64>) -> AgentTimerLimitsUpdate {
    AgentTimerLimitsUpdate {
        mode,
        daily_creates_max,
    }
}
fn upsert(key: &str, label: &str, due_ms: i64, text: &str) -> AgentTimerCreate {
    AgentTimerCreate {
        request_key: key.into(),
        label: label.into(),
        schedule: AgentTimerSchedule::Once { due_ms },
        text: text.into(),
    }
}
async fn generation(f: &Case, namespace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT generation FROM dormant_timers WHERE namespace=?")
        .bind(namespace.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}
async fn agent_rows(f: &Case, c: &ConversationId) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM agent_timers WHERE conversation_id=?")
        .bind(c.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn daily_create_cap_applies_beyond_the_hourly_one() {
    // A chat with other participants (no owner setting): the default 24.
    let f = setup().await;
    let c = f.conversation.clone();
    let g = grant(&f, &c).await;
    asking_turn(&f, &c, "turn").await;
    aged_creates(&f, &c, "day", AGENT_TIMER_DAILY_CREATES_MAX, 7_200_000).await;
    assert_eq!(
        f.store
            .create_agent_timer(&g, &c, &once("one-more", now_ms() + DAY))
            .await,
        refused("agent_timer_daily_limit")
    );
    let read = f
        .store
        .agent_timer_limits(&f.token, &f.owner, &c)
        .await
        .unwrap();
    assert_eq!(read.mode, AgentTimerCapMode::Default);
    assert_eq!(read.daily_creates_max, Some(AGENT_TIMER_DAILY_CREATES_MAX));
    assert_eq!(read.created_last_24h, AGENT_TIMER_DAILY_CREATES_MAX);
    // Creates older than 24 hours no longer count (rolling window).
    let f2 = setup().await;
    let c2 = f2.conversation.clone();
    let g2 = grant(&f2, &c2).await;
    asking_turn(&f2, &c2, "turn").await;
    aged_creates(&f2, &c2, "old", AGENT_TIMER_DAILY_CREATES_MAX, DAY + 60_000).await;
    assert!(
        f2.store
            .create_agent_timer(&g2, &c2, &once("fresh", now_ms() + DAY))
            .await
            .unwrap()
            .changed
    );
}

#[tokio::test]
async fn an_owner_only_chat_is_not_blocked_at_the_shared_default() {
    let f = setup().await;
    let c = f.conversation.clone();
    let g = grant(&f, &c).await;
    asking_turn(&f, &c, "turn").await;
    aged_creates(&f, &c, "day", AGENT_TIMER_DAILY_CREATES_MAX, 7_200_000).await;
    assert_eq!(
        f.store
            .create_agent_timer(&g, &c, &once("blocked", now_ms() + DAY))
            .await,
        refused("agent_timer_daily_limit")
    );
    // The owner marks the chat owner-only: the owner-only default applies
    // at once, and no timer history is touched.
    let set = f
        .store
        .set_agent_timer_limits(
            &f.token,
            &f.owner,
            &c,
            &limits(AgentTimerCapMode::OwnerOnly, None),
        )
        .await
        .unwrap();
    assert_eq!(
        set.daily_creates_max,
        Some(AGENT_TIMER_OWNER_ONLY_DAILY_CREATES_MAX)
    );
    assert_eq!(set.created_last_24h, AGENT_TIMER_DAILY_CREATES_MAX);
    assert!(
        f.store
            .create_agent_timer(&g, &c, &once("unblocked", now_ms() + DAY))
            .await
            .unwrap()
            .changed
    );
    // ... up to the owner-only cap.
    aged_creates(
        &f,
        &c,
        "more",
        AGENT_TIMER_OWNER_ONLY_DAILY_CREATES_MAX - AGENT_TIMER_DAILY_CREATES_MAX - 1,
        7_200_000,
    )
    .await;
    assert_eq!(
        f.store
            .create_agent_timer(&g, &c, &once("at-200", now_ms() + DAY))
            .await,
        refused("agent_timer_daily_limit")
    );
    // `off` lifts the daily cap; `fixed` sets one; `default` goes back.
    f.store
        .set_agent_timer_limits(
            &f.token,
            &f.owner,
            &c,
            &limits(AgentTimerCapMode::Off, None),
        )
        .await
        .unwrap();
    assert!(
        f.store
            .create_agent_timer(&g, &c, &once("off", now_ms() + DAY))
            .await
            .unwrap()
            .changed
    );
    let fixed = f
        .store
        .set_agent_timer_limits(
            &f.token,
            &f.owner,
            &c,
            &limits(AgentTimerCapMode::Fixed, Some(500)),
        )
        .await
        .unwrap();
    assert_eq!(fixed.daily_creates_max, Some(500));
    let back = f
        .store
        .set_agent_timer_limits(
            &f.token,
            &f.owner,
            &c,
            &limits(AgentTimerCapMode::Default, None),
        )
        .await
        .unwrap();
    assert_eq!(back.mode, AgentTimerCapMode::Default);
    assert_eq!(
        f.store
            .set_agent_timer_limits(
                &f.token,
                &f.owner,
                &c,
                &limits(AgentTimerCapMode::Fixed, None)
            )
            .await,
        Err(ResourceError::Invalid)
    );
    // Only the owner session sets it.
    assert_eq!(
        f.store
            .set_agent_timer_limits("nope", &f.owner, &c, &limits(AgentTimerCapMode::Off, None))
            .await,
        Err(ResourceError::Unauthorized)
    );
    // The hourly and live caps are unchanged by any mode.
    assert_eq!(AGENT_TIMER_HOURLY_CREATES_MAX, 12);
    assert_eq!(AGENT_TIMER_ACTIVE_MAX, 32);
}

#[tokio::test]
async fn server_defaults_set_the_daily_caps() {
    let f = setup().await;
    let c = f.conversation.clone();
    let store = f
        .store
        .clone()
        .with_agent_timer_daily_caps(AgentTimerDailyCaps {
            default: Some(3),
            owner_only: None,
        });
    let g = grant(&f, &c).await;
    asking_turn(&f, &c, "turn").await;
    aged_creates(&f, &c, "day", 3, 7_200_000).await;
    assert_eq!(
        store
            .create_agent_timer(&g, &c, &once("over", now_ms() + DAY))
            .await,
        refused("agent_timer_daily_limit")
    );
    // An owner-only chat with an `off` server default has no daily cap.
    store
        .default_agent_timer_limits_owner_only(&f.token, &f.owner, &c)
        .await
        .unwrap();
    assert!(
        store
            .create_agent_timer(&g, &c, &once("free", now_ms() + DAY))
            .await
            .unwrap()
            .changed
    );
    // A chosen setting is never overwritten by the owner-only default.
    store
        .set_agent_timer_limits(
            &f.token,
            &f.owner,
            &c,
            &limits(AgentTimerCapMode::Fixed, Some(9)),
        )
        .await
        .unwrap();
    let kept = store
        .default_agent_timer_limits_owner_only(&f.token, &f.owner, &c)
        .await
        .unwrap();
    assert_eq!(kept.mode, AgentTimerCapMode::Fixed);
}

#[tokio::test]
async fn upsert_moves_the_timer_with_the_same_label() {
    let f = setup().await;
    let c = f.conversation.clone();
    let g = grant(&f, &c).await;
    asking_turn(&f, &c, "turn").await;
    let due = now_ms() + DAY;
    // No timer with the label yet: the upsert creates one (a counted create).
    let first = f
        .store
        .upsert_agent_timer(&g, &c, &upsert("u1", "Watcher", due, "Check the inbox."))
        .await
        .unwrap();
    assert!(first.changed && first.timer.created_by_agent);
    let namespace = first.timer.namespace;
    let gen = generation(&f, namespace).await;
    // Same label (any case), new time: the same timer moves, same generation.
    let moved = f
        .store
        .upsert_agent_timer(
            &g,
            &c,
            &upsert("u2", " watcher ", due + 3_600_000, "Check the inbox."),
        )
        .await
        .unwrap();
    assert!(moved.changed);
    assert_eq!(moved.timer.namespace, namespace);
    assert_eq!(moved.timer.next_due_ms, Some(due + 3_600_000));
    assert_eq!(generation(&f, namespace).await, gen);
    assert_eq!(agent_rows(&f, &c).await, 1, "an upsert is not a create");
    // New text: a new generation of the same timer with the new instruction.
    let retexted = f
        .store
        .upsert_agent_timer(
            &g,
            &c,
            &upsert("u3", "Watcher", due, "Check the inbox and CI."),
        )
        .await
        .unwrap();
    assert_eq!(retexted.timer.namespace, namespace);
    assert_eq!(retexted.timer.state, "enabled");
    assert!(generation(&f, namespace).await > gen);
    let instruction: String = sqlx::query_scalar("SELECT instruction FROM durable_timer_authorities WHERE namespace=? ORDER BY generation DESC LIMIT 1")
        .bind(namespace.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert!(instruction.ends_with("Check the inbox and CI."));
    assert_eq!(agent_rows(&f, &c).await, 1);
    // A replay of a move changes nothing; the same body is a no-op.
    assert!(
        !f.store
            .upsert_agent_timer(
                &g,
                &c,
                &upsert("u2", "Watcher", due + 3_600_000, "Check the inbox.")
            )
            .await
            .unwrap()
            .changed
    );
    assert!(
        !f.store
            .upsert_agent_timer(
                &g,
                &c,
                &upsert("u4", "Watcher", due, "Check the inbox and CI.")
            )
            .await
            .unwrap()
            .changed
    );
    // Only one timer is listed for the label.
    let listed = f.store.agent_timers(&g, &c).await.unwrap();
    assert_eq!(listed.timers.len(), 1);
    // A cancelled timer is never revived: a new one is created instead.
    f.store
        .control_agent_timer(
            &g,
            &c,
            namespace,
            &control("cx", AgentTimerOperation::Cancel, None),
        )
        .await
        .unwrap();
    let fresh = f
        .store
        .upsert_agent_timer(&g, &c, &upsert("u5", "Watcher", due, "Check the inbox."))
        .await
        .unwrap();
    assert_ne!(fresh.timer.namespace, namespace);
    assert_eq!(agent_rows(&f, &c).await, 2);
    let outcomes = f
        .store
        .agent_timer_audit_outcomes(&f.owner, &c)
        .await
        .unwrap();
    assert!(outcomes.contains(&("create".into(), "upserted".into())));
}

#[tokio::test]
async fn upserts_skip_the_daily_cap_but_keep_the_live_and_hourly_caps() {
    let f = setup().await;
    let c = f.conversation.clone();
    let g = grant(&f, &c).await;
    asking_turn(&f, &c, "turn").await;
    let watcher = f
        .store
        .upsert_agent_timer(&g, &c, &upsert("w0", "Watcher", now_ms() + DAY, "Check."))
        .await
        .unwrap()
        .timer
        .namespace;
    aged_creates(&f, &c, "day", AGENT_TIMER_DAILY_CREATES_MAX, 7_200_000).await;
    // At the daily cap a new timer is refused, a move is not.
    assert_eq!(
        f.store
            .upsert_agent_timer(&g, &c, &upsert("n0", "Other", now_ms() + DAY, "x"))
            .await,
        refused("agent_timer_daily_limit")
    );
    let moved = f
        .store
        .upsert_agent_timer(
            &g,
            &c,
            &upsert("w1", "Watcher", now_ms() + 2 * DAY, "Check."),
        )
        .await
        .unwrap();
    assert!(moved.changed && moved.timer.namespace == watcher);
    // Moves count toward the hourly cap (1 create + 1 move so far).
    for i in 2..AGENT_TIMER_HOURLY_CREATES_MAX {
        f.store
            .upsert_agent_timer(
                &g,
                &c,
                &upsert(
                    &format!("w{i}"),
                    "Watcher",
                    now_ms() + 2 * DAY + i * 60_000,
                    "Check.",
                ),
            )
            .await
            .unwrap();
    }
    assert_eq!(
        f.store
            .upsert_agent_timer(
                &g,
                &c,
                &upsert("w-over", "Watcher", now_ms() + 3 * DAY, "Check.")
            )
            .await,
        refused("agent_timer_rate_limited")
    );
    // Moves are not refusals: the refusal budget still allows audits.
    let refusals: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_timer_audit WHERE outcome NOT IN ('accepted','replayed','upserted')")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(refusals, 2);
}

#[tokio::test]
async fn upsert_keeps_the_live_timer_cap() {
    let f = setup().await;
    let c = f.conversation.clone();
    let g = grant(&f, &c).await;
    asking_turn(&f, &c, "turn").await;
    f.store
        .set_agent_timer_limits(
            &f.token,
            &f.owner,
            &c,
            &limits(AgentTimerCapMode::Off, None),
        )
        .await
        .unwrap();
    // One fired watcher, then the live cap filled by other timers.
    let watcher = f
        .store
        .upsert_agent_timer(&g, &c, &upsert("w0", "Watcher", now_ms() + DAY, "Check."))
        .await
        .unwrap()
        .timer
        .namespace;
    sqlx::query("UPDATE dormant_timers SET state='exhausted',next_due_ms=NULL WHERE namespace=?")
        .bind(watcher.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    let mut conn = f.store.pool.acquire().await.unwrap();
    let (run, _) = running_deep(&mut conn, &f.owner, &c)
        .await
        .unwrap()
        .unwrap();
    drop(conn);
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
    // Test-only: older than an hour, so only the live cap sees them.
    sqlx::raw_sql(
        "DROP TRIGGER agent_timers_fixed; UPDATE agent_timers SET created_ms=created_ms-7200000;",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    // Re-arming the fired watcher would add a live timer: refused.
    assert_eq!(
        f.store
            .upsert_agent_timer(&g, &c, &upsert("w1", "Watcher", now_ms() + DAY, "Check."))
            .await,
        refused("agent_timer_limit_reached")
    );
    // A new label too.
    assert_eq!(
        f.store
            .upsert_agent_timer(&g, &c, &upsert("n1", "New", now_ms() + DAY, "x"))
            .await,
        refused("agent_timer_limit_reached")
    );
    // Moving a live one keeps the count: allowed.
    assert!(
        f.store
            .upsert_agent_timer(&g, &c, &upsert("c1", "Cap", now_ms() + 2 * DAY, "cap"))
            .await
            .unwrap()
            .changed
    );
    let live = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM agent_timers a JOIN dormant_timers t ON t.namespace=a.namespace WHERE t.state IN ('enabled','paused')")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(live, AGENT_TIMER_ACTIVE_MAX);
}

#[tokio::test]
async fn a_timer_turn_re_arms_its_own_watcher_without_fencing_itself() {
    let f = setup().await;
    let c = f.conversation.clone();
    let g = grant(&f, &c).await;
    let (_, owner_turn) = asking_turn(&f, &c, "turn").await;
    let watcher = f
        .store
        .upsert_agent_timer(&g, &c, &upsert("w0", "Watcher", now_ms() + DAY, "Check."))
        .await
        .unwrap()
        .timer
        .namespace;
    super::super::thread_asks::tests::finish(&f, &c, &owner_turn, "Set.", "turn").await;
    let gen = generation(&f, watcher).await;
    // The watcher fires and starts the next Deep turn.
    sqlx::query("UPDATE dormant_timers SET next_due_ms=0 WHERE namespace=?")
        .bind(watcher.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    let issuer = f.handle.authorize_timer_scheduler(watcher).await.unwrap();
    f.handle
        .admit_authorized_timer_turn(&issuer, watcher, false)
        .await
        .unwrap();
    let p = next_turn(&f, &c, "timer-turn").await;
    let fired = f.store.agent_timers(&g, &c).await.unwrap();
    assert_eq!(fired.timers[0].state, "exhausted");
    // A new text would need a new generation, which would fence this run.
    assert_eq!(
        f.store
            .upsert_agent_timer(&g, &c, &upsert("w1", "Watcher", now_ms() + DAY, "Other."))
            .await,
        refused("agent_timer_busy")
    );
    // The same text re-arms the same timer in the same generation.
    let armed = f
        .store
        .upsert_agent_timer(&g, &c, &upsert("w2", "Watcher", now_ms() + DAY, "Check."))
        .await
        .unwrap();
    assert!(armed.changed);
    assert_eq!(armed.timer.namespace, watcher);
    assert_eq!(armed.timer.state, "enabled");
    assert_eq!(generation(&f, watcher).await, gen);
    assert_eq!(agent_rows(&f, &c).await, 1);
    let held: i64 = sqlx::query_scalar("SELECT count(*) FROM ordinary_input_holds h JOIN dormant_timer_inputs i ON i.event_id=h.event_id WHERE i.namespace=?")
        .bind(watcher.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(held, 0, "the running timer turn is not fenced");
    super::super::thread_asks::tests::finish(&f, &c, &p, "Checked.", "timer-turn").await;
}
