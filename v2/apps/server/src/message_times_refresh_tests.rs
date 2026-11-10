use crate::message_receipt_test_support::{ack, Fixture};
use serde_json::json;
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

fn receipts(page: &serde_json::Value) -> Vec<serde_json::Value> {
    page["times"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|row| row["receipts"].as_array().unwrap().clone())
        .collect()
}

#[tokio::test]
async fn slow_v1_is_not_on_the_core_times_path_and_concurrent_polls_coalesce() {
    let f = Fixture::new().await;
    let started = Instant::now();
    let requests: Vec<_> = (0..8).map(|_| f.request()).collect();
    f.peer.started(1).await;
    for request in requests {
        // V1 cannot answer until the test releases it. The old synchronous
        // handler instead waits its five-second peer deadline here.
        let (status, page) = tokio::time::timeout(Duration::from_secs(1), request)
            .await
            .expect("Core times waited for V1")
            .unwrap();
        assert_eq!(status, 200);
        assert!(!page["times"].as_array().unwrap().is_empty());
        assert!(
            receipts(&page).is_empty(),
            "missing observation is unknown, not an ACK"
        );
    }
    eprintln!(
        "eight blocked-V1 message-times responses: {}ms",
        started.elapsed().as_millis()
    );
    assert_eq!(f.peer.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        &*f.peer.paths.lock().unwrap(),
        &["/api/threads/thread-a/messages?limit=200"]
    );
    f.release().await;
    let page = f.page().await;
    assert!(receipts(&page)
        .iter()
        .any(|r| r["kind"] == "sent_to_whatsapp"));
    assert_eq!(f.peer.calls.load(Ordering::SeqCst), 1);
    f.finish().await;
}

#[tokio::test]
async fn changed_receipts_invalidate_etags_but_source_304_and_204_create_no_ack() {
    let f = Fixture::new().await;
    let (status, old_tag, page) = f.conditional(None).await;
    assert_eq!(status, 200);
    assert!(!old_tag.is_empty());
    assert!(receipts(&page).is_empty());
    f.peer.started(1).await;
    f.release().await;
    let (status, new_tag, page) = f.conditional(Some(&old_tag)).await;
    assert_eq!(status, 200);
    assert_ne!(old_tag, new_tag);
    let recorded = receipts(&page);
    assert!(!recorded.is_empty());
    for status in [304, 204, 503] {
        f.case.state.message_receipts.expire_observations().await;
        *f.peer.response.lock().unwrap() = (status, json!({"messages":[]}));
        f.peer.gate.add_permits(1);
        let (_, _, page) = f.conditional(None).await;
        f.case.state.message_receipts.wait_for_refresh().await;
        assert_eq!(
            receipts(&page),
            recorded,
            "historical ACK/time must not regress or become a new observation"
        );
    }
    f.finish().await;
    for status in [304, 204, 503] {
        let f = Fixture::new().await;
        *f.peer.response.lock().unwrap() = (status, ack(&f.event));
        f.peer.gate.add_permits(1);
        assert!(receipts(&f.page().await).is_empty());
        f.case.state.message_receipts.wait_for_refresh().await;
        assert!(
            receipts(&f.page().await).is_empty(),
            "only an actual successful source body can add ACKs"
        );
        f.finish().await;
    }
}

#[tokio::test]
async fn revocation_during_refresh_and_before_cache_hit_never_serves_receipts() {
    let f = Fixture::new().await;
    let request = f.request();
    f.peer.started(1).await;
    f.case
        .state
        .store
        .revoke_session(&f.case.bearer)
        .await
        .unwrap();
    let (status, _) = request.await.unwrap();
    assert_eq!(status, 401);
    f.release().await;
    let (status, _) = f.request().await.unwrap();
    assert_eq!(status, 401);
    assert_eq!(f.peer.calls.load(Ordering::SeqCst), 1);
    f.finish().await;
}

#[tokio::test]
async fn link_rebound_does_not_reuse_prior_receipts_or_leak_to_another_conversation() {
    let f = Fixture::new().await;
    f.peer.gate.add_permits(1);
    let _ = f.page().await;
    f.case.state.message_receipts.wait_for_refresh().await;
    assert!(!receipts(&f.page().await).is_empty());
    f.rebind().await;
    let page = f.page().await;
    assert!(receipts(&page).is_empty());
    f.peer.started(2).await;
    assert_eq!(
        f.peer.paths.lock().unwrap().last().unwrap(),
        "/api/threads/thread-b/messages?limit=200"
    );
    let foreign = f.foreign_conversation().await;
    let path = format!("/api/v2/conversations/{foreign}/message-times");
    let (status, _) = f.request_path(path).await.unwrap();
    assert_eq!(status, 404);
    assert_eq!(f.peer.calls.load(Ordering::SeqCst), 2);
    f.release().await;
    f.finish().await;
}
