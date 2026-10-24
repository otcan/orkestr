use super::*;
use crate::conversation_resources::tests_settings::Case;

fn request(key: &str) -> TrackerCheckRequest {
    TrackerCheckRequest {
        request_key: key.into(),
        expected_source_revision: 1,
        expected_recipe: "job-tracker".into(),
        expected_classifier_id: "synthetic-rules".into(),
        expected_classifier_digest: "ab".repeat(32),
    }
}
async fn create(case: &Case, request: &TrackerCheckRequest) -> Result<TrackerCheckReceipt> {
    case.store
        .create_tracker_check(
            &case.token,
            &case.owner,
            &case.conversation,
            request,
            ("synthetic-rules", &"ab".repeat(32)),
        )
        .await
}
async fn cancel(case: &Case, key: &str) -> TrackerCheckReceipt {
    case.store
        .cancel_tracker_check(&case.token, &case.owner, &case.conversation, key)
        .await
        .unwrap()
}

pub(super) async fn complete_first_check(case: &Case) {
    let created = create(case, &request("verified-first-manual-check"))
        .await
        .unwrap();
    let namespace = created.authority.unwrap().namespace;
    sqlx::query("UPDATE dormant_timers SET next_due_ms=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)-1 WHERE owner_id=? AND namespace=?")
        .bind(case.owner.to_string()).bind(namespace.to_string()).execute(&case.store.pool).await.unwrap();
    let handle = case
        .store
        .authorize_timer_supervisor(&case.token)
        .await
        .unwrap();
    let issuer = handle.authorize_timer_scheduler(namespace).await.unwrap();
    let claim = handle.claim_tracker_scan(&issuer, namespace).await.unwrap();
    handle
        .commit_tracker_scan(&issuer, &claim, &[], "{}", "{}")
        .await
        .unwrap();
}

#[tokio::test]
async fn check_once_is_atomic_typed_bounded_and_exactly_recoverable_after_cancel() {
    let (case, _) = enable_tests::fixture().await;
    let first = create(&case, &request("check-one")).await.unwrap();
    let authority = first.authority.as_ref().unwrap();
    assert!(!first.cancelled && !first.duplicate);
    let handle = case
        .store
        .authorize_timer_supervisor(&case.token)
        .await
        .unwrap();
    let issuer = handle
        .authorize_timer_scheduler(authority.namespace)
        .await
        .unwrap();
    assert_eq!(
        handle
            .timer_work_kind(&issuer, authority.namespace)
            .await
            .unwrap(),
        TimerWorkKind::TrackerScan
    );
    assert_eq!(
        case.count("SELECT count(*) FROM dormant_timers WHERE state='enabled'")
            .await,
        1
    );
    assert_eq!(
        create(&case, &request("check-two")).await,
        Err(HistoryError::Conflict)
    );
    assert!(
        create(&case, &request("check-one"))
            .await
            .unwrap()
            .duplicate
    );
    // Recover the original package decision after an installed-rule upgrade.
    assert!(
        case.store
            .create_tracker_check(
                &case.token,
                &case.owner,
                &case.conversation,
                &request("check-one"),
                ("upgraded-rules", &"cd".repeat(32))
            )
            .await
            .unwrap()
            .duplicate
    );
    let stopped = cancel(&case, "check-one").await;
    assert!(stopped.cancelled && !stopped.duplicate);
    assert!(cancel(&case, "check-one").await.duplicate);
    let replay = create(&case, &request("check-one")).await.unwrap();
    assert!(replay.cancelled && replay.duplicate);
    assert_eq!(replay.authority, first.authority);
    assert_eq!(
        case.count("SELECT count(*) FROM dormant_timers WHERE state='enabled'")
            .await,
        0
    );
    let mut conflict = request("check-one");
    conflict.expected_source_revision = 2;
    assert_eq!(create(&case, &conflict).await, Err(HistoryError::Conflict));
    assert!(create(&case, &request("check-two")).await.is_ok());
    action_tests::assert_no_model_or_chat_work(&case).await;
    case.finish().await;
}

