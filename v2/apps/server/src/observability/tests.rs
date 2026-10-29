use super::metrics::{is_error, Metrics};
use super::*;
use crate::conversation_resources_http::tests::case;
use std::collections::BTreeMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(crate) struct Raw {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

/// One HTTP/1.1 exchange with `app` on an ephemeral loopback listener.
pub(crate) async fn raw(app: Router, method: &str, path: &str, headers: &[&str]) -> Raw {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    let mut request =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:19882\r\nConnection: close\r\n");
    for header in headers {
        request.push_str(header);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut output = Vec::new();
    socket.read_to_end(&mut output).await.unwrap();
    server.abort();
    let split = output.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = std::str::from_utf8(&output[..split]).unwrap();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let mut body = output[split + 4..].to_vec();
    if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        let mut out = Vec::new();
        let mut rest = body.as_slice();
        loop {
            let end = rest.windows(2).position(|w| w == b"\r\n").unwrap();
            let size = usize::from_str_radix(std::str::from_utf8(&rest[..end]).unwrap().trim(), 16)
                .unwrap();
            rest = &rest[end + 2..];
            if size == 0 {
                break;
            }
            out.extend_from_slice(&rest[..size]);
            rest = &rest[size + 2..];
        }
        body = out;
    }
    Raw {
        status,
        headers,
        body,
    }
}

#[test]
fn request_ids_from_clients_are_kept_only_when_plain() {
    let value = |v: &str| HeaderValue::from_str(v).unwrap();
    assert_eq!(
        accepted_id(Some(&value("abc-123_DEF.9"))).as_deref(),
        Some("abc-123_DEF.9")
    );
    for refused in [
        "short",
        "has space here",
        "semi;colon12",
        "quote\"d123456",
        &"x".repeat(65),
    ] {
        assert_eq!(accepted_id(Some(&value(refused))), None, "{refused}");
    }
    assert_eq!(accepted_id(None), None);
    let fresh = new_id();
    assert_eq!(accepted_id(Some(&value(&fresh))), Some(fresh));
}

#[test]
fn upstream_routes_never_carry_ids_or_queries() {
    use crate::desktop_broker::route_template;
    assert_eq!(
        route_template("GET", "/api/threads/summary?includeRetired=1"),
        "GET /api/threads/summary"
    );
    assert_eq!(
        route_template("GET", "/api/threads/c43c0156abc/messages?limit=3&before=9"),
        "GET /api/threads/{id}/messages"
    );
    assert_eq!(
        route_template("POST", "/api/desktops/office-pc/acquire"),
        "POST /api/desktops/{id}/acquire"
    );
}

#[test]
fn windowed_percentiles_errors_and_prometheus_text() {
    let metrics = Metrics::default();
    for ms in 1..=100u64 {
        let status = if ms % 25 == 0 { 503 } else { 200 };
        metrics.record(
            "GET",
            "/api/v2/sidebar",
            status,
            Duration::from_millis(ms),
            false,
        );
    }
    metrics.record_upstream(
        "v1",
        "GET /api/threads/summary",
        0,
        Duration::from_millis(40),
    );
    let window = metrics
        .window("GET", "/api/v2/sidebar", Duration::from_secs(60))
        .unwrap();
    assert_eq!(window.count, 100);
    assert_eq!(window.errors, 4);
    assert_eq!(
        (window.p50, window.p95, window.p99, window.max),
        (50.0, 95.0, 99.0, 100.0)
    );
    assert!(window.complete);
    assert!(metrics
        .window("GET", "/api/v2/other", Duration::from_secs(60))
        .is_none());

    let summary = metrics.summary(Duration::from_secs(60), Duration::from_millis(500));
    assert_eq!(summary["overall"]["count"], 100);
    assert_eq!(summary["overall"]["error_rate"], 0.04);
    assert_eq!(summary["routes"][0]["route"], "/api/v2/sidebar");
    assert_eq!(summary["routes"][0]["p95_ms"], 95.0);
    assert_eq!(summary["upstream"][0]["errors"], 1);

    let text = metrics.prometheus(Duration::from_secs(60));
    assert!(text.contains(
        "orkestr_v2_http_requests_total{method=\"GET\",route=\"/api/v2/sidebar\",status_class=\"5xx\"} 4"
    ));
    assert!(text.contains(
        "orkestr_v2_http_duration_seconds_bucket{method=\"GET\",route=\"/api/v2/sidebar\",le=\"0.1\"} 100"
    ));
    assert!(text.contains(
        "orkestr_v2_http_window_duration_seconds{method=\"GET\",route=\"/api/v2/sidebar\",quantile=\"0.95\"} 0.095"
    ));
    assert!(text.contains("orkestr_v2_upstream_requests_total{target=\"v1\",route=\"GET /api/threads/summary\",status_class=\"none\"} 1"));
    assert!(is_error(408) && is_error(0) && is_error(502) && !is_error(404));
}

#[test]
fn log_lines_hold_templates_and_timings_only() {
    let calls = vec![context::UpstreamCall {
        target: "v1",
        route: "GET /api/threads/{id}/messages".into(),
        status: 200,
        elapsed: Duration::from_millis(321),
    }];
    let spans = vec![("db_list", Duration::from_micros(4200))];
    let line = log::line(&log::RequestLine {
        id: "0123456789abcdef",
        method: "GET",
        route: "/api/v2/v1-threads/{thread}/messages",
        status: 200,
        elapsed: Duration::from_millis(612),
        slow: true,
        streaming: false,
        upstream: &calls,
        spans: &spans,
    });
    assert_eq!(line["msg"], "slow_request");
    assert_eq!(line["level"], "warn");
    assert_eq!(line["route"], "/api/v2/v1-threads/{thread}/messages");
    assert_eq!(line["upstream"][0]["ms"], 321.0);
    assert_eq!(line["upstream_ms"], 321.0);
    assert_eq!(line["spans"]["db_list"], 4.2);
    let timing = log::server_timing(Duration::from_millis(612), &calls, &spans);
    assert_eq!(
        timing,
        "app;dur=612, v1;dur=321;desc=\"1 call(s)\", db_list;dur=4.2"
    );
}

#[tokio::test]
async fn every_response_carries_its_id_and_route_template_metrics() {
    let case = case().await;
    let app = layer(crate::router(case.state.clone()));
    let id = "client-supplied-0001";
    let path = format!("/api/v2/conversations/{}/window", case.conversation);
    // Unauthenticated: the error body names the same id as the header.
    let response = raw(app.clone(), "GET", &path, &[&format!("X-Request-Id: {id}")]).await;
    assert_eq!(response.status, 401);
    assert_eq!(response.headers["x-request-id"], id);
    assert!(response.headers["server-timing"].starts_with("app;dur="));
    let body: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
    assert_eq!(body["request_id"], id);
    // A refused id is replaced, never echoed.
    let response = raw(
        app.clone(),
        "GET",
        &path,
        &["X-Request-Id: bad id; injected=1"],
    )
    .await;
    assert_ne!(response.headers["x-request-id"], "bad id; injected=1");
    assert_eq!(response.headers["x-request-id"].len(), 32);
    // Metrics are labelled by template, never by the conversation id.
    let window = Observer::global()
        .metrics
        .window(
            "GET",
            "/api/v2/conversations/{id}/window",
            Duration::from_secs(60),
        )
        .unwrap();
    assert!(window.count >= 2);
    let text = Observer::global()
        .metrics
        .prometheus(Duration::from_secs(60));
    assert!(!text.contains(&case.conversation.to_string()));
    // Unknown API paths share one label; UI paths another.
    let _ = raw(app, "GET", "/api/v2/no-such-endpoint/123", &[]).await;
    assert!(Observer::global()
        .metrics
        .window("GET", "unmatched", Duration::from_secs(60))
        .is_some());
    case.finish().await;
}

#[tokio::test]
async fn metrics_listener_is_loopback_only_and_serves_both_formats() {
    assert!(metrics_http::parse_bind("0.0.0.0:9100").is_err());
    assert!(metrics_http::parse_bind("10.1.2.3:9100").is_err());
    assert!(metrics_http::parse_bind("127.0.0.1:0").is_err());
    assert!(metrics_http::parse_bind("127.0.0.1:19823").is_ok());
    Observer::global().metrics.record(
        "GET",
        "/api/v2/metrics-test",
        200,
        Duration::from_millis(3),
        false,
    );
    let text = raw(metrics_http::router(), "GET", "/metrics", &[]).await;
    assert_eq!(text.status, 200);
    assert!(String::from_utf8(text.body)
        .unwrap()
        .contains("route=\"/api/v2/metrics-test\""));
    let json = raw(
        metrics_http::router(),
        "GET",
        "/metrics.json?window=60",
        &[],
    )
    .await;
    assert_eq!(json.status, 200);
    let summary: serde_json::Value = serde_json::from_slice(&json.body).unwrap();
    assert_eq!(summary["window_s"], 60);
    assert!(summary["routes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["route"] == "/api/v2/metrics-test"));
    for bad in ["/metrics.json?window=1", "/metrics.json?other=1"] {
        assert_eq!(
            raw(metrics_http::router(), "GET", bad, &[]).await.status,
            400
        );
    }
    assert_eq!(
        raw(metrics_http::router(), "GET", "/api/v2/sidebar", &[])
            .await
            .status,
        404
    );
}

#[test]
fn quiet_access_log_drops_only_fast_successful_reads() {
    assert_eq!(AccessLog::parse(Some("quiet")), AccessLog::Quiet);
    assert_eq!(AccessLog::parse(Some(" all ")), AccessLog::All);
    assert_eq!(AccessLog::parse(Some("off")), AccessLog::Off);
    assert_eq!(AccessLog::parse(Some("loud")), AccessLog::Slow);
    assert_eq!(AccessLog::parse(None), AccessLog::Slow);
    let quiet = AccessLog::Quiet;
    assert!(!quiet.shows("GET", 200, false));
    assert!(!quiet.shows("GET", 204, false));
    assert!(!quiet.shows("GET", 304, false));
    assert!(!quiet.shows("HEAD", 200, false));
    assert!(quiet.shows("GET", 200, true));
    assert!(quiet.shows("GET", 404, false));
    assert!(quiet.shows("GET", 409, false));
    assert!(quiet.shows("GET", 502, false));
    assert!(quiet.shows("POST", 200, false));
    assert!(quiet.shows("PUT", 204, false));
    assert!(quiet.shows("DELETE", 200, false));
    assert!(AccessLog::All.shows("GET", 200, false));
    assert!(!AccessLog::Slow.shows("GET", 404, false));
    assert!(AccessLog::Slow.shows("GET", 500, false));
    assert!(AccessLog::Slow.shows("GET", 200, true));
    assert!(!AccessLog::Off.shows("GET", 500, true));
}
