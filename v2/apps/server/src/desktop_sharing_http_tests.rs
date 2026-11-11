//! ORK-773 over HTTP: with all desks shared, a chat bound only to its V1
//! thread reserves any desk without a slug in its binding or a V1 per-thread
//! grant; V1 still holds and fences every lease. Off is the per-chat binding.
use super::*;

const SHARING: &str = "/api/v2/desktop-sharing";

fn grant_calls(v1: &StdArc<StdMutex<FakeV1>>) -> usize {
    v1.lock()
        .unwrap()
        .calls
        .iter()
        .filter(|c| c.ends_with("/desktop-grants"))
        .count()
}

#[tokio::test]
async fn shared_desks_need_no_bound_slug_or_v1_grant_and_off_restores_the_binding() {
    let mut c = case().await;
    // V1 grants the thread one desk only.
    let v1 = StdArc::new(StdMutex::new(FakeV1 {
        grants: vec!["sales-nav".into()],
        ..Default::default()
    }));
    let url = fake_v1(v1.clone()).await;
    c.state.desktop_broker = Some(Arc::new(
        desktop_broker::Broker::new(&url, V1_TOKEN.into()).unwrap(),
    ));
    let auth = c.auth();
    let (status, _) = send(&c.state, "GET", SHARING, &[], "").await;
    assert_eq!(status, 401);
    let (status, value) = send(&c.state, "GET", SHARING, &[&auth], "").await;
    assert_eq!(
        (
            status,
            value["share_all_desks"].as_bool(),
            value["revision"].as_i64()
        ),
        (200, Some(false), Some(0))
    );
    // A binding may name only the V1 thread, which V1 must still know.
    let (status, binding) = send(
        &c.state,
        "PUT",
        &c.path("/desktop-binding"),
        &[&auth],
        r#"{"expected_revision":0,"v1_thread_id":"v1-parent","desktop_slugs":[]}"#,
    )
    .await;
    assert_eq!(
        (status, binding["desktop_slugs"].as_array().map(Vec::len)),
        (200, Some(0))
    );
    assert_eq!(grant_calls(&v1), 1);
    let (status, issued) = send(
        &c.state,
        "POST",
        &c.path("/desktop-binding/grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 201);
    let grant = format!(
        "{DESKTOP_GRANT_HEADER}: {}",
        issued["grant"].as_str().unwrap()
    );
    let acquire = r#"{"ttl_ms":600000,"purpose":"shared desk"}"#;

    // Off: a desk the binding does not list is refused before V1 is asked.
    let calls = v1.lock().unwrap().calls.len();
    let (status, value) = send(
        &c.state,
        "POST",
        &c.path("/desktops/linkedin/acquire"),
        &[&grant],
        acquire,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_not_granted"))
    );
    assert_eq!(v1.lock().unwrap().calls.len(), calls);
    let (_, list) = send(&c.state, "GET", &c.path("/desktops"), &[&grant], "").await;
    assert_eq!(list["shared_with_all_chats"], false);

    // A chat's desktop grant is not owner authority over the switch.
    let on = r#"{"expected_revision":0,"share_all_desks":true}"#;
    let (status, _) = send(&c.state, "PUT", SHARING, &[&grant], on).await;
    assert_eq!(status, 401);
    let (status, value) = send(&c.state, "PUT", SHARING, &[&auth], on).await;
    assert_eq!(
        (
            status,
            value["share_all_desks"].as_bool(),
            value["revision"].as_i64()
        ),
        (200, Some(true), Some(1))
    );
    let (status, value) = send(&c.state, "PUT", SHARING, &[&auth], on).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_sharing_revision_mismatch"))
    );
    let (_, list) = send(&c.state, "GET", &c.path("/desktops"), &[&grant], "").await;
    assert_eq!(list["shared_with_all_chats"], true);

    // On: more desks than a binding can list, none granted by V1, one at a
    // time through V1, without reading the thread's V1 grants.
    let grants_before = grant_calls(&v1);
    for index in 0..=DESKTOP_SLUGS_MAX {
        let path = |action: &str| c.path(&format!("/desktops/desk-{index}/{action}"));
        let (status, granted) = send(&c.state, "POST", &path("acquire"), &[&grant], acquire).await;
        assert_eq!(status, 201, "{granted}");
        assert_eq!(granted["lease"]["v1_thread_id"], "v1-parent");
        let token = granted["fencing_token"].as_str().unwrap();
        let release = json!({"fencing_token": token, "reason": "done"}).to_string();
        let (status, _) = send(&c.state, "POST", &path("release"), &[&grant], &release).await;
        assert_eq!(status, 200);
    }
    assert_eq!(grant_calls(&v1), grants_before);
    assert!(v1.lock().unwrap().lease.is_none());

    // The owner can open a shared desk from the chat.
    let (status, opened) = send(
        &c.state,
        "POST",
        &c.path("/desktops/linkedin/open"),
        &[&auth],
        "{}",
    )
    .await;
    assert_eq!(status, 200, "{opened}");

    // One holder per desk and fencing are unchanged.
    let (status, granted) = send(
        &c.state,
        "POST",
        &c.path("/desktops/linkedin/acquire"),
        &[&grant],
        acquire,
    )
    .await;
    assert_eq!(status, 201, "{granted}");
    let token = granted["fencing_token"].as_str().unwrap().to_owned();
    let calls = v1.lock().unwrap().calls.len();
    let wrong = json!({"fencing_token": "99999999-0000-4000-8000-000000000000"}).to_string();
    let (status, value) = send(
        &c.state,
        "POST",
        &c.path("/desktops/linkedin/heartbeat"),
        &[&grant],
        &wrong,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_fence_rejected"))
    );
    assert_eq!(v1.lock().unwrap().calls.len(), calls);
    let other = c
        .state
        .store
        .create_conversation_authenticated(
            &c.bearer,
            &ConversationInput {
                client_request_id: "shared-desk-other".into(),
                name: "Other chat".into(),
            },
        )
        .await
        .unwrap()
        .0
        .conversation_id;
    let other_path = |rest: &str| format!("/api/v2/conversations/{other}{rest}");
    let (status, _) = send(
        &c.state,
        "PUT",
        &other_path("/desktop-binding"),
        &[&auth],
        r#"{"expected_revision":0,"v1_thread_id":"v1-other","desktop_slugs":[]}"#,
    )
    .await;
    assert_eq!(status, 200);
    let (status, value) = send(
        &c.state,
        "POST",
        &other_path("/desktops/linkedin/acquire"),
        &[&auth],
        acquire,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_leased"))
    );
    // The owner can reset a shared desk the chat holds.
    let reset = json!({"fencing_token": token, "confirm": true}).to_string();
    let (status, value) = send(
        &c.state,
        "POST",
        &c.path("/desktops/linkedin/reset"),
        &[&auth],
        &reset,
    )
    .await;
    assert_eq!(status, 200, "{value}");

    // Off is refused while the chat holds a desk it is not bound to.
    let off = r#"{"expected_revision":1,"share_all_desks":false}"#;
    let (status, value) = send(&c.state, "PUT", SHARING, &[&auth], off).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_shared_lease_active"))
    );
    assert!(value["message"]
        .as_str()
        .unwrap()
        .contains("Release that reservation"));
    let release = json!({"fencing_token": token, "reason": "done"}).to_string();
    let (status, _) = send(
        &c.state,
        "POST",
        &c.path("/desktops/linkedin/release"),
        &[&grant],
        &release,
    )
    .await;
    assert_eq!(status, 200);
    let (status, value) = send(&c.state, "PUT", SHARING, &[&auth], off).await;
    assert_eq!(
        (
            status,
            value["share_all_desks"].as_bool(),
            value["revision"].as_i64()
        ),
        (200, Some(false), Some(2))
    );
    // Off again: the per-chat binding and the V1 grant decide, as before.
    for slug in ["linkedin", "sales-nav"] {
        let path = c.path(&format!("/desktops/{slug}/acquire"));
        let (status, value) = send(&c.state, "POST", &path, &[&grant], acquire).await;
        assert_eq!(
            (status, value["code"].as_str()),
            (409, Some("desktop_not_granted"))
        );
    }
    let (status, value) = send(
        &c.state,
        "POST",
        &c.path("/desktops/linkedin/open"),
        &[&auth],
        "{}",
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_not_granted"))
    );
    c.finish().await;
}
