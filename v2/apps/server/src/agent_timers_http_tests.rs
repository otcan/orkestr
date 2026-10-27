use super::*;
use crate::conversation_resources_http::tests::{case, send};

#[tokio::test]
async fn grant_lifecycle_machine_only_and_refusal_codes() {
    let case = case().await;
    let auth = case.auth();
    let (status, value) = send(
        &case.state,
        "GET",
        &case.path("/agent-timer-grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!((status, value["issued"].as_bool()), (200, Some(false)));
    let (status, value) = send(
        &case.state,
        "PUT",
        &case.path("/agent-timer-grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 201);
    let grant = value["grant"].as_str().unwrap().to_owned();
    assert_eq!(grant.len(), 64);
    assert_eq!(value["binding"]["generation"].as_i64(), Some(1));
    let header = format!("{AGENT_TIMER_GRANT_HEADER}: {grant}");
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    // Machine requests only: never beside a cookie, bearer or second grant.
    for extra in [&auth, &cookie, &header] {
        let (status, _) = send(
            &case.state,
            "GET",
            &case.path("/agent-timers"),
            &[&header, extra],
            "",
        )
        .await;
        assert_eq!(status, 401);
    }
    // A thread-ask style header or a wrong grant is not a timer grant.
    let bad = format!("{AGENT_TIMER_GRANT_HEADER}: {}", "0".repeat(64));
    let ask = format!("{THREAD_ASK_GRANT_HEADER}: {grant}");
    for headers in [vec![bad.as_str()], vec![ask.as_str()], vec![]] {
        let (status, _) = send(
            &case.state,
            "GET",
            &case.path("/agent-timers"),
            &headers,
            "",
        )
        .await;
        assert_eq!(status, 401);
    }
    // The owner credential cannot use the agent routes either.
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path("/agent-timers"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 401);
    // No running Deep turn: refused with a stable code.
    let (status, value) = send(
        &case.state,
        "GET",
        &case.path("/agent-timers"),
        &[&header],
        "",
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("agent_timer_no_running_turn"))
    );
    let create = serde_json::json!({
        "request_key": "biocytogen-1215",
        "label": "Biocytogen 12:15",
        "schedule": {"kind": "once", "due_ms": 4_000_000_000_000_i64},
        "text": "Remind the owner."
    })
    .to_string();
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/agent-timers"),
        &[&header],
        &create,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("agent_timer_no_running_turn"))
    );
    // A request never names a conversation; unknown fields are refused.
    let foreign = serde_json::json!({
        "request_key": "k", "label": "l", "text": "t",
        "schedule": {"kind": "once", "due_ms": 1},
        "conversation_id": Uuid::new_v4()
    })
    .to_string();
    for body in [foreign.as_str(), r#"{"request_key":"k"}"#, "not json"] {
        let (status, _) = send(
            &case.state,
            "POST",
            &case.path("/agent-timers"),
            &[&header],
            body,
        )
        .await;
        assert_eq!(status, 400);
    }
    let pause = r#"{"request_key":"p","operation":"pause"}"#;
    let (status, _) = send(
        &case.state,
        "POST",
        &case.path("/agent-timers/not-a-uuid/control"),
        &[&header],
        pause,
    )
    .await;
    assert_eq!(status, 400);
    let (status, _) = send(
        &case.state,
        "POST",
        &case.path(&format!("/agent-timers/{}/control", Uuid::new_v4())),
        &[&header],
        r#"{"request_key":"p","operation":"stop"}"#,
    )
    .await;
    assert_eq!(status, 400, "stop and rollback stay owner-only");
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path(&format!("/agent-timers/{}/control", Uuid::new_v4())),
        &[&header],
        pause,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("agent_timer_no_running_turn"))
    );
    // Provisioning directory: owner only, never a grant value.
    let (status, value) = send(
        &case.state,
        "GET",
        "/api/v2/agent-timer-grants",
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(value["conversations"][0]["grant"]["issued"], true);
    assert!(!value.to_string().contains(&grant));
    let (status, _) = send(
        &case.state,
        "GET",
        "/api/v2/agent-timer-grants",
        &[&header],
        "",
    )
    .await;
    assert_eq!(status, 401);
    // Revocation is immediate.
    let (status, value) = send(
        &case.state,
        "DELETE",
        &case.path("/agent-timer-grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!((status, value["issued"].as_bool()), (200, Some(false)));
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path("/agent-timers"),
        &[&header],
        "",
    )
    .await;
    assert_eq!(status, 401);
    case.finish().await;
}

#[test]
fn refusal_codes_map_to_statuses() {
    for (code, status) in [
        ("agent_timer_not_found", 404),
        ("agent_timer_rate_limited", 429),
        ("agent_timer_limit_reached", 429),
        ("agent_timer_too_soon", 422),
        ("agent_timer_too_frequent", 422),
        ("agent_timer_skip_once", 422),
        ("agent_timer_conflict", 409),
        ("agent_timer_ended", 409),
        ("agent_timer_dormant", 409),
        ("agent_timer_owner_paused", 409),
    ] {
        let Error(actual, actual_code, _) = failure(ResourceError::Conflict(code));
        assert_eq!((actual.as_u16(), actual_code), (status, code));
    }
}
