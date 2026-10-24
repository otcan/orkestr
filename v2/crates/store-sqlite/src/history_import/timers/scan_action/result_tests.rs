use super::action_tests::{assert_no_model_or_chat_work, cursor, enabled};
use super::*;
use crate::tracker::ScannedMessage;
use orkestr_v2_contracts::{TrackerEnable, TrackerEventInput, TrackerEventKind};

fn classified() -> Vec<ScannedMessage> {
    let reference = "a".repeat(24);
    vec![ScannedMessage {
        message_ref: reference.clone(),
        outcome: Ok(vec![TrackerEventInput {
            kind: TrackerEventKind::Applied,
            company: "Tailspin Toys".into(),
            role: Some("Rust Engineer".into()),
            location: None,
            source: "mail".into(),
            link: None,
            occurred_ms: 1_000,
            message_ref: Some(reference),
            sender_domain: Some("example.test".into()),
            evidence: Some("Synthetic evidence must be hashed".into()),
            classifier: "synthetic-rules-v1".into(),
            confidence: 95,
            next_step: None,
            thread_refs: vec![],
            requires_thread: false,
        }]),
    }]
}

#[tokio::test]
async fn oversized_classified_batch_does_not_advance_cursor_or_occurrence() {
    let (case, request, handle, issuer) = enabled().await;
    let claim = handle
        .claim_tracker_scan(&issuer, request.timer.namespace)
        .await
        .unwrap();
    let mut messages = Vec::new();
    for index in 0..3 {
        let reference = format!("{index:024x}");
        let mut event = classified().remove(0).outcome.unwrap().remove(0);
        event.message_ref = Some(reference.clone());
        messages.push(ScannedMessage {
            message_ref: reference,
            outcome: Ok(vec![event; 100]),
        });
    }
    assert_eq!(
        handle
            .commit_tracker_scan(&issuer, &claim, &messages, "{}", "{}")
            .await,
        Err(HistoryError::Invalid)
    );
    assert!(cursor(&case).await.is_none());
    for table in [
        "tracker_rows",
        "tracker_scan_receipts",
        "dormant_timer_claims",
        "tracker_action_digests",
    ] {
        assert_eq!(
            case.count(&format!("SELECT count(*) FROM {table}")).await,
            0
        );
    }
    case.finish().await;
}

#[tokio::test]
async fn structured_news_commits_one_ui_digest_with_evidence_and_recovers_after_stop() {
    let (case, request, handle, issuer) = enabled().await;
    let claim = handle
        .claim_tracker_scan(&issuer, request.timer.namespace)
        .await
        .unwrap();
    let messages = classified();
    sqlx::raw_sql("CREATE TRIGGER synthetic_digest_failure BEFORE INSERT ON tracker_action_digests BEGIN SELECT RAISE(ABORT,'synthetic UI digest failure'); END;")
        .execute(&case.store.pool).await.unwrap();
    assert!(handle
        .commit_tracker_scan(&issuer, &claim, &messages, "{}", "{}")
        .await
        .is_err());
    for table in [
        "tracker_rows",
        "tracker_events",
        "tracker_ledger",
        "tracker_scan_receipts",
        "tracker_action_digests",
        "dormant_timer_claims",
    ] {
        assert_eq!(
            case.count(&format!("SELECT count(*) FROM {table}")).await,
            0
        );
    }
    assert_eq!(cursor(&case).await, None);
    sqlx::query("DROP TRIGGER synthetic_digest_failure")
        .execute(&case.store.pool)
        .await
        .unwrap();
    let first = handle
        .commit_tracker_scan(&issuer, &claim, &messages, "{}", "{}")
        .await
        .unwrap();
    assert!(first.news);
    assert!(first.digest_id.is_some());
    assert_eq!(first.labelled, 1);
    for table in [
        "tracker_rows",
        "tracker_events",
        "tracker_ledger",
        "tracker_scan_receipts",
        "tracker_action_digests",
        "dormant_timer_claims",
    ] {
        assert_eq!(
            case.count(&format!("SELECT count(*) FROM {table}")).await,
            1
        );
    }
    let evidence: String = sqlx::query_scalar("SELECT evidence FROM tracker_events")
        .fetch_one(&case.store.pool)
        .await
        .unwrap();
    assert!(evidence.starts_with("sha256:"));
    assert!(!evidence.contains("Synthetic evidence"));
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
                request_key: "stop-after-result".into(),
                action: TimerControl::Stop,
            },
        )
        .await
        .unwrap();
    let replay = handle
        .commit_tracker_scan(&issuer, &claim, &messages, "{}", "{}")
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.id, first.id);
    assert_eq!(replay.digest_id, first.digest_id);
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_action_digests")
            .await,
        1
    );
    assert_no_model_or_chat_work(&case).await;
    case.finish().await;
}

