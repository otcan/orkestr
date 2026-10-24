use super::*;

#[tokio::test]
async fn expired_selection_refuses_new_decisions_but_exact_receipt_is_recoverable() {
    let (case, _) = enable_tests::fixture().await;
    let source = SelectedMailSource {
        source_id: Uuid::new_v4(),
        inbox: vec![Uuid::new_v4()],
        sent: vec![Uuid::new_v4()],
    };
    let backing = TrackerLocalSource {
        source_id: source.source_id,
        backing_json: r#"{"synthetic":"local backing"}"#.into(),
    };
    case.store
        .register_tracker_local_sources(&case.token, &case.owner, &[backing])
        .await
        .unwrap();
    let selection = TrackerSourceSelect {
        request_key: "registered-choice".into(),
        expected_revision: 1,
        source: source.clone(),
        acknowledge_read_only_access: true,
    };
    let receipt = case
        .store
        .select_registered_tracker_scan_source(
            &case.token,
            &case.owner,
            &case.conversation,
            &selection,
        )
        .await
        .unwrap();
    assert_eq!(receipt.source_revision, 2);
    sqlx::query("UPDATE tracker_local_sources SET expires_ms=0")
        .execute(&case.store.pool)
        .await
        .unwrap();
    assert!(case
        .store
        .tracker_local_source_for_selection(&case.token, &case.owner, source.source_id)
        .await
        .is_err());
    let retry = case
        .store
        .select_registered_tracker_scan_source(
            &case.token,
            &case.owner,
            &case.conversation,
            &selection,
        )
        .await
        .unwrap();
    assert!(retry.duplicate);
    assert_eq!(retry.source_revision, 2);
    let mut new = selection.clone();
    new.request_key = "expired-new-choice".into();
    new.expected_revision = 2;
    assert_eq!(
        case.store
            .select_registered_tracker_scan_source(
                &case.token,
                &case.owner,
                &case.conversation,
                &new
            )
            .await,
        Err(HistoryError::Conflict)
    );
    assert_eq!(case.count("SELECT source_revision FROM trackers").await, 2);
    // A discovery refresh prunes expired unselected references, keeping selected
    // references durable. It never selects or enables anything by itself.
    case.store
        .register_tracker_local_sources(&case.token, &case.owner, &[])
        .await
        .unwrap();
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_local_sources")
            .await,
        1
    );
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_scan_authorities")
            .await,
        0
    );
    case.finish().await;
}

#[tokio::test]
async fn selected_backing_and_cursor_require_current_scheduler_claim_and_survive_expiry() {
    let (case, enable, handle, issuer) = action_tests::enabled().await;
    let claim = handle
        .claim_tracker_scan(&issuer, enable.timer.namespace)
        .await
        .unwrap();
    case.store
        .register_tracker_local_sources(
            &case.token,
            &case.owner,
            &[TrackerLocalSource {
                source_id: claim.source().source_id,
                backing_json: "{}".into(),
            }],
        )
        .await
        .unwrap();
    sqlx::query("UPDATE tracker_local_sources SET expires_ms=0")
        .execute(&case.store.pool)
        .await
        .unwrap();
    assert_eq!(
        handle.tracker_scan_material(&issuer, &claim).await.unwrap(),
        ("{}".into(), None)
    );
    assert!(case
        .store
        .tracker_scan_material(&issuer, &claim)
        .await
        .is_err());
    assert!(case
        .store
        .register_tracker_local_sources("bad-session", &case.owner, &[])
        .await
        .is_err());
    let before = handle
        .due_timer_scheduler_candidates(None, 32)
        .await
        .unwrap();
    assert_eq!(before, vec![enable.timer.namespace]);
    case.store
        .remove_tracker_scan_source(
            &case.token,
            &case.owner,
            &case.conversation,
            &TrackerSourceRemove {
                request_key: "revoke".into(),
                expected_revision: 1,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        handle.tracker_scan_material(&issuer, &claim).await,
        Err(HistoryError::Conflict)
    );
    action_tests::assert_no_model_or_chat_work(&case).await;
    case.finish().await;
}
