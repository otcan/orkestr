use super::*;
const TOKEN: &str = "synthetic-timer-token";
const NOW: i64 = 1_767_225_600_000; // 2026-01-01T00:00Z

async fn fixture() -> (Store, OwnerId, ConversationId, std::path::PathBuf) {
    let directory = std::env::temp_dir().join(format!("timer-leaf-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let store = Store::open(&directory.join("store.sqlite3")).await.unwrap();
    let conversation = store
        .setup("synthetic-timer-owner", "synthetic-password-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-timer-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    store.save_session(TOKEN, &owner).await.unwrap();
    // Isolated leaf harness only. Once Core registers migration 0027 it is already
    // present and this branch is not used. No production initializer is exposed.
    let exists: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='dormant_timers'",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    if exists == 0 {
        sqlx::raw_sql(include_str!("schema-proposal.sql"))
            .execute(&store.pool)
            .await
            .unwrap();
    }
    (store, owner, conversation, directory)
}
async fn cleanup(store: Store, directory: std::path::PathBuf) {
    store.close().await;
    std::fs::remove_dir_all(directory).unwrap();
}
fn input() -> TimerImportRequest {
    TimerImportRequest {
        namespace: Uuid::from_u128(100),
        source_namespace: "synthetic-source".into(),
        source_timer_id: "fake-timer-a".into(),
        source_enabled: true,
        schedule: TimerSchedule::Interval { every_ms: 60_000 },
    }
}
fn enable(request: &TimerImportRequest, conversation: &ConversationId) -> TimerEnableRequest {
    TimerEnableRequest {
        namespace: request.namespace,
        expected_revision: 1,
        request_key: "fake-enable-a".into(),
        conversation_id: conversation.clone(),
    }
}
fn claim(request: &TimerImportRequest, receipt: &TimerReceipt) -> TimerClaimRequest {
    TimerClaimRequest {
        namespace: request.namespace,
        generation: receipt.generation,
        request_key: "fake-claim-a".into(),
        due_ms: receipt.next_due_ms.unwrap(),
    }
}
async fn inert_counts(store: &Store) -> Vec<i64> {
    let mut counts = Vec::new();
    for table in [
        "messages",
        "events",
        "reasoning_inbox",
        "outbox",
        "production_runs",
    ] {
        // Fixed test-only table constants, never caller SQL.
        counts.push(
            sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&store.pool)
                .await
                .unwrap(),
        );
    }
    counts
}

#[test]
fn source_digest_and_clock_are_bounded_and_deterministic() {
    let request = input();
    assert_eq!(
        timer_source_digest(&request).unwrap(),
        timer_source_digest(&request).unwrap()
    );
    let mut changed = request.clone();
    changed.source_enabled = false;
    assert_ne!(
        timer_source_digest(&request).unwrap(),
        timer_source_digest(&changed).unwrap()
    );
    assert_eq!(
        schedule::next(
            &TimerSchedule::UtcClock {
                weekly: true,
                minute_of_day: 540
            },
            NOW
        )
        .unwrap(),
        NOW + 9 * 3_600_000
    );
    assert_eq!(
        schedule::next(
            &TimerSchedule::UtcClock {
                weekly: true,
                minute_of_day: 540
            },
            NOW + 9 * 3_600_000
        )
        .unwrap(),
        NOW + 7 * 86_400_000 + 9 * 3_600_000
    );
    assert_eq!(
        schedule::next(&TimerSchedule::Once { due_ms: NOW }, NOW),
        Err(HistoryError::Conflict)
    );
    for every_ms in [-1, 0, 59_999, i64::MAX] {
        assert_eq!(
            schedule::encode(&TimerSchedule::Interval { every_ms }),
            Err(HistoryError::Invalid)
        );
    }
}

#[tokio::test]
async fn import_is_dormant_replay_deduped_and_conflicts_refuse() {
    let (store, owner, _, directory) = fixture().await;
    let before = inert_counts(&store).await;
    let request = input();
    let receipt = store
        .import_dormant_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    assert_eq!(receipt.state, TimerState::Paused);
    assert_eq!(receipt.generation, 0);
    assert_eq!(receipt.next_due_ms, None);
    assert_eq!(
        store
            .import_dormant_timer(TOKEN, &owner, &request)
            .await
            .unwrap(),
        receipt
    );
    let mut changed = request.clone();
    changed.schedule = TimerSchedule::Interval { every_ms: 120_000 };
    assert_eq!(
        store.import_dormant_timer(TOKEN, &owner, &changed).await,
        Err(HistoryError::Conflict)
    );
    changed = request.clone();
    changed.namespace = Uuid::from_u128(101);
    assert_eq!(
        store.import_dormant_timer(TOKEN, &owner, &changed).await,
        Err(HistoryError::Conflict)
    );
    assert_eq!(inert_counts(&store).await, before);
    cleanup(store, directory).await;
}

#[tokio::test]
async fn enable_claim_and_reopen_are_durable_without_native_admission() {
    let (store, owner, conversation, directory) = fixture().await;
    let before = inert_counts(&store).await;
    let request = input();
    store
        .import_dormant_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    let enabling = enable(&request, &conversation);
    let enabled = store
        .enable_dormant_timer(TOKEN, &owner, &enabling, NOW)
        .await
        .unwrap();
    assert_eq!(enabled.state, TimerState::Enabled);
    assert_eq!(
        store
            .enable_dormant_timer(TOKEN, &owner, &enabling, NOW + 1000)
            .await
            .unwrap(),
        enabled
    );
    let claiming = claim(&request, &enabled);
    assert_eq!(
        store
            .claim_dormant_timer(TOKEN, &owner, &claiming, NOW)
            .await,
        Err(HistoryError::Conflict)
    );
    let claimed = store
        .claim_dormant_timer(TOKEN, &owner, &claiming, NOW + 60_000)
        .await
        .unwrap();
    assert_eq!(claimed.source_digest, enabled.source_digest);
    store.close().await;
    let reopened = Store::open(&directory.join("store.sqlite3")).await.unwrap();
    assert_eq!(
        reopened
            .claim_dormant_timer(TOKEN, &owner, &claiming, NOW + 120_000)
            .await
            .unwrap(),
        claimed
    );
    let mut duplicate = claiming.clone();
    duplicate.request_key = "fake-other-key".into();
    assert_eq!(
        reopened
            .claim_dormant_timer(TOKEN, &owner, &duplicate, NOW + 120_000)
            .await,
        Err(HistoryError::Conflict)
    );
    assert_eq!(inert_counts(&reopened).await, before);
    cleanup(reopened, directory).await;
}

#[tokio::test]
async fn every_control_fences_old_enable_and_claim_replay() {
    for action in [
        TimerControl::Disable,
        TimerControl::Stop,
        TimerControl::Rollback,
    ] {
        let (store, owner, conversation, directory) = fixture().await;
        let request = input();
        store
            .import_dormant_timer(TOKEN, &owner, &request)
            .await
            .unwrap();
        let enabling = enable(&request, &conversation);
        let enabled = store
            .enable_dormant_timer(TOKEN, &owner, &enabling, NOW)
            .await
            .unwrap();
        let claiming = claim(&request, &enabled);
        store
            .claim_dormant_timer(TOKEN, &owner, &claiming, NOW + 60_000)
            .await
            .unwrap();
        let controlling = TimerControlRequest {
            namespace: request.namespace,
            expected_revision: enabled.revision,
            request_key: "fake-control-a".into(),
            action,
        };
        let controlled = store
            .control_dormant_timer(TOKEN, &owner, &controlling)
            .await
            .unwrap();
        assert_eq!(
            store
                .control_dormant_timer(TOKEN, &owner, &controlling)
                .await
                .unwrap(),
            controlled
        );
        assert_eq!(
            store
                .enable_dormant_timer(TOKEN, &owner, &enabling, NOW)
                .await,
            Err(HistoryError::Conflict)
        );
        assert_eq!(
            store
                .claim_dormant_timer(TOKEN, &owner, &claiming, NOW + 60_000)
                .await,
            Err(HistoryError::Conflict)
        );
        // Import replay cannot resurrect either a disabled or terminal timer.
        assert_eq!(
            store
                .import_dormant_timer(TOKEN, &owner, &request)
                .await
                .unwrap(),
            controlled
        );
        let new_enable = TimerEnableRequest {
            expected_revision: controlled.revision,
            request_key: "fake-new-enable".into(),
            ..enabling
        };
        if action == TimerControl::Disable {
            let newer = store
                .enable_dormant_timer(TOKEN, &owner, &new_enable, NOW + 60_000)
                .await
                .unwrap();
            assert!(newer.generation > controlled.generation);
            assert_eq!(
                store
                    .claim_dormant_timer(TOKEN, &owner, &claiming, NOW + 60_000)
                    .await,
                Err(HistoryError::Conflict)
            );
        } else {
            assert_eq!(
                store
                    .enable_dormant_timer(TOKEN, &owner, &new_enable, NOW)
                    .await,
                Err(HistoryError::Conflict)
            );
        }
        cleanup(store, directory).await;
    }
}

#[tokio::test]
async fn uncertain_timezone_remains_paused_with_explicit_reason() {
    let (store, owner, conversation, directory) = fixture().await;
    for (index, reason) in [
        DormantTimerReason::MissingTimezone,
        DormantTimerReason::UnsupportedTimezone,
        DormantTimerReason::AmbiguousCadence,
        DormantTimerReason::UncertainEffects,
    ]
    .into_iter()
    .enumerate()
    {
        let request = TimerImportRequest {
            namespace: Uuid::from_u128(200 + index as u128),
            source_timer_id: format!("fake-dormant-{index}"),
            schedule: TimerSchedule::Dormant {
                cadence: "weekly".into(),
                timezone: Some("Synthetic/Unknown".into()),
                time: Some("09:00".into()),
                every: None,
                run_at: None,
                reason,
            },
            ..input()
        };
        let imported = store
            .import_dormant_timer(TOKEN, &owner, &request)
            .await
            .unwrap();
        assert_eq!(imported.state, TimerState::Paused);
        assert!(imported.dormant_reason.is_some());
        assert_eq!(
            store
                .enable_dormant_timer(TOKEN, &owner, &enable(&request, &conversation), NOW)
                .await,
            Err(HistoryError::Conflict)
        );
    }
    cleanup(store, directory).await;
}

#[tokio::test]
async fn auth_target_revision_and_request_key_conflicts_refuse() {
    let (store, owner, conversation, directory) = fixture().await;
    let request = input();
    store
        .import_dormant_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    let mut enabling = enable(&request, &conversation);
    enabling.expected_revision = 9;
    assert_eq!(
        store
            .enable_dormant_timer(TOKEN, &owner, &enabling, NOW)
            .await,
        Err(HistoryError::Conflict)
    );
    enabling.expected_revision = 1;
    enabling.conversation_id = ConversationId(Uuid::from_u128(999));
    assert_eq!(
        store
            .enable_dormant_timer(TOKEN, &owner, &enabling, NOW)
            .await,
        Err(HistoryError::NotFound)
    );
    enabling.conversation_id = conversation;
    let enabled = store
        .enable_dormant_timer(TOKEN, &owner, &enabling, NOW)
        .await
        .unwrap();
    enabling.expected_revision = enabled.revision;
    assert_eq!(
        store
            .enable_dormant_timer(TOKEN, &owner, &enabling, NOW)
            .await,
        Err(HistoryError::Conflict)
    );
    sqlx::query("DELETE FROM auth_sessions")
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        store.import_dormant_timer(TOKEN, &owner, &request).await,
        Err(HistoryError::Unauthorized)
    );
    assert_eq!(
        store
            .enable_dormant_timer(TOKEN, &owner, &enabling, NOW)
            .await,
        Err(HistoryError::Unauthorized)
    );
    assert_eq!(
        store
            .claim_dormant_timer(TOKEN, &owner, &claim(&request, &enabled), NOW + 60_000)
            .await,
        Err(HistoryError::Unauthorized)
    );
    cleanup(store, directory).await;
}

