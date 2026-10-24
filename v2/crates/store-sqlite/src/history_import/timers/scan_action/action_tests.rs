//! Action transactions exercise real authority but never read files or run models.
use super::*;
use crate::conversation_resources::tests_settings::Case;
use crate::{tracker::TrackerCaller, TimerSchedulerIssuer};

pub(super) async fn enabled() -> (Case, TrackerScanEnable, Store, TimerSchedulerIssuer) {
    let (case, request) = enable_tests::fixture().await;
    case.store
        .enable_tracker_scan_timer(&case.token, &case.owner, &request)
        .await
        .unwrap();
    sqlx::query("UPDATE dormant_timers SET next_due_ms=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)-1000 WHERE namespace=?")
        .bind(request.timer.namespace.to_string()).execute(&case.store.pool).await.unwrap();
    let handle = case
        .store
        .authorize_timer_supervisor(&case.token)
        .await
        .unwrap();
    let issuer = handle
        .authorize_timer_scheduler(request.timer.namespace)
        .await
        .unwrap();
    (case, request, handle, issuer)
}
pub(super) async fn assert_no_model_or_chat_work(case: &Case) {
    for table in [
        "dormant_timer_inputs",
        "reasoning_inbox",
        "production_runs",
        "execution_window_queue",
        "timer_digests",
    ] {
        assert_eq!(
            case.count(&format!("SELECT count(*) FROM {table}")).await,
            0,
            "{table}"
        );
    }
}
pub(super) async fn cursor(case: &Case) -> Option<String> {
    case.store
        .tracker_config(
            TrackerCaller::Owner {
                credential: &case.token,
                owner: &case.owner,
            },
            &case.conversation,
        )
        .await
        .unwrap()
        .cursor_json
}

