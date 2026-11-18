//! What each request returned: its conversation, response bytes and rows in
//! the log line, `Server-Timing` and the metrics summary, the busiest
//! conversations, and the owner's request metrics page.
use super::raw;
use crate::conversation_resources_http::tests::case;
use crate::observability::{
    conversation_of, layer,
    metrics::{Detail, Metrics},
    owner_http,
};
use std::time::Duration;

#[test]
fn conversation_ids_come_only_from_the_conversation_parameter() {
    let id = "00000000-0000-4000-8000-0000000000aa";
    let of = |route: &str, path: &str| conversation_of(route, path).map(|c| c.to_string());
    assert_eq!(
        of(
            "/api/v2/conversations/{id}/accepted-results",
            &format!("/api/v2/conversations/{id}/accepted-results")
        )
        .as_deref(),
        Some(id)
    );
    assert_eq!(
        of(
            "/api/v2/conversations/{id}",
            &format!("/api/v2/conversations/{id}")
        )
        .as_deref(),
        Some(id)
    );
    assert_eq!(
        of(
            "/api/v2/conversations/{conversation}/encrypted-uploads/{id}",
            &format!(
                "/api/v2/conversations/{id}/encrypted-uploads/00000000-0000-4000-8000-0000000000bb"
            )
        )
        .as_deref(),
        Some(id)
    );
    // Other identifiers, non-UUID values and unmatched paths name nothing.
    assert_eq!(
        of("/api/v2/timers/{id}", &format!("/api/v2/timers/{id}")),
        None
    );
    assert_eq!(
        of(
            "/api/v2/conversations/{id}",
            "/api/v2/conversations/not-a-uuid"
        ),
        None
    );
    assert_eq!(of("/api/v2/conversations", "/api/v2/conversations"), None);
    assert_eq!(of("static", "/index.html"), None);
    assert_eq!(
        of("unmatched", &format!("/api/v2/conversations/{id}")),
        None
    );
}