#[tokio::test]
async fn two_pool_claim_race_has_one_durable_occurrence() {
    let (store, owner, conversation, directory) = fixture().await;
    let request = input();
    store
        .import_dormant_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    let enabled = store
        .enable_dormant_timer(TOKEN, &owner, &enable(&request, &conversation), NOW)
        .await
        .unwrap();
    let second = Store::open(&directory.join("store.sqlite3")).await.unwrap();
    let left = claim(&request, &enabled);
    let mut right = left.clone();
    right.request_key = "fake-race-b".into();
    let (a, b) = tokio::join!(
        store.claim_dormant_timer(TOKEN, &owner, &left, NOW + 60_000),
        second.claim_dormant_timer(TOKEN, &owner, &right, NOW + 60_000)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM dormant_timer_claims")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    second.close().await;
    cleanup(store, directory).await;
}

#[tokio::test]
async fn failed_claim_transaction_leaves_no_partial_occurrence() {
    let (store, owner, conversation, directory) = fixture().await;
    let request = input();
    store
        .import_dormant_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    let enabled = store
        .enable_dormant_timer(TOKEN, &owner, &enable(&request, &conversation), NOW)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TRIGGER synthetic_timer_failure BEFORE UPDATE ON dormant_timers BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").execute(&store.pool).await.unwrap();
    assert_eq!(
        store
            .claim_dormant_timer(TOKEN, &owner, &claim(&request, &enabled), NOW + 60_000)
            .await,
        Err(HistoryError::Unavailable)
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM dormant_timer_claims")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(
        store
            .dormant_timer_receipt(TOKEN, &owner, request.namespace)
            .await
            .unwrap(),
        enabled
    );
    cleanup(store, directory).await;
}

#[path = "input_atomic_tests.rs"]
mod input_atomic_tests;
#[path = "input_tests.rs"]
mod input_tests;

#[test]
fn top_of_hour_spread_is_deterministic_bounded_and_keeps_exact_schedules() {
    use orkestr_v2_contracts::CalendarRule;
    const HOUR: i64 = 3_600_000;
    let ns = Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap();
    let spread = schedule::spread_ms(ns);
    assert_eq!(spread, schedule::spread_ms(ns));
    assert!((0..=schedule::SPREAD_MAX_MS).contains(&spread) && spread % 1000 == 0);
    // Different timers land on different offsets inside the bound.
    let offsets: std::collections::BTreeSet<i64> = (1..=64_u128)
        .map(|n| schedule::spread_ms(Uuid::from_u128(n)))
        .collect();
    assert!(offsets.len() > 32);
    assert!(offsets
        .iter()
        .all(|o| (0..=schedule::SPREAD_MAX_MS).contains(o)));
    let s = 300_000; // explicit five minute spread
    let on_hour = TimerSchedule::UtcClock {
        weekly: false,
        minute_of_day: 13 * 60,
    };
    assert_eq!(
        schedule::next_spread(&on_hour, s, NOW),
        Ok(NOW + 13 * HOUR + s)
    );
    // Between the natural time and the spread time the same occurrence is still next.
    assert_eq!(
        schedule::next_spread(&on_hour, s, NOW + 13 * HOUR + 1),
        Ok(NOW + 13 * HOUR + s)
    );
    // Claimed at its spread time, the next run is tomorrow's, never the same one twice.
    assert_eq!(
        schedule::next_spread(&on_hour, s, NOW + 13 * HOUR + s),
        Ok(NOW + 37 * HOUR + s)
    );
    // Off-the-hour, interval and one-shot timers stay exact.
    let minute = TimerSchedule::UtcClock {
        weekly: false,
        minute_of_day: 13 * 60 + 5,
    };
    assert_eq!(
        schedule::next_spread(&minute, s, NOW),
        schedule::next(&minute, NOW)
    );
    let interval = TimerSchedule::Interval { every_ms: HOUR };
    assert_eq!(schedule::next_spread(&interval, s, NOW), Ok(NOW + HOUR));
    let once = TimerSchedule::Once { due_ms: NOW + HOUR };
    assert_eq!(schedule::next_spread(&once, s, NOW), Ok(NOW + HOUR));
    // Hourly calendar window 09:00-20:00 UTC: inner hours are spread, the last
    // run of the window stays exact so a run never leaves the window.
    let window = TimerSchedule::Calendar(
        CalendarRule {
            timezone: "UTC".into(),
            weekdays: vec![],
            start_minute: 9 * 60,
            end_minute: 20 * 60,
            every_hours: 1,
            minutes: vec![0],
        }
        .normalized()
        .unwrap(),
    );
    assert_eq!(
        schedule::next_spread(&window, s, NOW),
        Ok(NOW + 9 * HOUR + s)
    );
    assert_eq!(
        schedule::next_spread(&window, s, NOW + 19 * HOUR + s),
        Ok(NOW + 20 * HOUR)
    );
    assert_eq!(
        schedule::next_spread(&window, s, NOW + 20 * HOUR),
        Ok(NOW + 33 * HOUR + s)
    );
    // Calendar rules with explicit minutes are exact.
    let half = TimerSchedule::Calendar(
        CalendarRule {
            timezone: "UTC".into(),
            weekdays: vec![],
            start_minute: 9 * 60,
            end_minute: 20 * 60,
            every_hours: 1,
            minutes: vec![0, 30],
        }
        .normalized()
        .unwrap(),
    );
    assert_eq!(schedule::next_spread(&half, s, NOW), Ok(NOW + 9 * HOUR));
    // Zoned wall-clock timers on the hour are spread too.
    let zoned = TimerSchedule::ZonedClock {
        timezone: "Europe/Berlin".into(),
        weekday: None,
        minute_of_day: 13 * 60,
    };
    assert_eq!(
        schedule::next_spread(&zoned, s, NOW),
        Ok(NOW + 12 * HOUR + s)
    );
    assert_eq!(
        schedule::next_for(&zoned, ns, NOW),
        Ok(NOW + 12 * HOUR + spread)
    );
}

/// A slot fired at its raw (unspread) time never comes back at `slot + spread`.
#[test]
fn a_fired_slot_is_never_rescheduled_at_its_spread_time() {
    const HOUR: i64 = 3_600_000;
    let s = 300_000;
    let on_hour = TimerSchedule::UtcClock {
        weekly: false,
        minute_of_day: 13 * 60,
    };
    let raw = NOW + 13 * HOUR;
    // Claimed at the raw slot time (a next_due stored before the spread existed).
    assert_eq!(
        schedule::next_spread_after(&on_hour, s, raw + 250, Some(raw)),
        Ok(raw + 24 * HOUR + s)
    );
    // The unguarded variant is what double fired: same slot, spread time.
    assert_eq!(schedule::next_spread(&on_hour, s, raw + 250), Ok(raw + s));
    // Claimed at the spread time: tomorrow, as before.
    assert_eq!(
        schedule::next_spread_after(&on_hour, s, raw + s, Some(raw + s)),
        Ok(raw + 24 * HOUR + s)
    );
    // An older fired slot does not hide a pending one.
    assert_eq!(
        schedule::next_spread_after(&on_hour, s, raw + 1, Some(raw - 24 * HOUR + s)),
        Ok(raw + s)
    );
    // A pause or skip that walks forward keeps the fired slot excluded.
    let supp = policy_pause::Suppression {
        until: raw + 60_000,
        skip: vec![],
        zone: "UTC".into(),
    };
    assert_eq!(
        policy_pause::first_allowed(&supp, &on_hour, s, Some(raw), raw + 24 * HOUR + s),
        raw + 24 * HOUR + s
    );
}

fn spread_namespace() -> Uuid {
    (1..=64_u128)
        .map(Uuid::from_u128)
        .find(|ns| schedule::spread_ms(*ns) >= 60_000)
        .unwrap()
}

async fn next_due(store: &Store, owner: &OwnerId, namespace: Uuid) -> Option<i64> {
    store
        .dormant_timer_receipt(TOKEN, owner, namespace)
        .await
        .unwrap()
        .next_due_ms
}

/// Regression for the post-#354 double fire: a recurring timer whose stored
/// next_due_ms is the raw top-of-the-hour time (computed before the spread was
/// deployed) fires once at that time, then not again at the spread time of the
/// same slot, also not after a pause refresh or a re-enable inside the window.
#[tokio::test]
async fn pre_spread_stored_next_due_fires_exactly_once_per_slot() {
    const HOUR: i64 = 3_600_000;
    let (store, owner, conversation, directory) = fixture().await;
    let namespace = spread_namespace();
    let spread = schedule::spread_ms(namespace);
    let request = TimerImportRequest {
        namespace,
        schedule: TimerSchedule::UtcClock {
            weekly: false,
            minute_of_day: 8 * 60,
        },
        ..input()
    };
    store
        .import_dormant_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    let enabled = store
        .enable_dormant_timer(TOKEN, &owner, &enable(&request, &conversation), NOW)
        .await
        .unwrap();
    let raw = NOW + 8 * HOUR;
    assert_eq!(enabled.next_due_ms, Some(raw + spread));
    // Simulate the row as written by the pre-spread binary: raw slot time.
    sqlx::query("UPDATE dormant_timers SET next_due_ms=? WHERE namespace=?")
        .bind(raw)
        .bind(namespace.to_string())
        .execute(&store.pool)
        .await
        .unwrap();
    let mut first = claim(&request, &enabled);
    first.due_ms = raw;
    store
        .claim_dormant_timer(TOKEN, &owner, &first, raw + 400)
        .await
        .unwrap();
    let tomorrow = raw + 24 * HOUR + spread;
    assert_eq!(next_due(&store, &owner, namespace).await, Some(tomorrow));
    // The spread time of the fired slot is not claimable.
    let mut second = first.clone();
    second.request_key = "fake-claim-b".into();
    second.due_ms = raw + spread;
    assert_eq!(
        store
            .claim_dormant_timer(TOKEN, &owner, &second, raw + spread)
            .await,
        Err(HistoryError::Conflict)
    );
    // A pause/policy refresh inside the spread window keeps tomorrow.
    let mut tx = store
        .history_transaction(TOKEN, &owner, true)
        .await
        .unwrap();
    policy_pause::refresh_timer(&mut tx, &owner, namespace, raw + 60_000, false)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(next_due(&store, &owner, namespace).await, Some(tomorrow));
    // Disable and re-enable inside the window: still tomorrow, not today + spread.
    let paused = store
        .control_dormant_timer(
            TOKEN,
            &owner,
            &TimerControlRequest {
                namespace,
                expected_revision: enabled.revision,
                request_key: "fake-disable-a".into(),
                action: TimerControl::Disable,
            },
        )
        .await
        .unwrap();
    let mut again = enable(&request, &conversation);
    again.expected_revision = paused.revision;
    again.request_key = "fake-enable-b".into();
    let reenabled = store
        .enable_dormant_timer(TOKEN, &owner, &again, raw + 90_000)
        .await
        .unwrap();
    assert_eq!(reenabled.next_due_ms, Some(tomorrow));
    // Tomorrow's slot fires once, at its spread time, then the day after.
    let mut third = claim(&request, &reenabled);
    third.request_key = "fake-claim-c".into();
    store
        .claim_dormant_timer(TOKEN, &owner, &third, tomorrow + 300)
        .await
        .unwrap();
    assert_eq!(
        next_due(&store, &owner, namespace).await,
        Some(tomorrow + 24 * HOUR)
    );
    let fired: i64 =
        sqlx::query_scalar("SELECT count(*) FROM dormant_timer_claims WHERE namespace=?")
            .bind(namespace.to_string())
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(fired, 2);
    cleanup(store, directory).await;
}

/// A one-shot timer on an exact hour is never spread and fires exactly once.
#[tokio::test]
async fn once_timer_on_the_hour_fires_exactly_once() {
    const HOUR: i64 = 3_600_000;
    let (store, owner, conversation, directory) = fixture().await;
    let namespace = spread_namespace();
    let due = NOW + 9 * HOUR;
    let request = TimerImportRequest {
        namespace,
        schedule: TimerSchedule::Once { due_ms: due },
        ..input()
    };
    store
        .import_dormant_timer(TOKEN, &owner, &request)
        .await
        .unwrap();
    let enabled = store
        .enable_dormant_timer(TOKEN, &owner, &enable(&request, &conversation), NOW)
        .await
        .unwrap();
    assert_eq!(enabled.next_due_ms, Some(due));
    store
        .claim_dormant_timer(TOKEN, &owner, &claim(&request, &enabled), due + 200)
        .await
        .unwrap();
    let after = store
        .dormant_timer_receipt(TOKEN, &owner, namespace)
        .await
        .unwrap();
    assert_eq!(after.state, TimerState::Exhausted);
    assert_eq!(after.next_due_ms, None);
    let mut spread_time = claim(&request, &enabled);
    spread_time.request_key = "fake-claim-b".into();
    spread_time.due_ms = due + schedule::spread_ms(namespace);
    assert_eq!(
        store
            .claim_dormant_timer(TOKEN, &owner, &spread_time, spread_time.due_ms)
            .await,
        Err(HistoryError::Conflict)
    );
    cleanup(store, directory).await;
}
