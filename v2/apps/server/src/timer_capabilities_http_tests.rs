use super::*;
use crate::conversation_resources_http::tests::{case, send};

#[tokio::test]
async fn timer_capability_permission_health_and_revocation() {
    let case = case().await;
    let path = case.path("/native-timer-capability");
    let auth = case.auth();
    assert_eq!(send(&case.state, "GET", &path, &[], "").await.0, 401);
    let (status, value) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(status, 200);
    assert_eq!(value["status"], "setup_required");
    let (_, issued) = send(
        &case.state,
        "PUT",
        &case.path("/agent-timer-grant"),
        &[&auth],
        "",
    )
    .await;
    let (_, value) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(value["status"], "unhealthy");
    assert!(!value
        .to_string()
        .contains(issued["grant"].as_str().unwrap()));
    case.state.timers.ready.store(true, Ordering::Release);
    let (_, value) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(value["status"], "denied");
    let mut facts: AgentTimerDiscovery =
        serde_json::from_value(value["observations"].clone()).unwrap();
    facts.running_deep = true;
    facts.recurring_allowed = true;
    assert_eq!(projection(facts.clone(), true)["status"], "ready");
    facts.eligible = false;
    assert_eq!(projection(facts.clone(), true)["status"], "denied");
    facts.eligible = true;
    facts.recurring_allowed = false;
    assert_eq!(
        projection(facts, true)["recurring"]["status"],
        "not_supported"
    );
    send(
        &case.state,
        "DELETE",
        &case.path("/agent-timer-grant"),
        &[&auth],
        "",
    )
    .await;
    let (_, value) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(value["status"], "setup_required");
    case.finish().await;
}
