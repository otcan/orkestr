use super::*;
use crate::conversation_resources_http::tests::{case, send};
use orkestr_v2_application::IntakeStore;

#[tokio::test]
async fn grant_auth_refusals_and_owner_views() {
    let case = case().await;
    let auth = case.auth();
    let owner = case
        .state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let hosting = case
        .state
        .store
        .create_project(
            &owner,
            &ProjectInput {
                client_request_id: "project-hosting".into(),
                name: "Hosting".into(),
            },
        )
        .await
        .unwrap()
        .project
        .conversation_id;
    // No grant yet: grant holders are refused, the owner sees none issued.
    let (status, value) = send(
        &case.state,
        "GET",
        &case.path("/thread-ask-grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!((status, value["issued"].as_bool()), (200, Some(false)));
    let (status, value) = send(
        &case.state,
        "PUT",
        &case.path("/thread-ask-grant"),
        &[&auth],
        "{}",
    )
    .await;
    assert_eq!(status, 201);
    let grant = value["grant"].as_str().unwrap().to_owned();
    assert_eq!(grant.len(), 64);
    assert_eq!(value["binding"]["generation"].as_i64(), Some(1));
    let (_, value) = send(
        &case.state,
        "GET",
        &case.path("/thread-ask-grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(value["issued"].as_bool(), Some(true));
    assert!(value.get("grant").is_none());
    let header = format!("{THREAD_ASK_GRANT_HEADER}: {grant}");
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    // Machine requests only: never beside a cookie, bearer or second grant.
    for extra in [&auth, &cookie, &header] {
        let (status, _) = send(
            &case.state,
            "GET",
            &case.path("/thread-asks/targets"),
            &[&header, extra],
            "",
        )
        .await;
        assert_eq!(status, 401);
    }
    let bad = format!("{THREAD_ASK_GRANT_HEADER}: {}", "0".repeat(64));
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path("/thread-asks/targets"),
        &[&bad],
        "",
    )
    .await;
    assert_eq!(status, 401);
    let (status, value) = send(
        &case.state,
        "GET",
        &case.path("/thread-asks/targets"),
        &[&header],
        "",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(value["targets"][0]["name"].as_str(), Some("Hosting"));
    let ask = |target: &str, key: &str| {
        serde_json::json!({"request_key": key, "target_conversation_id": target, "text": "Bedrock access?"})
            .to_string()
    };
    // Unknown (or another owner's) target, self, malformed body, no running turn.
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/thread-asks"),
        &[&header],
        &ask(&Uuid::new_v4().to_string(), "k1"),
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (404, Some("thread_ask_target_not_found"))
    );
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/thread-asks"),
        &[&header],
        &ask(&case.conversation.to_string(), "k2"),
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (400, Some("thread_ask_self"))
    );
    let (status, _) = send(
        &case.state,
        "POST",
        &case.path("/thread-asks"),
        &[&header],
        r#"{"request_key":"k3","text":"x"}"#,
    )
    .await;
    assert_eq!(status, 400);
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/thread-asks"),
        &[&header],
        &ask(&hosting.to_string(), "k4"),
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("thread_ask_no_running_turn"))
    );
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path(&format!("/thread-asks/{}", Uuid::new_v4())),
        &[&header],
        "",
    )
    .await;
    assert_eq!(status, 404);
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path("/thread-asks/not-a-uuid"),
        &[&header],
        "",
    )
    .await;
    assert_eq!(status, 400);
    // Nothing was admitted into the target; the owner list is empty.
    let (status, value) = send(&case.state, "GET", &case.path("/thread-asks"), &[&auth], "").await;
    assert_eq!(
        (status, value["asks"].as_array().map(Vec::len)),
        (200, Some(0))
    );
    // The grant cannot read the owner list, and the owner list needs the owner.
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path("/thread-asks"),
        &[&header],
        "",
    )
    .await;
    assert_eq!(status, 401);
    // Allowlists name only this owner's conversations.
    let foreign = serde_json::json!({"targets": [Uuid::new_v4()]}).to_string();
    let (status, value) = send(
        &case.state,
        "PUT",
        &case.path("/thread-ask-grant"),
        &[&auth],
        &foreign,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (404, Some("thread_ask_target_not_found"))
    );
    let (status, value) = send(
        &case.state,
        "GET",
        &case.path("/thread-ask-inputs?after_sequence=0"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(
        (status, value["inputs"].as_array().map(Vec::len)),
        (200, Some(0))
    );
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path("/thread-ask-inputs"),
        &[&header],
        "",
    )
    .await;
    assert_eq!(status, 401);
    // Owner cancel: unknown requests are 404 and a grant cannot cancel.
    let cancel = case.path(&format!("/thread-asks/{}/cancel", Uuid::new_v4()));
    let (status, _) = send(&case.state, "POST", &cancel, &[&auth], "{}").await;
    assert_eq!(status, 404);
    let (status, _) = send(&case.state, "POST", &cancel, &[&header], "{}").await;
    assert_eq!(status, 401);
    // Revocation is immediate.
    let (status, value) = send(
        &case.state,
        "DELETE",
        &case.path("/thread-ask-grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!((status, value["issued"].as_bool()), (200, Some(false)));
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path("/thread-asks/targets"),
        &[&header],
        "",
    )
    .await;
    assert_eq!(status, 401);
    case.finish().await;
}
