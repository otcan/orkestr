//! Synthetic owner decisions only: no profile discovery, I/O or model admission.
use super::*;
use crate::conversation_resources::tests_settings::Case;
use crate::tracker::TrackerCaller;
use orkestr_v2_contracts::TrackerEnable;

async fn fixture() -> Case {
    let case = Case::new().await;
    case.store
        .enable_tracker(
            &case.token,
            &case.owner,
            &case.conversation,
            &TrackerEnable {
                recipe: "job-tracker".into(),
                notify_on: vec![],
            },
        )
        .await
        .unwrap();
    case
}
fn request(key: &str, revision: i64) -> TrackerSourceSelect {
    TrackerSourceSelect {
        request_key: key.into(),
        expected_revision: revision,
        source: SelectedMailSource {
            source_id: Uuid::new_v4(),
            inbox: vec![Uuid::new_v4()],
            sent: vec![Uuid::new_v4()],
        },
        acknowledge_read_only_access: true,
    }
}
async fn select(case: &Case, request: &TrackerSourceSelect) -> Result<TrackerSourceReceipt> {
    case.store
        .select_tracker_scan_source(&case.token, &case.owner, &case.conversation, request)
        .await
}

#[tokio::test]
async fn source_needs_explicit_read_only_opt_in_and_both_distinct_mail_folders() {
    let case = fixture().await;
    for variant in 0..5 {
        let mut input = request("invalid", 0);
        match variant {
            0 => input.acknowledge_read_only_access = false,
            1 => input.source.inbox.clear(),
            2 => input.source.sent.clear(),
            3 => input.source.sent = input.source.inbox.clone(),
            _ => input.source.source_id = Uuid::nil(),
        }
        assert_eq!(select(&case, &input).await, Err(HistoryError::Invalid));
    }
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_source_selections")
            .await,
        0
    );
    assert_eq!(
        case.count("SELECT sum(source_revision) FROM trackers")
            .await,
        0
    );
    assert!(
        serde_json::from_str::<SelectedMailSource>(r#"{"profile":"/synthetic/profile"}"#).is_err()
    );
    case.finish().await;
}

#[tokio::test]
async fn source_receipt_recovery_does_not_revert_newer_decision_or_grant_authority() {
    let case = fixture().await;
    let first = request("source-one", 0);
    let original = select(&case, &first).await.unwrap();
    assert_eq!(original.source_revision, 1);
    assert!(!original.duplicate);
    let second = request("source-two", 1);
    assert_eq!(select(&case, &second).await.unwrap().source_revision, 2);
    let replay = select(&case, &first).await.unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.source_revision, 1);
    assert_eq!(
        case.count("SELECT sum(source_revision) FROM trackers")
            .await,
        2
    );
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_source_selections")
            .await,
        2
    );
    let recovered = case
        .store
        .tracker_source_receipt(&case.token, &case.owner, &case.conversation, "source-one")
        .await
        .unwrap();
    assert_eq!(recovered, replay);
    let mut conflicting = first.clone();
    conflicting.source.source_id = Uuid::new_v4();
    assert_eq!(
        select(&case, &conflicting).await,
        Err(HistoryError::Conflict)
    );
    assert_eq!(
        select(&case, &request("stale-decision", 0)).await,
        Err(HistoryError::Conflict)
    );
    assert_eq!(
        case.store
            .tracker_source_receipt(
                "invalid-session",
                &case.owner,
                &case.conversation,
                "source-one"
            )
            .await,
        Err(HistoryError::Unauthorized)
    );
    let other = case.conversation("other-synthetic-thread").await;
    assert_eq!(
        case.store
            .tracker_source_receipt(&case.token, &case.owner, &other, "source-one")
            .await,
        Err(HistoryError::NotFound)
    );
    // Selecting a source grants neither scheduling nor execution/delivery.
    for table in [
        "dormant_timers",
        "durable_timer_authorities",
        "production_runs",
        "reasoning_inbox",
        "timer_digests",
    ] {
        assert_eq!(
            case.count(&format!("SELECT count(*) FROM {table}")).await,
            0
        );
    }
    let config = case
        .store
        .tracker_config(
            TrackerCaller::Owner {
                credential: &case.token,
                owner: &case.owner,
            },
            &case.conversation,
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<SelectedMailSource>(config.source_json.as_deref().unwrap()).unwrap(),
        second.source
    );
    for sql in [
        "UPDATE tracker_source_selections SET acknowledged=0",
        "DELETE FROM tracker_source_selections",
    ] {
        assert!(sqlx::query(sql).execute(&case.store.pool).await.is_err());
    }
    case.finish().await;
}

#[tokio::test]
async fn migration_75_preserves_existing_74_tracker_and_source_state() {
    let case = fixture().await;
    let old_source = r#"{"legacy_source":"synthetic"}"#;
    case.store
        .set_tracker_source(
            &case.token,
            &case.owner,
            &case.conversation,
            Some(old_source),
        )
        .await
        .unwrap();
    let path: String =
        sqlx::query_scalar("SELECT file FROM pragma_database_list WHERE name='main'")
            .fetch_one(&case.store.pool)
            .await
            .unwrap();
    migration_fixture::downgrade_empty(&case.store).await;
    case.store.close().await;
    let reopened = Store::open(std::path::Path::new(&path)).await.unwrap();
    let config = reopened
        .tracker_config(
            TrackerCaller::Owner {
                credential: &case.token,
                owner: &case.owner,
            },
            &case.conversation,
        )
        .await
        .unwrap();
    assert_eq!(config.source_json.as_deref(), Some(old_source));
    assert_eq!(config.source_revision, 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM tracker_source_selections")
            .fetch_one(&reopened.pool)
            .await
            .unwrap(),
        0
    );
    reopened.close().await;
    case.finish().await;
}
