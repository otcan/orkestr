use super::*;
use crate::conversation_resources_http::tests::{case, send};
#[path = "timer_capabilities_http_fixture.rs"]
mod fixture;

#[tokio::test]
async fn timer_capability_http_running_turn_tracks_scheduler_and_revocation() {
    let case = fixture::running(false).await;
    let auth = case.auth();
    let path = case.path("/native-timer-capability");
    let (_, grant) = send(
        &case.state,
        "PUT",
        &case.path("/agent-timer-grant"),
        &[&auth],
        "",
    )
    .await;
    case.state.timers.ready.store(true, Ordering::Release);
    let (status, ready) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(status, 200);
    assert_eq!(ready["status"], "ready");
    assert_eq!(ready["observations"]["running_deep"], true);
    assert_eq!(ready["recurring"]["status"], "ready");
    assert!(!ready.to_string().contains(grant["grant"].as_str().unwrap()));
    case.state.timers.ready.store(false, Ordering::Release);
    let (_, unhealthy) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(unhealthy["status"], "unhealthy");
    assert_eq!(unhealthy["reason"], "scheduler_unavailable");
    case.state.timers.ready.store(true, Ordering::Release);
    assert_eq!(
        send(&case.state, "GET", &path, &[&auth], "").await.1["status"],
        "ready"
    );
    send(
        &case.state,
        "DELETE",
        &case.path("/agent-timer-grant"),
        &[&auth],
        "",
    )
    .await;
    let (_, revoked) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(revoked["status"], "setup_required");
    assert_eq!(revoked["observations"]["running_deep"], true);
    assert_eq!(revoked["observations"]["grant"]["issued"], false);
    // Discovery and refresh have not created a timer.
    let (_, timers) = send(&case.state, "GET", &case.path("/timers"), &[&auth], "").await;
    assert_eq!(timers["timers"].as_array().unwrap().len(), 0);
    case.finish().await;
}

#[tokio::test]
async fn timer_capability_http_refreshes_limits_from_owner_updates() {
    let case = case().await;
    let auth = case.auth();
    let path = case.path("/native-timer-capability");
    for (body, mode, cap) in [
        (
            r#"{"mode":"fixed","daily_creates_max":7}"#,
            "fixed",
            serde_json::json!(7),
        ),
        (r#"{"mode":"off"}"#, "off", serde_json::Value::Null),
        (r#"{"mode":"default"}"#, "default", serde_json::json!(24)),
    ] {
        assert_eq!(
            send(
                &case.state,
                "PUT",
                &case.path("/agent-timer-limits"),
                &[&auth],
                body
            )
            .await
            .0,
            200
        );
        let (status, current) = send(&case.state, "GET", &path, &[&auth], "").await;
        assert_eq!(status, 200);
        assert_eq!(current["freshness"], "per_request");
        assert_eq!(current["observations"]["limits"]["mode"], mode);
        assert_eq!(current["observations"]["limits"]["daily_creates_max"], cap);
    }
    case.finish().await;
}

#[tokio::test]
async fn timer_capability_http_timer_origin_matches_operation_restrictions() {
    let case = fixture::running(true).await;
    let auth = case.auth();
    let (_, grant) = send(
        &case.state,
        "PUT",
        &case.path("/agent-timer-grant"),
        &[&auth],
        "",
    )
    .await;
    let header = format!(
        "{AGENT_TIMER_GRANT_HEADER}: {}",
        grant["grant"].as_str().unwrap()
    );
    case.state.timers.ready.store(true, Ordering::Release);
    let (status, current) = send(
        &case.state,
        "GET",
        &case.path("/native-timer-capability"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(current["status"], "ready");
    assert_eq!(current["observations"]["running_deep"], true);
    assert_eq!(current["observations"]["recurring_allowed"], false);
    assert_eq!(current["recurring"]["status"], "not_supported");
    assert_eq!(current["recurring"]["reason"], "timer_origin_turn");
    let recurring = serde_json::json!({"request_key":"synthetic-recurring", "label":"Synthetic recurring", "text":"Synthetic reminder",
        "schedule":{"kind":"calendar","timezone":"UTC","weekdays":[],"start_minute":540,"end_minute":540,"every_hours":1,"minutes":[0]}});
    let (status, refused) = send(
        &case.state,
        "POST",
        &case.path("/agent-timers"),
        &[&header],
        &recurring.to_string(),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(refused["code"], "agent_timer_timer_turn");
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let once = serde_json::json!({"request_key":"synthetic-once", "label":"Synthetic once", "text":"Synthetic reminder",
        "schedule":{"kind":"once","due_ms":now_ms+180_000}});
    let (status, created) = send(
        &case.state,
        "POST",
        &case.path("/agent-timers"),
        &[&header],
        &once.to_string(),
    )
    .await;
    assert_eq!(status, 201, "{created}");
    assert_eq!(created["timer"]["created_by_agent"], true);
    case.finish().await;
}

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
