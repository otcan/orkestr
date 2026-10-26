use super::*;
use crate::history_import::timers::{
    authority::DurableTimerEnable,
    calendar_timer::CalendarTimerCreate,
    outcome::OutcomeKind,
    policy::{DigestConfig, PolicyUpdate, SilentMode, TriggerConfig, TriggerSource},
    *,
};
use crate::production_runtime::tests::{setup, Case};
use orkestr_v2_contracts::{CalendarRule, ConversationId};

fn every_hour_utc() -> CalendarRule {
    CalendarRule {
        timezone: "UTC".into(),
        weekdays: vec![],
        start_minute: 0,
        end_minute: 1439,
        every_hours: 1,
        minutes: vec![0],
    }
    .normalized()
    .unwrap()
}
fn quiet() -> PolicyUpdate {
    PolicyUpdate {
        silent_mode: SilentMode::UnlessChanged,
        pause_until_ms: None,
        skip_dates: vec![],
        skip_timezone: None,
        digest: None,
        trigger: None,
    }
}
async fn clock(f: &Case) -> i64 {
    sqlx::query_scalar("SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)")
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}
async fn create(f: &Case, schedule: TimerSchedule, policy: PolicyUpdate, key: &str) -> Uuid {
    let namespace = Uuid::new_v4();
    let receipt = f
        .store
        .create_calendar_timer(
            &f.token,
            &f.owner,
            &CalendarTimerCreate {
                namespace,
                conversation_id: f.conversation.clone(),
                label: format!("Synthetic {key}"),
                schedule,
                policy,
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
                    expected_revision: receipt.revision,
                    request_key: format!("enable-{key}"),
                    conversation_id: f.conversation.clone(),
                },
                instruction: format!("Synthetic calendar task {key}"),
            },
        )
        .await
        .unwrap();
    namespace
}
async fn next_due(f: &Case, namespace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT next_due_ms FROM dormant_timers WHERE namespace=?")
        .bind(namespace.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}
async fn make_overdue(f: &Case, namespace: Uuid) {
    sqlx::query("UPDATE dormant_timers SET next_due_ms=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)-5000 WHERE namespace=?")
        .bind(namespace.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
}
async fn fire(
    f: &Case,
    namespace: Uuid,
) -> crate::history_import::timers::input::TimerInputReceipt {
    let issuer = f.handle.authorize_timer_scheduler(namespace).await.unwrap();
    f.handle
        .admit_authorized_timer_turn(&issuer, namespace, true)
        .await
        .unwrap()
}
async fn due_now(f: &Case) -> Vec<Uuid> {
    f.handle
        .due_timer_scheduler_candidates(None, 32)
        .await
        .unwrap()
}
async fn finish(f: Case) {
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test]
async fn calendar_timer_fires_once_per_slot_and_advances_on_the_rule() {
    let f = setup().await;
    let namespace = create(
        &f,
        TimerSchedule::Calendar(every_hour_utc()),
        quiet(),
        "hourly",
    )
    .await;
    let now = clock(&f).await;
    let due = next_due(&f, namespace).await;
    // Top-of-the-hour runs carry the timer's deterministic spread.
    let spread = timer_spread_ms(namespace);
    assert!(due > now && due - now <= 3_600_000 + spread && due % 3_600_000 == spread);
    assert!(due_now(&f).await.is_empty());
    make_overdue(&f, namespace).await;
    assert_eq!(due_now(&f).await, vec![namespace]);
    let receipt = fire(&f, namespace).await;
    assert!(!receipt.duplicate);
    // Downtime coalesces: exactly one run, then the next top of the hour.
    let after = next_due(&f, namespace).await;
    assert!(after > now && after % 3_600_000 == spread);
    assert!(due_now(&f).await.is_empty());
    let issuer = f.handle.authorize_timer_scheduler(namespace).await.unwrap();
    assert!(f
        .handle
        .admit_authorized_timer_turn(&issuer, namespace, true)
        .await
        .is_err());
    finish(f).await;
}

#[tokio::test]
async fn pause_until_blocks_runs_then_resumes_without_catch_up() {
    let f = setup().await;
    let namespace = create(
        &f,
        TimerSchedule::Calendar(every_hour_utc()),
        quiet(),
        "pause",
    )
    .await;
    let now = clock(&f).await;
    let until = now + 3 * 3_600_000 + 1_000;
    let policy = f
        .store
        .pause_timer(&f.token, &f.owner, namespace, Some(until))
        .await
        .unwrap();
    assert_eq!(policy.pause_until_ms, Some(until));
    // The next run moved to the first top of the hour at or after the pause end.
    let moved = next_due(&f, namespace).await;
    let spread = timer_spread_ms(namespace);
    assert!(moved >= until && moved - until < 3_600_000 + spread && moved % 3_600_000 == spread);
    // Even a stored past-due occurrence is not a candidate while paused.
    make_overdue(&f, namespace).await;
    assert!(due_now(&f).await.is_empty());
    let issuer = f.handle.authorize_timer_scheduler(namespace).await.unwrap();
    assert!(f
        .handle
        .admit_authorized_timer_turn(&issuer, namespace, true)
        .await
        .is_err());
    // Resume: next run is the next top of the hour from now, no backlog.
    let policy = f
        .store
        .pause_timer(&f.token, &f.owner, namespace, None)
        .await
        .unwrap();
    assert_eq!(policy.pause_until_ms, None);
    let resumed = next_due(&f, namespace).await;
    assert!(
        resumed > now && resumed - now <= 3_600_000 + spread + 5_000,
        "{resumed} {now}"
    );
    finish(f).await;
}

#[tokio::test]
async fn indefinite_pause_and_conversation_pause_hold_until_resumed() {
    let f = setup().await;
    let a = create(&f, TimerSchedule::Calendar(every_hour_utc()), quiet(), "a").await;
    let b = create(&f, TimerSchedule::Calendar(every_hour_utc()), quiet(), "b").await;
    make_overdue(&f, a).await;
    make_overdue(&f, b).await;
    assert_eq!(due_now(&f).await.len(), 2);
    f.store
        .pause_timer(&f.token, &f.owner, a, Some(policy::FOREVER_MS))
        .await
        .unwrap();
    assert_eq!(due_now(&f).await, vec![b]);
    // Whole conversation, until a datetime.
    let until = clock(&f).await + 2 * 3_600_000;
    assert_eq!(
        f.store
            .pause_conversation_timers(&f.token, &f.owner, &f.conversation, Some(until))
            .await
            .unwrap(),
        Some(until)
    );
    assert_eq!(
        f.store
            .conversation_timer_pause(&f.token, &f.owner, &f.conversation)
            .await
            .unwrap(),
        Some(until)
    );
    assert!(due_now(&f).await.is_empty());
    // b's next run moved past the pause too.
    assert!(next_due(&f, b).await >= until);
    f.store
        .pause_conversation_timers(&f.token, &f.owner, &f.conversation, None)
        .await
        .unwrap();
    // a is still paused on its own; resuming it recomputes from now.
    make_overdue(&f, b).await;
    assert_eq!(due_now(&f).await, vec![b]);
    f.store
        .pause_timer(&f.token, &f.owner, a, None)
        .await
        .unwrap();
    assert!(next_due(&f, a).await > clock(&f).await);
    finish(f).await;
}

#[tokio::test]
async fn skip_dates_move_the_next_run_off_the_holiday() {
    let f = setup().await;
    let namespace = create(
        &f,
        TimerSchedule::Calendar(every_hour_utc()),
        quiet(),
        "skip",
    )
    .await;
    let now = clock(&f).await;
    let today = {
        let ts = jiff::Timestamp::from_millisecond(now).unwrap();
        ts.to_zoned(jiff::tz::TimeZone::UTC).date().to_string()
    };
    let mut update = quiet();
    update.skip_dates = vec![today.clone()];
    let policy = f
        .store
        .timer_policy(&f.token, &f.owner, namespace)
        .await
        .unwrap();
    f.store
        .set_timer_policy(&f.token, &f.owner, namespace, policy.revision, &update)
        .await
        .unwrap();
    let due = next_due(&f, namespace).await;
    let due_date = jiff::Timestamp::from_millisecond(due)
        .unwrap()
        .to_zoned(jiff::tz::TimeZone::UTC)
        .date()
        .to_string();
    assert_ne!(due_date, today);
    assert!(due > now);
    // A stale policy revision is refused.
    assert!(matches!(
        f.store
            .set_timer_policy(&f.token, &f.owner, namespace, policy.revision, &update)
            .await,
        Err(HistoryError::Conflict)
    ));
    finish(f).await;
}

#[tokio::test]
async fn silent_runs_are_counted_and_only_news_is_delivered() {
    let f = setup().await;
    let namespace = create(
        &f,
        TimerSchedule::Calendar(every_hour_utc()),
        quiet(),
        "silent",
    )
    .await;
    let mut claims = Vec::new();
    for _ in 0..3 {
        make_overdue(&f, namespace).await;
        claims.push(fire(&f, namespace).await.claim.claim_id);
    }
    let record = |claim: Uuid, text: &'static str| {
        let f = &f;
        async move {
            f.store
                .record_timer_outcome(&f.token, &f.owner, &f.conversation, claim, text)
                .await
                .unwrap()
        }
    };
    assert_eq!(
        record(claims[0], "NO_REPLY").await.kind,
        OutcomeKind::Silent
    );
    let second = record(claims[1], "NO_NEWS: inbox unchanged").await;
    assert_eq!(second.kind, OutcomeKind::Silent);
    assert_eq!(second.summary, "inbox unchanged");
    // A retry returns the first decision.
    let again = record(claims[1], "Something else entirely").await;
    assert!(again.replay && again.kind == OutcomeKind::Silent);
    let news = record(claims[2], "New offer from ACME\nPlease review").await;
    assert_eq!(news.kind, OutcomeKind::Delivered);
    assert!(news.kind.deliver());
    let listed = f
        .store
        .conversation_timers(&f.token, &f.owner, &f.conversation)
        .await
        .unwrap();
    let stats = &listed[0].stats;
    assert_eq!(stats.total_runs, 3);
    assert_eq!(
        stats.silent_runs, 0,
        "a delivered result resets the quiet streak"
    );
    assert_eq!(stats.last_kind, Some(OutcomeKind::Delivered));
    assert!(stats
        .last_summary
        .as_deref()
        .unwrap()
        .starts_with("New offer from ACME"));
    // A claim from another conversation or an unknown one is refused.
    assert!(matches!(
        f.store
            .record_timer_outcome(&f.token, &f.owner, &f.conversation, Uuid::new_v4(), "x")
            .await,
        Err(HistoryError::NotFound)
    ));
    finish(f).await;
}

#[tokio::test]
async fn without_the_policy_markers_are_ordinary_text_but_no_reply_stays_silent() {
    let f = setup().await;
    let mut plain = quiet();
    plain.silent_mode = SilentMode::Off;
    let namespace = create(
        &f,
        TimerSchedule::Calendar(every_hour_utc()),
        plain,
        "plain",
    )
    .await;
    make_overdue(&f, namespace).await;
    let first = fire(&f, namespace).await.claim.claim_id;
    make_overdue(&f, namespace).await;
    let second = fire(&f, namespace).await.claim.claim_id;
    let a = f
        .store
        .record_timer_outcome(&f.token, &f.owner, &f.conversation, first, "NO_NEWS")
        .await
        .unwrap();
    assert_eq!(a.kind, OutcomeKind::Delivered);
    let b = f
        .store
        .record_timer_outcome(&f.token, &f.owner, &f.conversation, second, "NO_REPLY")
        .await
        .unwrap();
    assert_eq!(b.kind, OutcomeKind::Silent);
    finish(f).await;
}

#[tokio::test]
async fn digest_collects_quiet_runs_once_per_slot() {
    let f = setup().await;
    let mut policy = quiet();
    // Every hour is a digest slot, so one is always due.
    policy.digest = Some(DigestConfig {
        timezone: "Europe/Istanbul".into(),
        minutes: (0..24).map(|h| h * 60).collect(),
    });
    let namespace = create(
        &f,
        TimerSchedule::Calendar(every_hour_utc()),
        policy,
        "digest",
    )
    .await;
    let mut claims = Vec::new();
    for _ in 0..4 {
        make_overdue(&f, namespace).await;
        claims.push(fire(&f, namespace).await.claim.claim_id);
    }
    for (claim, text) in claims.iter().zip([
        "NO_NEWS",
        "NO_NEWS",
        "LOW_SIGNAL: two promo mails",
        "NO_NEWS: nothing from recruiters",
    ]) {
        let outcome = f
            .store
            .record_timer_outcome(&f.token, &f.owner, &f.conversation, *claim, text)
            .await
            .unwrap();
        assert!(!outcome.kind.deliver());
    }
    // The digest only covers runs after it was configured: nothing due yet.
    assert_eq!(f.handle.generate_timer_digests().await.unwrap(), 0);
    sqlx::query("UPDATE timer_policies SET digest_since_ms=digest_since_ms-172800000")
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(f.handle.generate_timer_digests().await.unwrap(), 1);
    // Same slot: no second digest.
    assert_eq!(f.handle.generate_timer_digests().await.unwrap(), 0);
    let pending = f
        .store
        .pending_timer_digests(&f.token, &f.owner, &f.conversation, 10)
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    let text = &pending[0].text;
    assert_eq!(pending[0].item_count, 4);
    assert!(
        text.contains("Digest: Synthetic digest - 4 quiet runs"),
        "{text}"
    );
    assert!(text.contains("Nothing new in 2 runs."), "{text}");
    assert!(
        text.contains("two promo mails") && text.contains("nothing from recruiters"),
        "{text}"
    );
    assert!(f
        .store
        .acknowledge_timer_digest(
            &f.token,
            &f.owner,
            &ConversationId(Uuid::new_v4()),
            pending[0].id
        )
        .await
        .is_err());
    f.store
        .acknowledge_timer_digest(&f.token, &f.owner, &f.conversation, pending[0].id)
        .await
        .unwrap();
    assert!(f
        .store
        .pending_timer_digests(&f.token, &f.owner, &f.conversation, 10)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        f.store
            .recent_timer_digests(&f.token, &f.owner, &f.conversation, 10)
            .await
            .unwrap()
            .len(),
        1
    );
    // The held runs were consumed by that digest and are not repeated.
    sqlx::query("DELETE FROM timer_digests")
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(f.handle.generate_timer_digests().await.unwrap(), 0);
    finish(f).await;
}

#[tokio::test]
async fn event_triggers_run_on_inbound_events_and_coalesce_bursts() {
    let f = setup().await;
    let mut policy = quiet();
    policy.trigger = Some(TriggerConfig {
        sources: vec![TriggerSource::Message, TriggerSource::Email],
        min_interval_s: 3600,
    });
    let namespace = create(&f, TimerSchedule::Event, policy, "events").await;
    // Never due by the clock.
    assert!(next_due(&f, namespace).await >= policy::FOREVER_MS);
    assert!(due_now(&f).await.is_empty());
    assert!(f
        .handle
        .pending_timer_trigger_namespaces(10)
        .await
        .unwrap()
        .is_empty());
    let record = |source: TriggerSource, key: &'static str| {
        let f = &f;
        async move {
            f.store
                .record_timer_trigger(&f.token, &f.owner, &f.conversation, source, key)
                .await
                .unwrap()
        }
    };
    assert_eq!(record(TriggerSource::Message, "wa-1").await, 1);
    assert_eq!(
        record(TriggerSource::Message, "wa-1").await,
        0,
        "replay is idempotent"
    );
    assert_eq!(record(TriggerSource::Email, "mail-9").await, 1);
    assert_eq!(
        record(TriggerSource::Other, "x").await,
        0,
        "not a listened source"
    );
    assert_eq!(
        f.handle.pending_timer_trigger_namespaces(10).await.unwrap(),
        vec![namespace]
    );
    let issuer = f.handle.authorize_timer_scheduler(namespace).await.unwrap();
    let admitted = f
        .handle
        .admit_authorized_trigger_turn(&issuer, namespace, true)
        .await
        .unwrap()
        .expect("one coalesced run");
    // Both events became a single run.
    assert!(f
        .handle
        .pending_timer_trigger_namespaces(10)
        .await
        .unwrap()
        .is_empty());
    let states: Vec<String> =
        sqlx::query_scalar("SELECT state FROM timer_trigger_events ORDER BY event_key")
            .fetch_all(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(states.iter().filter(|s| *s == "admitted").count(), 1);
    assert_eq!(states.iter().filter(|s| *s == "coalesced").count(), 1);
    let text: String = sqlx::query_scalar("SELECT text FROM messages WHERE id=?")
        .bind(admitted.input.message_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert!(text.contains("Synthetic calendar task events"));
    assert!(
        text.contains("[Trigger: new inbound ")
            && text.contains("event (+1 more since the last run)]"),
        "{text}"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM execution_window_queue")
            .fetch_one(&f.store.pool)
            .await
            .unwrap(),
        1
    );
    // Inside the minimum interval a new event waits instead of running.
    assert_eq!(record(TriggerSource::Message, "wa-2").await, 1);
    assert!(f
        .handle
        .admit_authorized_trigger_turn(&issuer, namespace, true)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        f.handle.pending_timer_trigger_namespaces(10).await.unwrap(),
        vec![namespace]
    );
    // The clock cadence is untouched by event runs.
    assert!(next_due(&f, namespace).await >= policy::FOREVER_MS);
    // A pause drops what arrives during it.
    f.store
        .pause_timer(
            &f.token,
            &f.owner,
            namespace,
            Some(clock(&f).await + 3_600_000),
        )
        .await
        .unwrap();
    assert!(f
        .handle
        .admit_authorized_trigger_turn(&issuer, namespace, true)
        .await
        .unwrap()
        .is_none());
    assert!(f
        .handle
        .pending_timer_trigger_namespaces(10)
        .await
        .unwrap()
        .is_empty());
    finish(f).await;
}

#[tokio::test]
async fn editing_the_schedule_replans_and_refuses_imported_timers() {
    let f = setup().await;
    let namespace = create(
        &f,
        TimerSchedule::Calendar(every_hour_utc()),
        quiet(),
        "edit",
    )
    .await;
    let detail = f
        .store
        .dormant_timer_detail(&f.token, &f.owner, namespace)
        .await
        .unwrap();
    let mut rule = every_hour_utc();
    rule.minutes = vec![30];
    let receipt = f
        .store
        .update_calendar_schedule(
            &f.token,
            &f.owner,
            namespace,
            detail.receipt.revision,
            &TimerSchedule::Calendar(rule.clone()),
        )
        .await
        .unwrap();
    assert_eq!(receipt.revision, detail.receipt.revision + 1);
    assert_eq!(receipt.generation, detail.receipt.generation);
    assert_eq!(next_due(&f, namespace).await % 3_600_000, 1_800_000);
    // Stale revision and identical replays.
    assert!(f
        .store
        .update_calendar_schedule(
            &f.token,
            &f.owner,
            namespace,
            detail.receipt.revision,
            &TimerSchedule::Calendar(rule.clone())
        )
        .await
        .is_err());
    let replay = f
        .store
        .update_calendar_schedule(
            &f.token,
            &f.owner,
            namespace,
            receipt.revision,
            &TimerSchedule::Calendar(rule),
        )
        .await
        .unwrap();
    assert_eq!(replay.revision, receipt.revision);
    // An imported V1 timer cannot be re-scheduled through this path.
    let imported = Uuid::new_v4();
    f.store
        .import_dormant_timer(
            &f.token,
            &f.owner,
            &TimerImportRequest {
                namespace: imported,
                source_namespace: "synthetic-v1".into(),
                source_timer_id: "old".into(),
                source_enabled: true,
                schedule: TimerSchedule::Interval { every_ms: 60_000 },
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        f.store
            .update_calendar_schedule(
                &f.token,
                &f.owner,
                imported,
                1,
                &TimerSchedule::Calendar(every_hour_utc())
            )
            .await,
        Err(HistoryError::Conflict)
    ));
    finish(f).await;
}

async fn enable_old(f: &Case, key: &str) -> Uuid {
    let namespace = Uuid::new_v4();
    f.store
        .import_dormant_timer_for(
            &f.token,
            &f.owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "synthetic-v1".into(),
                source_timer_id: format!("old-{key}"),
                source_enabled: true,
                schedule: TimerSchedule::Interval {
                    every_ms: 3_600_000,
                },
            },
            &TimerTarget {
                conversation_id: f.conversation.clone(),
                label: format!("Old {key}"),
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
                    request_key: format!("enable-old-{key}"),
                    conversation_id: f.conversation.clone(),
                },
                instruction: "Old instruction".into(),
            },
        )
        .await
        .unwrap();
    namespace
}

