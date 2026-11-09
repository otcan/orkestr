use super::*;

#[tokio::test]
async fn global_desks_list_unbound_resources_and_reset_uses_current_lease() {
    let mut c = case().await;
    let v1 = StdArc::new(StdMutex::new(FakeV1 {
        grants: vec!["sales-nav".into()],
        ..Default::default()
    }));
    let url = fake_v1(v1.clone()).await;
    c.state.desktop_broker = Some(Arc::new(
        desktop_broker::Broker::new(&url, V1_TOKEN.into()).unwrap(),
    ));
    let auth = c.auth();
    let (status, _) = send(
        &c.state,
        "PUT",
        &c.path("/desktop-binding"),
        &[&auth],
        r#"{"expected_revision":0,"v1_thread_id":"v1-parent","desktop_slugs":["sales-nav"]}"#,
    )
    .await;
    assert_eq!(status, 200);
    let before = v1.lock().unwrap().calls.len();
    let (status, inventory) = send(&c.state, "GET", "/api/v2/desktops", &[&auth], "").await;
    assert_eq!(status, 200);
    assert_eq!(inventory["resources"].as_array().unwrap().len(), 2);
    assert_eq!(inventory["resources"][1]["slug"], "unbound-desk");
    assert_eq!(inventory["resources"][1]["lease_state"], "unknown");
    assert!(!inventory.to_string().contains("never-expose"));
    assert_eq!(v1.lock().unwrap().calls.len(), before + 1);
    assert!(v1.lock().unwrap().lease.is_none());
    let (status, grant) = send(
        &c.state,
        "POST",
        &c.path("/desktops/sales-nav/acquire"),
        &[&auth],
        r#"{"ttl_ms":600000,"purpose":"test"}"#,
    )
    .await;
    assert_eq!(status, 201);
    let token = grant["fencing_token"].as_str().unwrap();
    let before = v1.lock().unwrap().calls.len();
    let (status, _) = send(
        &c.state,
        "POST",
        &c.path("/desktops/sales-nav/reset"),
        &[&auth],
        &json!({"fencing_token":"wrong-fencing-token","confirm":true}).to_string(),
    )
    .await;
    assert!(!matches!(status, 200 | 201));
    assert_eq!(v1.lock().unwrap().calls.len(), before);
    let (status, _) = send(
        &c.state,
        "POST",
        &c.path("/desktops/sales-nav/reset"),
        &[&auth],
        &json!({"fencing_token":token,"confirm":true}).to_string(),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        v1.lock().unwrap().calls.last().unwrap(),
        "POST /api/browsers/sales-nav/restart"
    );
}
