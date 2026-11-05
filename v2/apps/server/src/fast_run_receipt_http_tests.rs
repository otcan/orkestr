use super::*;

#[tokio::test]
async fn fast_run_receipt_http_requires_auth_csrf_and_exact_input_ids() {
    let case = case().await;
    let auth = case.auth();
    let path = case.path("/fast-runs/lookup");
    let query =
        serde_json::json!({"input_message_id":Uuid::new_v4(),"input_event_id":Uuid::new_v4()})
            .to_string();
    assert_eq!(send(&case.state, "POST", &path, &[], &query).await.0, 401);
    assert_eq!(
        send(&case.state, "POST", &path, &[&auth], &query).await.0,
        404
    );
    for body in ["{}","{\"input_message_id\":true}",
                 "{\"input_message_id\":\"00000000-0000-0000-0000-000000000000\",\"input_event_id\":\"00000000-0000-0000-0000-000000000000\"}"] {
        assert_eq!(send(&case.state,"POST",&path,&[&auth],body).await.0,400);
    }
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    assert_eq!(
        send(&case.state, "POST", &path, &[&cookie], &query).await.0,
        403
    );
    case.finish().await;
}
