use super::*;
use crate::conversation_resources_http::tests::{case, send};
use std::os::unix::fs::PermissionsExt;

fn config(root: &std::path::Path, mode: u32, body: &str) -> std::path::PathBuf {
    let path = root.join("restricted.json");
    std::fs::write(&path, body).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
    path
}
const GOOD: &str = r#"{"endpoints":{"stub":{"base_url":"http://127.0.0.1:9/v1","model":"m"}}}"#;

#[tokio::test]
async fn policy_routes_need_the_owner_and_a_configured_installation() {
    let mut case = case().await;
    let auth = case.auth();
    let ws = case.root.display().to_string();
    let update = serde_json::json!({"expected_revision":0,"enabled":true,"policy":{"workspace":ws,"endpoint":"stub"}}).to_string();
    let path = case.path("/restricted");
    // Unauthenticated requests are refused.
    assert_eq!(send(&case.state, "GET", &path, &[], "").await.0, 401);
    // Default: not restricted, revision 0.
    let (status, value) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(
        (
            status,
            value["enabled"].as_bool(),
            value["revision"].as_i64()
        ),
        (200, Some(false), Some(0))
    );
    // Not configured: enabling is refused.
    let (status, value) = send(&case.state, "PUT", &path, &[&auth], &update).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("restricted_unconfigured"))
    );
    // Config files must be private and valid.
    let loose = config(&case.root, 0o666, GOOD);
    assert!(case
        .state
        .clone()
        .with_restricted_config_file(&loose)
        .is_err());
    let missing_key = config(
        &case.root,
        0o600,
        r#"{"endpoints":{"stub":{"base_url":"http://x/v1","api_key_env":"ORKESTR_RT_TEST_UNSET_KEY"}}}"#,
    );
    assert!(case
        .state
        .clone()
        .with_restricted_config_file(&missing_key)
        .is_err());
    let unknown_field = config(&case.root, 0o600, r#"{"endpoints":{},"shell":true}"#);
    assert!(case
        .state
        .clone()
        .with_restricted_config_file(&unknown_field)
        .is_err());
    let relative_gpu = config(
        &case.root,
        0o600,
        r#"{"endpoints":{},"gpu":{"command":"orkestr-llm"}}"#,
    );
    assert!(case
        .state
        .clone()
        .with_restricted_config_file(&relative_gpu)
        .is_err());
    let good = config(&case.root, 0o600, GOOD);
    case.state = case
        .state
        .clone()
        .with_restricted_config_file(&good)
        .unwrap();
    let (status, value) = send(&case.state, "PUT", &path, &[&auth], &update).await;
    assert_eq!(
        (
            status,
            value["revision"].as_i64(),
            value["enabled"].as_bool()
        ),
        (200, Some(1), Some(true))
    );
    // A stale revision conflicts; a policy that smuggles a mount option is invalid.
    assert_eq!(
        send(&case.state, "PUT", &path, &[&auth], &update).await.0,
        409
    );
    let bad = serde_json::json!({"expected_revision":1,"enabled":true,"policy":{"workspace":"/w,dst=/etc","endpoint":"stub"}}).to_string();
    assert_eq!(send(&case.state, "PUT", &path, &[&auth], &bad).await.0, 400);
    // Approvals, audit and transcript are empty and owner-only; unknown approvals are refused.
    for rest in [
        "/restricted/approvals",
        "/restricted/audit",
        "/restricted/messages",
    ] {
        assert_eq!(
            send(&case.state, "GET", &case.path(rest), &[], "").await.0,
            401,
            "{rest}"
        );
        assert_eq!(
            send(&case.state, "GET", &case.path(rest), &[&auth], "")
                .await
                .0,
            200,
            "{rest}"
        );
    }
    let decision = serde_json::json!({"approve":true,"scope":"once"}).to_string();
    let unknown = case.path(&format!("/restricted/approvals/{}", Uuid::new_v4()));
    assert_eq!(
        send(&case.state, "POST", &unknown, &[&auth], &decision)
            .await
            .0,
        404
    );
    assert_eq!(
        send(
            &case.state,
            "POST",
            &case.path("/restricted/approvals/not-a-uuid"),
            &[&auth],
            &decision
        )
        .await
        .0,
        400
    );
    assert!(case
        .state
        .store
        .is_restricted_conversation(&case.conversation)
        .await
        .unwrap());
    case.finish().await;
}
