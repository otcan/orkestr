use super::*;
use crate::conversation_resources_http::tests::{case, send};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[tokio::test]
async fn posts_round_trip_idempotency_validation_and_delivery() {
    let case = case().await;
    let auth = case.auth();
    let path = case.path("/posts");
    let body = json!({"request_key":"coord-1","author":"coordinator","text":"Deploy finished.",
                      "provider":"claude","model":"synthetic-model"});
    let (status, first) = send(&case.state, "POST", &path, &[&auth], &body.to_string()).await;
    assert_eq!(status, 201, "{first}");
    assert_eq!(first["label"], "Coordinator");
    assert_eq!(first["author"], "coordinator");
    assert_eq!(first["text"], "Deploy finished.");
    assert_eq!(first["delivered_ms"], Value::Null);
    let post: ConversationPost = serde_json::from_value(first.clone()).unwrap();
    assert!(post.is_valid());
    assert_eq!(post.conversation_id, case.conversation);
    // Replay: same post, 200.
    let (status, again) = send(&case.state, "POST", &path, &[&auth], &body.to_string()).await;
    assert_eq!((status, &again), (200, &first));
    // Same key, different body: 409.
    let changed = json!({"request_key":"coord-1","author":"coordinator","text":"Other"});
    let (status, value) = send(&case.state, "POST", &path, &[&auth], &changed.to_string()).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("conversation_post_conflict"))
    );
    // Strict validation.
    for bad in [
        json!({"request_key":"k","author":"coordinator","text":"x","extra":true}),
        json!({"request_key":"k","author":"owner","text":"x"}),
        json!({"request_key":"k","author":"operator","text":"   "}),
        json!({"request_key":"k","author":"operator","text":"NO_REPLY"}),
        json!({"request_key":"k k","author":"operator","text":"x"}),
        json!({"request_key":"k","author":"operator","text":"x","model":"bad model"}),
        json!({"request_key":"k","author":"operator","text":"x".repeat(16_001)}),
        json!({"author":"operator","text":"x"}),
    ] {
        let (status, value) = send(&case.state, "POST", &path, &[&auth], &bad.to_string()).await;
        assert_eq!(status, 400, "{bad} -> {value}");
    }
    // Unknown conversation and missing credential.
    let other = format!("/api/v2/conversations/{}/posts", Uuid::new_v4());
    let (status, _) = send(&case.state, "POST", &other, &[&auth], &body.to_string()).await;
    assert_eq!(status, 404);
    let (status, _) = send(&case.state, "POST", &path, &[], &body.to_string()).await;
    assert_eq!(status, 401);
    // Browser writes need CSRF.
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let origin = "Origin: http://127.0.0.1:19882";
    let operator =
        json!({"request_key":"ops-1","author":"operator","label":"Ops","text":"Disk 91%"});
    let (status, _) = send(
        &case.state,
        "POST",
        &path,
        &[&cookie, origin],
        &operator.to_string(),
    )
    .await;
    assert_eq!(status, 403);
    let csrf = format!(
        "x-orkestr-csrf: {:x}",
        Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{}", case.cookie).as_bytes())
    );
    let (status, second) = send(
        &case.state,
        "POST",
        &path,
        &[&cookie, origin, &csrf],
        &operator.to_string(),
    )
    .await;
    assert_eq!(status, 201, "{second}");
    assert_eq!(
        (second["label"].as_str(), second["provider"].as_str()),
        (Some("Ops"), None)
    );

    // Pending, oldest first; recent for the UI.
    let (status, pending) = send(
        &case.state,
        "GET",
        &case.path("/posts?pending=true&limit=20"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 200, "{pending}");
    let page: ConversationPosts = serde_json::from_value(pending).unwrap();
    assert!(page.is_valid());
    assert_eq!(page.posts.len(), 2);
    assert_eq!(page.posts[0].request_key, "coord-1");
    let (status, latest) = send(
        &case.state,
        "GET",
        &case.path("/posts?limit=1"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(latest["posts"][0]["request_key"], "ops-1");
    for bad in [
        "/posts?pending=false",
        "/posts?after_ms=-1",
        "/posts?limit=0",
        "/posts?limit=101",
        "/posts?pending=true&after_ms=1",
        "/posts?unknown=1",
    ] {
        let (status, _) = send(&case.state, "GET", &case.path(bad), &[&auth], "").await;
        assert_eq!(status, 400, "{bad}");
    }

    // Delivered: idempotent, then no longer pending.
    let ack = case.path(&format!("/posts/{}/delivered", post.id));
    let (status, one) = send(&case.state, "POST", &ack, &[&auth], "{}").await;
    assert_eq!(status, 200, "{one}");
    assert!(one["delivered_ms"].as_i64().is_some());
    let (status, two) = send(&case.state, "POST", &ack, &[&auth], "{}").await;
    assert_eq!((status, &two), (200, &one));
    let (_, pending) = send(
        &case.state,
        "GET",
        &case.path("/posts?pending=true&limit=20"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(pending["posts"].as_array().unwrap().len(), 1);
    let missing = case.path(&format!("/posts/{}/delivered", Uuid::new_v4()));
    let (status, _) = send(&case.state, "POST", &missing, &[&auth], "{}").await;
    assert_eq!(status, 404);
    let (status, _) = send(
        &case.state,
        "POST",
        &case.path("/posts/not-a-uuid/delivered"),
        &[&auth],
        "{}",
    )
    .await;
    assert_eq!(status, 400);

    // Posts never became inputs.
    let (status, snapshot) = send(&case.state, "GET", &case.path(""), &[&auth], "").await;
    assert_eq!(status, 200, "{snapshot}");
    assert_eq!(snapshot["messages"].as_array().map(Vec::len), Some(0));
    case.finish().await;
}
