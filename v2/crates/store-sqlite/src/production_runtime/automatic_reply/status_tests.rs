use super::*;
use crate::production_runtime::tests::setup;

#[tokio::test]
async fn policy_pages_are_scoped_current_authenticated_and_exclusive() {
    let f = setup().await;
    let initial = f
        .store
        .automatic_reply_permissions_authenticated(&f.token, &f.conversation, None, 16)
        .await
        .unwrap();
    assert!(initial.is_valid());
    assert!(initial.routes.is_empty());
    let mut ids = vec![];
    for _ in 0..3 {
        let id = Uuid::new_v4();
        f.handle
            .bind_automatic_reply_route(&f.token, &f.conversation, id, "synthetic", 0)
            .await
            .unwrap();
        ids.push(id);
    }
    ids.sort();
    let first = f
        .store
        .automatic_reply_permissions_authenticated(&f.token, &f.conversation, None, 2)
        .await
        .unwrap();
    assert!(first.is_valid());
    assert_eq!(
        first.routes.iter().map(|r| r.route_id).collect::<Vec<_>>(),
        ids[..2]
    );
    assert!(first
        .routes
        .iter()
        .all(|r| !r.enabled && r.route_generation == 1 && r.permission_revision == 0));
    assert_eq!(first.next_after, Some(ids[1]));
    let second = f
        .store
        .automatic_reply_permissions_authenticated(&f.token, &f.conversation, first.next_after, 2)
        .await
        .unwrap();
    assert!(second.is_valid());
    assert_eq!(second.routes[0].route_id, ids[2]);
    assert_eq!(second.next_after, None);
    let request = AutomaticReplyPermissionRequest {
        route_id: ids[0],
        expected_route_generation: 1,
        expected_permission_revision: 0,
        request_key: "status-enable".into(),
        enabled: true,
    };
    let receipt = f
        .store
        .set_automatic_reply_permission_authenticated(&f.token, &f.conversation, &request)
        .await
        .unwrap();
    let updated = f
        .store
        .automatic_reply_permissions_authenticated(&f.token, &f.conversation, None, 1)
        .await
        .unwrap();
    assert!(updated.routes[0].enabled);
    assert_eq!(
        updated.routes[0].permission_revision,
        receipt.permission_revision
    );
    for limit in [0, 33] {
        assert!(matches!(
            f.store
                .automatic_reply_permissions_authenticated(&f.token, &f.conversation, None, limit)
                .await,
            Err(RuntimeStoreError::InvalidInput)
        ));
    }
    assert!(f
        .store
        .automatic_reply_permissions_authenticated(
            &f.token,
            &ConversationId(Uuid::new_v4()),
            None,
            16
        )
        .await
        .is_err());
    assert!(f
        .handle
        .automatic_reply_permissions_authenticated(&f.token, &f.conversation, None, 16)
        .await
        .is_err());
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(matches!(
        f.store
            .automatic_reply_permissions_authenticated(&f.token, &f.conversation, None, 16)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.store
            .set_automatic_reply_permission_authenticated(&f.token, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
}

#[test]
fn sampled_policy_validator_rejects_duplicate_reordered_or_invalid_identity() {
    let route = AutomaticReplyPermissionStatus {
        route_id: Uuid::new_v4(),
        route_generation: 1,
        permission_revision: 0,
        enabled: false,
    };
    let mut page = AutomaticReplyPermissionPage {
        conversation_id: ConversationId(Uuid::new_v4()),
        observed_at_ms: 0,
        routes: vec![route.clone()],
        next_after: None,
    };
    assert!(page.is_valid());
    page.routes.push(route);
    assert!(!page.is_valid());
    page.routes.pop();
    page.next_after = Some(Uuid::new_v4());
    assert!(!page.is_valid());
    page.next_after = None;
    page.routes[0].route_generation = 0;
    assert!(!page.is_valid());
}
