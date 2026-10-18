use super::super::input::TimerInputRequest;
use super::*;
async fn bridge_fixture() -> (Store, OwnerId, ConversationId, std::path::PathBuf) {
    let fixture = fixture().await;
    let exists: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE name='dormant_timer_inputs'")
            .fetch_one(&fixture.0.pool)
            .await
            .unwrap();
    if exists == 0 {
        sqlx::raw_sql(include_str!("input/schema-proposal.sql"))
            .execute(&fixture.0.pool)
            .await
            .unwrap();
    }
    fixture
}
#[tokio::test]
async fn ordinary_input_replay_payload_and_disable_fence() {
    let (store, owner, conversation, directory) = bridge_fixture().await;
    let source = input();
    store
        .import_dormant_timer(TOKEN, &owner, &source)
        .await
        .unwrap();
    let enabled = store
        .enable_timer_input(TOKEN, &owner, &enable(&source, &conversation), NOW)
        .await
        .unwrap();
    let mut request = TimerInputRequest {
        claim: claim(&source, &enabled),
        text: "Synthetic owner work".into(),
    };
    let first = store
        .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
        .await
        .unwrap();
    assert!(!first.duplicate);
    let replay = store
        .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(first.input.event_id, replay.input.event_id);
    request.text.push('!');
    assert!(matches!(
        store
            .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
            .await,
        Err(HistoryError::Conflict)
    ));
    store
        .control_dormant_timer(
            TOKEN,
            &owner,
            &TimerControlRequest {
                namespace: source.namespace,
                expected_revision: enabled.revision,
                request_key: "disable-input".into(),
                action: TimerControl::Disable,
            },
        )
        .await
        .unwrap();
    let held: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ordinary_input_holds WHERE event_id=?")
            .bind(first.input.event_id.to_string())
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(held, 1);
    assert!(matches!(
        store
            .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
            .await,
        Err(HistoryError::Conflict)
    ));
    cleanup(store, directory).await;
}
#[tokio::test]
async fn failed_native_input_rolls_back_cadence_claim_and_provenance() {
    let (store, owner, conversation, directory) = bridge_fixture().await;
    let source = input();
    store
        .import_dormant_timer(TOKEN, &owner, &source)
        .await
        .unwrap();
    let enabled = store
        .enable_timer_input(TOKEN, &owner, &enable(&source, &conversation), NOW)
        .await
        .unwrap();
    let request = TimerInputRequest {
        claim: claim(&source, &enabled),
        text: " ".into(),
    };
    assert!(store
        .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
        .await
        .is_err());
    assert_eq!(
        store
            .dormant_timer_receipt(TOKEN, &owner, source.namespace)
            .await
            .unwrap(),
        enabled
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM dormant_timer_claims")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(store
        .admit_timer_input("revoked", &owner, &request, NOW + 60_000)
        .await
        .is_err());
    cleanup(store, directory).await;
}
#[tokio::test]
async fn inert_enable_cannot_be_promoted_or_dispatch() {
    let (store, owner, conversation, directory) = bridge_fixture().await;
    let source = input();
    store
        .import_dormant_timer(TOKEN, &owner, &source)
        .await
        .unwrap();
    let enable = enable(&source, &conversation);
    let enabled = store
        .enable_dormant_timer(TOKEN, &owner, &enable, NOW)
        .await
        .unwrap();
    assert!(store
        .enable_timer_input(TOKEN, &owner, &enable, NOW)
        .await
        .is_err());
    let request = TimerInputRequest {
        claim: claim(&source, &enabled),
        text: "Synthetic work".into(),
    };
    assert!(store
        .admit_timer_input(TOKEN, &owner, &request, NOW + 60_000)
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM dormant_timer_claims")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    cleanup(store, directory).await;
}
