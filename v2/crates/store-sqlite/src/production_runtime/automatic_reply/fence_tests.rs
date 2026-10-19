use super::{tests::*, *};
use crate::production_runtime::tests::setup;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_commit_failure_after_bytes_poison_is_permanent() {
    let f = setup().await;
    let p = enabled(&f).await;
    let id = input(&f, &p).await;
    let r = reserved(&f, &p, id).await;
    let AutomaticReplyConsumption::Deliver(mut d) =
        f.handle.consume_automatic_reply(&f.token, r).await.unwrap()
    else {
        panic!()
    };
    sqlx::raw_sql("CREATE TABLE synthetic_auto_commit_failure(marker TEXT REFERENCES owners(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER synthetic_auto_fail_commit AFTER UPDATE OF written_bytes ON automatic_reply_sends BEGIN INSERT INTO synthetic_auto_commit_failure VALUES('missing-synthetic-owner'); END;").execute(&f.store.pool).await.unwrap();
    let mut actual = Vec::new();
    assert!(f
        .handle
        .with_automatic_reply_fence(&f.token, &mut d, 0, 4, |bytes| {
            actual.extend_from_slice(bytes);
            Ok::<_, ()>(4)
        })
        .is_err());
    assert_eq!(actual, b"exac");
    assert!(f
        .handle
        .with_automatic_reply_fence(
            &f.token,
            &mut d,
            0,
            4,
            |_| -> std::result::Result<usize, ()> { panic!("uncertain write repeated") }
        )
        .is_err());
    let row: (String, i64) =
        sqlx::query_as("SELECT state,written_bytes FROM automatic_reply_sends")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(row, ("delivery_unknown".into(), 0));
    let AutomaticReplyReservationResult::Replay(receipt) = f
        .handle
        .reserve_automatic_reply(&f.token, &p, id, "reply", b"exact output")
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(receipt.written_bytes, 0);
    f.handle.close().await;
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn foreign_browser_and_revoked_historical_permission_refuse_without_writes() {
    let f = setup().await;
    let p = enabled(&f).await;
    let request = AutomaticReplyPermissionRequest {
        route_id: p.route,
        expected_route_generation: 1,
        expected_permission_revision: 0,
        request_key: "enable".into(),
        enabled: true,
    };
    let before: Vec<(String, String)> =
        sqlx::query_as("SELECT request_json,receipt_json FROM automatic_reply_permissions")
            .fetch_all(&f.store.pool)
            .await
            .unwrap();
    assert!(f
        .store
        .set_automatic_reply_permission_authenticated("unknown-browser", &f.conversation, &request)
        .await
        .is_err());
    let foreign = ConversationId(Uuid::new_v4());
    assert!(f
        .store
        .set_automatic_reply_permission_authenticated(&f.token, &foreign, &request)
        .await
        .is_err());
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(f
        .store
        .set_automatic_reply_permission_authenticated(&f.token, &f.conversation, &request)
        .await
        .is_err());
    let after: Vec<(String, String)> =
        sqlx::query_as("SELECT request_json,receipt_json FROM automatic_reply_permissions")
            .fetch_all(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    f.handle.close().await;
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writer_serialization_disable_cannot_commit_inside_actual_suffix() {
    let f = setup().await;
    let p = enabled(&f).await;
    let id = input(&f, &p).await;
    let r = reserved(&f, &p, id).await;
    let AutomaticReplyConsumption::Deliver(mut d) =
        f.handle.consume_automatic_reply(&f.token, r).await.unwrap()
    else {
        panic!()
    };
    let store = f.store.clone();
    let token = f.token.clone();
    let conversation = f.conversation.clone();
    let route = p.route;
    let (start_tx, start_rx) = tokio::sync::oneshot::channel();
    let (attempt_tx, attempt_rx) = std::sync::mpsc::channel();
    let disable = tokio::spawn(async move {
        start_rx.await.unwrap();
        attempt_tx.send(()).unwrap();
        store
            .set_automatic_reply_permission_authenticated(
                &token,
                &conversation,
                &AutomaticReplyPermissionRequest {
                    route_id: route,
                    expected_route_generation: 1,
                    expected_permission_revision: 1,
                    request_key: "disable-race".into(),
                    enabled: false,
                },
            )
            .await
            .unwrap()
    });
    let result = f
        .handle
        .with_automatic_reply_fence(&f.token, &mut d, 0, 1, |bytes| {
            start_tx.send(()).unwrap();
            attempt_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap();
            assert!(!disable.is_finished());
            assert_eq!(bytes, b"e");
            Ok::<_, ()>(1)
        })
        .unwrap();
    assert_eq!(result, Ok(1));
    disable.await.unwrap();
    assert!(f
        .handle
        .with_automatic_reply_fence(
            &f.token,
            &mut d,
            1,
            1,
            |_| -> std::result::Result<usize, ()> { panic!("disabled suffix") }
        )
        .is_err());
    f.handle.close().await;
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}