#[test]
fn summary_reports_sizes_and_the_busiest_conversations() {
    let metrics = Metrics::default();
    let chat = uuid::Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap();
    let other = uuid::Uuid::parse_str("00000000-0000-4000-8000-000000000002").unwrap();
    let replies = "/api/v2/conversations/{id}/accepted-results";
    let snapshot = "/api/v2/conversations/{id}";
    let detail = |bytes, rows, conversation| Detail {
        bytes: Some(bytes),
        rows: Some(rows),
        conversation: Some(conversation),
    };
    // A chat that opens with 48 sequential reply pages and one history page.
    for _ in 0..48 {
        metrics.record_request(
            "GET",
            replies,
            200,
            Duration::from_millis(2),
            false,
            detail(6_000, 20, chat),
        );
    }
    metrics.record_request(
        "GET",
        snapshot,
        200,
        Duration::from_millis(5),
        false,
        detail(36_000, 100, chat),
    );
    metrics.record_request(
        "GET",
        snapshot,
        200,
        Duration::from_millis(1),
        false,
        detail(900, 3, other),
    );
    metrics.record(
        "GET",
        "/api/v2/sidebar",
        200,
        Duration::from_millis(40),
        false,
    );
    let summary = metrics.summary(Duration::from_secs(60), Duration::from_millis(500));
    let conversations = summary["conversations"].as_array().unwrap();
    assert_eq!(
        conversations.len(),
        2,
        "requests without a conversation are not listed"
    );
    let busiest = &conversations[0];
    assert_eq!(busiest["conversation"], chat.to_string());
    assert_eq!(busiest["requests"], 49);
    assert_eq!(busiest["total_ms"], 101.0);
    assert_eq!(busiest["max_ms"], 5.0);
    assert_eq!(busiest["bytes"], 48 * 6_000 + 36_000);
    assert_eq!(busiest["rows"], 48 * 20 + 100);
    assert_eq!(busiest["routes"][0]["route"], replies);
    assert_eq!(busiest["routes"][0]["count"], 48);
    assert_eq!(busiest["routes"][0]["total_ms"], 96.0);
    assert_eq!(busiest["routes"][1]["route"], snapshot);
    assert_eq!(conversations[1]["conversation"], other.to_string());
    let route = |name: &str| {
        summary["routes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["route"] == name)
            .unwrap()
            .clone()
    };
    let history = route(snapshot);
    assert_eq!(history["bytes_p50"], 900);
    assert_eq!(history["bytes_max"], 36_000);
    assert_eq!(history["bytes_total"], 36_900);
    assert_eq!(history["rows_total"], 103);
    let sidebar = route("/api/v2/sidebar");
    assert!(sidebar["bytes_p50"].is_null());
    assert_eq!(sidebar["rows_total"], 0);
    // Prometheus labels stay route templates: no conversation ids.
    let text = metrics.prometheus(Duration::from_secs(60));
    assert!(!text.contains(&chat.to_string()) && !text.contains(&other.to_string()));
}

#[tokio::test]
async fn chat_reads_report_rows_and_the_owner_reads_request_metrics() {
    use orkestr_v2_application::IntakeStore;
    let case = case().await;
    let owner = case
        .state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    for index in 0..3 {
        case.state
            .store
            .admit(
                &owner,
                &case.conversation,
                &orkestr_v2_contracts::MessageInput {
                    client_message_id: uuid::Uuid::new_v4().to_string(),
                    text: format!("Synthetic {index}"),
                },
            )
            .await
            .unwrap();
    }
    let app = layer(crate::router(case.state.clone()));
    let auth = case.auth();
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    // A chat opens with its newest page only.
    let newest = raw(
        app.clone(),
        "GET",
        &case.path("?before=9223372036854775807&limit=2"),
        &[&auth],
    )
    .await;
    assert_eq!(newest.status, 200);
    let timing = &newest.headers["server-timing"];
    assert!(timing.ends_with("rows;desc=\"2\""), "{timing}");
    let page: serde_json::Value = serde_json::from_slice(&newest.body).unwrap();
    let texts: Vec<_> = page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["text"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(texts, ["Synthetic 1", "Synthetic 2"]);
    assert!(page["next_cursor"].is_null());
    for bad in [
        "?before=0",
        "?before=9&after=1",
        "?before=x",
        "?before=9&limit=101",
    ] {
        let status = raw(app.clone(), "GET", &case.path(bad), &[&auth])
            .await
            .status;
        assert_eq!(status, 400, "{bad}");
    }
    // The newest replies, and the same refusals for a bad cursor.
    let replies = raw(
        app.clone(),
        "GET",
        &case.path("/accepted-results?before_sequence=9223372036854775807&limit=50"),
        &[&cookie],
    )
    .await;
    assert_eq!(replies.status, 200);
    let body: serde_json::Value = serde_json::from_slice(&replies.body).unwrap();
    assert!(body["results"].as_array().unwrap().is_empty());
    assert!(body["next_after_sequence"].is_null());
    for bad in [
        "/accepted-results?before_sequence=0",
        "/accepted-results?before_sequence=9&after_sequence=1",
    ] {
        let status = raw(app.clone(), "GET", &case.path(bad), &[&cookie])
            .await
            .status;
        assert_eq!(status, 400, "{bad}");
    }
    // Only the owner's password-signed-in browser session reads the metrics.
    for headers in [vec![], vec![auth.as_str()]] {
        let response = raw(app.clone(), "GET", owner_http::PATH, &headers).await;
        assert_eq!(response.status, 401, "{headers:?}");
    }
    let refused = raw(
        app.clone(),
        "GET",
        "/api/v2/request-metrics?window=5",
        &[&cookie],
    )
    .await;
    assert_eq!(refused.status, 400);
    let metrics = raw(
        app.clone(),
        "GET",
        "/api/v2/request-metrics?window=60",
        &[&cookie],
    )
    .await;
    assert_eq!(metrics.status, 200);
    assert_eq!(metrics.headers["cache-control"], "no-store");
    let summary: serde_json::Value = serde_json::from_slice(&metrics.body).unwrap();
    assert_eq!(summary["window_s"], 60);
    let ours = summary["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["conversation"] == case.conversation.to_string())
        .expect("the chat that was read is listed")
        .clone();
    assert!(ours["rows"].as_u64().unwrap() >= 2, "{ours}");
    assert!(ours["bytes"].as_u64().unwrap() > 0, "{ours}");
    assert!(
        summary["routes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["route"] == "/api/v2/conversations/{id}"
                && r["rows_total"].as_u64() >= Some(2))
    );
    case.finish().await;
}