#[tokio::test]
async fn read_claim_is_exclusive_and_leaves_occurrence_due_until_atomic_silent_commit() {
    let (case, request, handle, issuer) = enabled().await;
    let before = case
        .store
        .dormant_timer_receipt(&case.token, &case.owner, request.timer.namespace)
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        handle.claim_tracker_scan(&issuer, request.timer.namespace),
        handle.claim_tracker_scan(&issuer, request.timer.namespace)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let claim = match (a, b) {
        (Ok(c), _) | (_, Ok(c)) => c,
        _ => panic!("one read claim must win"),
    };
    assert_eq!(
        claim.read_policy_id(),
        orkestr_v2_contracts::tracker_actions::TRACKER_READ_POLICY_V1
    );
    assert_eq!(
        case.count("SELECT count(*) FROM dormant_timer_claims")
            .await,
        0
    );
    assert_eq!(
        case.store
            .dormant_timer_receipt(&case.token, &case.owner, request.timer.namespace)
            .await
            .unwrap(),
        before
    );
    assert_eq!(cursor(&case).await, None);
    assert!(case
        .store
        .claim_dormant_timer(
            &case.token,
            &case.owner,
            &TimerClaimRequest {
                namespace: claim.namespace,
                generation: claim.generation,
                due_ms: claim.due_ms,
                request_key: "forbidden-inert-claim".into(),
            },
            claim.due_ms
        )
        .await
        .is_err());
    let first = handle
        .commit_tracker_scan(&issuer, &claim, &[], r#"{"seen":[]}"#, r#"{"messages":0}"#)
        .await
        .unwrap();
    assert!(!first.news);
    assert!(first.digest_id.is_none());
    assert!(!first.duplicate);
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_scan_receipts")
            .await,
        1
    );
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_action_digests")
            .await,
        0
    );
    assert_eq!(
        case.count("SELECT count(*) FROM dormant_timer_claims")
            .await,
        1
    );
    assert_eq!(cursor(&case).await.as_deref(), Some(r#"{"seen":[]}"#));
    let after = case
        .store
        .dormant_timer_receipt(&case.token, &case.owner, request.timer.namespace)
        .await
        .unwrap();
    assert!(after.next_due_ms > before.next_due_ms);
    let replay = handle
        .commit_tracker_scan(&issuer, &claim, &[], r#"{"seen":[]}"#, r#"{"messages":0}"#)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.id, first.id);
    assert!(handle
        .commit_tracker_scan(&issuer, &claim, &[], r#"{"seen":[1]}"#, r#"{"messages":0}"#)
        .await
        .is_err());
    assert_eq!(
        case.store
            .tracker_scan_receipt(
                &case.token,
                &case.owner,
                &case.conversation,
                &claim.request_key()
            )
            .await
            .unwrap(),
        replay
    );
    assert_no_model_or_chat_work(&case).await;
    case.finish().await;
}

#[tokio::test]
async fn failed_result_transaction_rolls_back_cursor_claim_schedule_and_receipt() {
    let (case, request, handle, issuer) = enabled().await;
    let before = case
        .store
        .dormant_timer_receipt(&case.token, &case.owner, request.timer.namespace)
        .await
        .unwrap();
    let claim = handle
        .claim_tracker_scan(&issuer, request.timer.namespace)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON tracker_scan_receipts BEGIN SELECT RAISE(ABORT,'synthetic atomic commit failure'); END;")
        .execute(&case.store.pool).await.unwrap();
    assert!(handle
        .commit_tracker_scan(&issuer, &claim, &[], "{}", "{}")
        .await
        .is_err());
    assert_eq!(cursor(&case).await, None);
    assert_eq!(
        case.store
            .dormant_timer_receipt(&case.token, &case.owner, request.timer.namespace)
            .await
            .unwrap(),
        before
    );
    for table in [
        "dormant_timer_claims",
        "tracker_scan_receipts",
        "tracker_action_digests",
    ] {
        assert_eq!(
            case.count(&format!("SELECT count(*) FROM {table}")).await,
            0
        );
    }
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_scan_attempts WHERE state='reading'")
            .await,
        1
    );
    sqlx::query("DROP TRIGGER synthetic_receipt_failure")
        .execute(&case.store.pool)
        .await
        .unwrap();
    assert!(handle
        .commit_tracker_scan(&issuer, &claim, &[], "{}", "{}")
        .await
        .is_ok());
    assert_no_model_or_chat_work(&case).await;
    case.finish().await;
}

#[tokio::test]
async fn changed_source_and_disabled_timer_refuse_old_read_results_without_advancing() {
    for change_source in [true, false] {
        let (case, request, handle, issuer) = enabled().await;
        let claim = handle
            .claim_tracker_scan(&issuer, request.timer.namespace)
            .await
            .unwrap();
        if change_source {
            case.store
                .select_tracker_scan_source(
                    &case.token,
                    &case.owner,
                    &case.conversation,
                    &TrackerSourceSelect {
                        request_key: "replace-during-read".into(),
                        expected_revision: 1,
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
        } else {
            let current = case
                .store
                .dormant_timer_receipt(&case.token, &case.owner, request.timer.namespace)
                .await
                .unwrap();
            case.store
                .control_dormant_timer(
                    &case.token,
                    &case.owner,
                    &TimerControlRequest {
                        namespace: request.timer.namespace,
                        expected_revision: current.revision,
                        request_key: "disable-during-read".into(),
                        action: TimerControl::Disable,
                    },
                )
                .await
                .unwrap();
        }
        let protected = case
            .store
            .dormant_timer_receipt(&case.token, &case.owner, request.timer.namespace)
            .await
            .unwrap();
        assert!(handle
            .commit_tracker_scan(&issuer, &claim, &[], "{}", "{}")
            .await
            .is_err());
        assert_eq!(
            case.store
                .dormant_timer_receipt(&case.token, &case.owner, request.timer.namespace)
                .await
                .unwrap(),
            protected
        );
        assert_eq!(cursor(&case).await, None);
        assert_eq!(
            case.count("SELECT count(*) FROM tracker_scan_receipts")
                .await,
            0
        );
        assert_eq!(
            case.count("SELECT count(*) FROM dormant_timer_claims")
                .await,
            0
        );
        assert_no_model_or_chat_work(&case).await;
        case.finish().await;
    }
}

#[tokio::test]
async fn expired_or_modified_private_claim_cannot_commit_and_failure_keeps_same_occurrence() {
    let (case, request, handle, issuer) = enabled().await;
    let mut claim = handle
        .claim_tracker_scan(&issuer, request.timer.namespace)
        .await
        .unwrap();
    let original_deadline = claim.deadline_ms;
    claim.deadline_ms = 0;
    assert!(handle
        .commit_tracker_scan(&issuer, &claim, &[], "{}", "{}")
        .await
        .is_err());
    claim.deadline_ms = original_deadline + 10_000;
    assert!(handle
        .commit_tracker_scan(&issuer, &claim, &[], "{}", "{}")
        .await
        .is_err());
    claim.deadline_ms = original_deadline;
    handle.abandon_tracker_scan(&issuer, &claim).await.unwrap();
    assert!(handle
        .commit_tracker_scan(&issuer, &claim, &[], "{}", "{}")
        .await
        .is_err());
    let next = handle
        .claim_tracker_scan(&issuer, request.timer.namespace)
        .await
        .unwrap();
    assert_eq!(next.due_ms, claim.due_ms);
    assert_eq!(next.attempt, 2);
    assert_eq!(
        case.count("SELECT count(*) FROM dormant_timer_claims")
            .await,
        0
    );
    assert_no_model_or_chat_work(&case).await;
    case.finish().await;
}