#[tokio::test]
async fn recipe_change_refuses_old_result_and_old_authority() {
    let (case, request, handle, issuer) = enabled().await;
    let claim = handle
        .claim_tracker_scan(&issuer, request.timer.namespace)
        .await
        .unwrap();
    case.store
        .enable_tracker(
            &case.token,
            &case.owner,
            &case.conversation,
            &TrackerEnable {
                recipe: "other-synthetic-recipe".into(),
                notify_on: vec![],
            },
        )
        .await
        .unwrap();
    assert!(handle
        .commit_tracker_scan(&issuer, &claim, &classified(), "{}", "{}")
        .await
        .is_err());
    handle.abandon_tracker_scan(&issuer, &claim).await.unwrap();
    assert!(handle
        .claim_tracker_scan(&issuer, request.timer.namespace)
        .await
        .is_err());
    assert_eq!(
        case.count("SELECT count(*) FROM dormant_timer_claims")
            .await,
        0
    );
    assert_eq!(case.count("SELECT count(*) FROM tracker_rows").await, 0);
    assert_eq!(cursor(&case).await, None);
    assert_no_model_or_chat_work(&case).await;
    case.finish().await;
}

#[tokio::test]
async fn stop_and_issuer_logout_fence_an_in_flight_result() {
    for stop in [true, false] {
        let (case, request, handle, issuer) = enabled().await;
        let claim = handle
            .claim_tracker_scan(&issuer, request.timer.namespace)
            .await
            .unwrap();
        if stop {
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
                        request_key: "stop-during-read".into(),
                        action: TimerControl::Stop,
                    },
                )
                .await
                .unwrap();
        } else {
            case.store.revoke_session(&case.token).await.unwrap();
        }
        assert!(handle
            .commit_tracker_scan(&issuer, &claim, &classified(), "{}", "{}")
            .await
            .is_err());
        for table in [
            "tracker_rows",
            "tracker_scan_receipts",
            "dormant_timer_claims",
        ] {
            assert_eq!(
                case.count(&format!("SELECT count(*) FROM {table}")).await,
                0
            );
        }
        assert_no_model_or_chat_work(&case).await;
        case.finish().await;
    }
}

#[tokio::test]
async fn store_clock_rejects_an_actually_expired_attempt_and_retries_same_occurrence() {
    let (case, request, handle, issuer) = enabled().await;
    let mut claim = handle
        .claim_tracker_scan(&issuer, request.timer.namespace)
        .await
        .unwrap();
    handle.abandon_tracker_scan(&issuer, &claim).await.unwrap();
    let old = claim.id;
    claim.id = Uuid::new_v4();
    claim.attempt = 2;
    let now: i64 =
        sqlx::query_scalar("SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)")
            .fetch_one(&case.store.pool)
            .await
            .unwrap();
    claim.deadline_ms = now - 1;
    // Backdated synthetic fixture, with every production FK/immutability guard
    // still enabled. No sleep or weakened production clock is involved.
    sqlx::query("INSERT INTO tracker_scan_attempts(id,owner_id,namespace,generation,conversation_id,authority_id,due_ms,attempt,source_revision,classifier_digest,stop_sequence,deadline_ms,issuer_key,state,created_ms) SELECT ?,owner_id,namespace,generation,conversation_id,authority_id,due_ms,2,source_revision,classifier_digest,stop_sequence,?,issuer_key,'reading',? FROM tracker_scan_attempts WHERE id=?")
        .bind(claim.id.to_string()).bind(claim.deadline_ms).bind(now-20_000).bind(old.to_string()).execute(&case.store.pool).await.unwrap();
    assert!(handle
        .commit_tracker_scan(&issuer, &claim, &classified(), "{}", "{}")
        .await
        .is_err());
    let retry = handle
        .claim_tracker_scan(&issuer, request.timer.namespace)
        .await
        .unwrap();
    assert_eq!(retry.due_ms, claim.due_ms);
    assert_eq!(retry.attempt, 3);
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_scan_attempts WHERE state='expired'")
            .await,
        1
    );
    assert_eq!(
        case.count("SELECT count(*) FROM dormant_timer_claims")
            .await,
        0
    );
    assert_no_model_or_chat_work(&case).await;
    case.finish().await;
}
