use super::*;
use orkestr_v2_contracts::TrackerEnable;

async fn prepare(store: &Store, token: &str, owner: &OwnerId, conversation: &ConversationId) {
    store
        .enable_tracker(
            token,
            owner,
            conversation,
            &TrackerEnable {
                recipe: "job-tracker".into(),
                notify_on: vec![],
            },
        )
        .await
        .unwrap();
    store
        .select_tracker_scan_source(
            token,
            owner,
            conversation,
            &TrackerSourceSelect {
                request_key: "source".into(),
                expected_revision: 0,
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
}
async fn create(
    store: &Store,
    token: &str,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<TrackerCheckReceipt> {
    store
        .create_tracker_check(
            token,
            owner,
            conversation,
            &TrackerCheckRequest {
                request_key: "check".into(),
                expected_source_revision: 1,
                expected_recipe: "job-tracker".into(),
                expected_classifier_id: "rules".into(),
                expected_classifier_digest: "ab".repeat(32),
            },
            ("rules", &"ab".repeat(32)),
        )
        .await
}
#[tokio::test]
async fn one_owner_at_manual_check_capacity_does_not_block_another_owner() {
    let case = crate::conversation_resources::tests_settings::Case::new().await;
    for n in 0..16 {
        let conversation = case.conversation(&format!("queued-{n}")).await;
        prepare(&case.store, &case.token, &case.owner, &conversation).await;
        create(&case.store, &case.token, &case.owner, &conversation)
            .await
            .unwrap();
        assert!(
            create(&case.store, &case.token, &case.owner, &conversation)
                .await
                .unwrap()
                .duplicate
        );
    }
    prepare(&case.store, &case.token, &case.owner, &case.conversation).await;
    assert_eq!(
        create(&case.store, &case.token, &case.owner, &case.conversation).await,
        Err(HistoryError::Conflict)
    );
    let owner = OwnerId(Uuid::new_v4());
    let conversation = ConversationId(Uuid::new_v4());
    // Setup is deliberately singleton; bypass that CHECK only for seeding this
    // cross-owner fixture, restoring it before every production authorization.
    let mut conn = case.store.pool.acquire().await.unwrap();
    sqlx::query("PRAGMA ignore_check_constraints=ON")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO owners(id,username,password_hash,singleton) VALUES(?,'synthetic-other-owner','synthetic-hash',2)").bind(owner.to_string()).execute(&mut *conn).await.unwrap();
    sqlx::query("PRAGMA ignore_check_constraints=OFF")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO conversations(id,owner_id) VALUES(?,?)")
        .bind(conversation.to_string())
        .bind(owner.to_string())
        .execute(&mut *conn)
        .await
        .unwrap();
    drop(conn);
    let token = "f".repeat(64);
    case.store.save_session(&token, &owner).await.unwrap();
    prepare(&case.store, &token, &owner, &conversation).await;
    create(&case.store, &token, &owner, &conversation)
        .await
        .unwrap();
    let mut second = TrackerCheckRequest {
        request_key: "different-check".into(),
        expected_source_revision: 1,
        expected_recipe: "job-tracker".into(),
        expected_classifier_id: "rules".into(),
        expected_classifier_digest: "ab".repeat(32),
    };
    assert_eq!(
        case.store
            .create_tracker_check(
                &token,
                &owner,
                &conversation,
                &second,
                ("rules", &"ab".repeat(32))
            )
            .await,
        Err(HistoryError::Conflict)
    );
    second.request_key = "foreign-check".into();
    assert_eq!(
        case.store
            .create_tracker_check(
                &case.token,
                &owner,
                &conversation,
                &second,
                ("rules", &"ab".repeat(32))
            )
            .await,
        Err(HistoryError::Unauthorized)
    );
    case.finish().await;
}
