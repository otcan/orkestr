use super::*;

#[tokio::test]
async fn root_intake_http_requires_auth_csrf_closed_body_and_exact_existing_operation() {
    let case = case().await;
    let auth = case.auth();
    let path = case.path("/root-intake/lookup");
    let query = serde_json::json!({"operation_id":Uuid::new_v4()}).to_string();
    assert_eq!(send(&case.state, "POST", &path, &[], &query).await.0, 401);
    assert_eq!(
        send(&case.state, "POST", &path, &[&auth], &query).await.0,
        404
    );
    for invalid in [
        "{}",
        "{\"operation_id\":null}",
        "{\"operation_id\":\"bad\"}",
        "{\"operation_id\":\"00000000-0000-0000-0000-000000000000\"}",
    ] {
        assert_eq!(
            send(&case.state, "POST", &path, &[&auth], invalid).await.0,
            400
        );
    }
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    assert_eq!(
        send(&case.state, "POST", &path, &[&cookie], &query).await.0,
        403
    );
    case.finish().await;
}