#[tokio::test]
async fn handing_a_timer_over_never_fires_old_and_new_for_the_same_slot() {
    let f = setup().await;
    let old = enable_old(&f, "triage").await;
    // The old timer had already produced one run before the handoff.
    make_overdue(&f, old).await;
    let before = fire(&f, old).await;
    // Handoff, fence first: the new timer exists paused, the old one goes off.
    let new = Uuid::new_v4();
    let receipt = f
        .store
        .create_calendar_timer(
            &f.token,
            &f.owner,
            &CalendarTimerCreate {
                namespace: new,
                conversation_id: f.conversation.clone(),
                label: "Synthetic new".into(),
                schedule: TimerSchedule::Calendar(every_hour_utc()),
                policy: quiet(),
            },
        )
        .await
        .unwrap();
    assert_eq!(receipt.state, TimerState::Paused);
    make_overdue(&f, old).await;
    assert_eq!(
        due_now(&f).await,
        vec![old],
        "only the old timer is live before the switch"
    );
    f.store
        .revoke_durable_timer(&f.token, &f.owner, old, 2, "handoff-off".into())
        .await
        .unwrap();
    // Old is off even though its slot is overdue; the new timer is not yet enabled.
    assert!(due_now(&f).await.is_empty());
    f.store
        .enable_durable_timer(
            &f.token,
            &f.owner,
            &DurableTimerEnable {
                timer: TimerEnableRequest {
                    namespace: new,
                    expected_revision: receipt.revision,
                    request_key: "handoff-on".into(),
                    conversation_id: f.conversation.clone(),
                },
                instruction: "Old instruction".into(),
            },
        )
        .await
        .unwrap();
    make_overdue(&f, new).await;
    make_overdue(&f, old).await;
    assert_eq!(
        due_now(&f).await,
        vec![new],
        "after the switch only the new timer can fire"
    );
    let first = fire(&f, new).await;
    assert!(!first.duplicate);
    // The old timer can neither be admitted nor claimed again.
    let issuer = f.handle.authorize_timer_scheduler(old).await.unwrap();
    assert!(f
        .handle
        .admit_authorized_timer_turn(&issuer, old, true)
        .await
        .is_err());
    // Replaying the new timer's slot admits nothing more.
    let issuer = f.handle.authorize_timer_scheduler(new).await.unwrap();
    assert!(f
        .handle
        .admit_authorized_timer_turn(&issuer, new, true)
        .await
        .is_err());
    let inputs = f
        .store
        .conversation_timer_inputs(&f.token, &f.owner, &f.conversation, 0, 10)
        .await
        .unwrap();
    assert_eq!(inputs.len(), 2);
    let held = |namespace: Uuid| {
        inputs
            .iter()
            .find(|i| i.namespace == namespace)
            .unwrap()
            .held
    };
    assert!(
        held(old),
        "the old timer's outstanding run is held and never executes"
    );
    assert!(!held(new));
    assert_eq!(before.claim.namespace, old);
    finish(f).await;
}