#[tokio::test]
async fn cancellation_before_create_blocks_late_request_without_authority() {
    let (case, _) = enable_tests::fixture().await;
    let stopped = cancel(&case, "delayed-check").await;
    assert!(stopped.cancelled && stopped.authority.is_none());
    let replay = create(&case, &request("delayed-check")).await.unwrap();
    assert!(replay.cancelled && replay.duplicate && replay.authority.is_none());
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_manual_checks")
            .await,
        0
    );
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_scan_authorities")
            .await,
        0
    );
    let other = case.conversation("other").await;
    assert_eq!(
        case.store
            .tracker_check_receipt(&case.token, &case.owner, &other, "delayed-check")
            .await,
        Err(HistoryError::NotFound)
    );
    assert_eq!(
        case.store
            .cancel_tracker_check("invalid-session", &case.owner, &case.conversation, "check")
            .await,
        Err(HistoryError::Unauthorized)
    );
    case.finish().await;
}

#[tokio::test]
async fn check_factory_failure_rolls_back_timer_guard_and_scan_authority() {
    let (case, _) = enable_tests::fixture().await;
    let before = case.count("SELECT count(*) FROM dormant_timers").await;
    sqlx::raw_sql("CREATE TRIGGER synthetic_check_failure BEFORE INSERT ON tracker_manual_checks BEGIN SELECT RAISE(ABORT,'synthetic check failure'); END;")
        .execute(&case.store.pool).await.unwrap();
    assert!(create(&case, &request("atomic-check")).await.is_err());
    assert_eq!(
        case.count("SELECT count(*) FROM dormant_timers").await,
        before
    );
    for table in [
        "tracker_manual_checks",
        "dormant_timer_controls",
        "dormant_timer_input_guards",
        "tracker_scan_authorities",
    ] {
        assert_eq!(
            case.count(&format!("SELECT count(*) FROM {table}")).await,
            0,
            "{table}"
        );
    }
    case.finish().await;
}

#[tokio::test]
async fn source_revocation_fences_inflight_result_and_old_retry_preserves_new_source() {
    let (case, enable, handle, issuer) = action_tests::enabled().await;
    let claim = handle
        .claim_tracker_scan(&issuer, enable.timer.namespace)
        .await
        .unwrap();
    let remove = TrackerSourceRemove {
        request_key: "remove-source".into(),
        expected_revision: 1,
    };
    let removed = case
        .store
        .remove_tracker_scan_source(&case.token, &case.owner, &case.conversation, &remove)
        .await
        .unwrap();
    assert_eq!(removed.source_revision, 2);
    assert!(handle
        .commit_tracker_scan(&issuer, &claim, &[], "{}", "{}")
        .await
        .is_err());
    assert_eq!(
        case.count("SELECT count(*) FROM dormant_timer_claims")
            .await,
        0
    );
    case.store
        .select_tracker_scan_source(
            &case.token,
            &case.owner,
            &case.conversation,
            &TrackerSourceSelect {
                request_key: "replacement".into(),
                expected_revision: 2,
                acknowledge_read_only_access: true,
                source: SelectedMailSource {
                    source_id: Uuid::new_v4(),
                    inbox: vec![Uuid::new_v4()],
                    sent: vec![Uuid::new_v4()],
                },
            },
        )
        .await
        .unwrap();
    let replay = case
        .store
        .remove_tracker_scan_source(&case.token, &case.owner, &case.conversation, &remove)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.source_revision, 2);
    assert_eq!(case.count("SELECT source_revision FROM trackers").await, 3);
    assert_eq!(
        case.count("SELECT count(*) FROM trackers WHERE source_json IS NOT NULL")
            .await,
        1
    );
    assert_eq!(
        case.store
            .remove_tracker_scan_source(
                &case.token,
                &case.owner,
                &case.conversation,
                &TrackerSourceRemove {
                    request_key: "stale-remove".into(),
                    expected_revision: 2,
                }
            )
            .await,
        Err(HistoryError::Conflict)
    );
    action_tests::assert_no_model_or_chat_work(&case).await;
    case.finish().await;
}
