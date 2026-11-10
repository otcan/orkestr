use super::*;
use crate::conversation_resources_http::tests::{case, send, Case};
use sha2::{Digest, Sha256};
use std::sync::{Arc as StdArc, Mutex as StdMutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const V1_TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SAFE_URL: &str = "https://desk.example.test/desktop-share/synthetic?key=opaque";
const STOP_FREE: &str = r#"{"expected_lease_state":"unreserved"}"#;

/// Scripted V1. `lease_reads` are consumed in order and the last one repeats.
struct FakeV1 {
    sessions: Value,
    lease_reads: Vec<(u16, Value)>,
    action: (u16, Value),
    share: (u16, Value),
    calls: Vec<(String, String, Value)>,
}
impl FakeV1 {
    fn running_free() -> Self {
        Self {
            sessions: json!([{"slug":"desk-a","label":"Desk A","status":"active","lease":null}]),
            lease_reads: vec![(200, json!({"ok":true,"lease":null}))],
            action: (
                200,
                json!({"browser":{"slug":"desk-a","status":"inactive","ok":true}}),
            ),
            share: (
                201,
                json!({"ok":true,"url":SAFE_URL,"key":"never-forward",
                "share":{"id":"share-1","expiresAt":"2026-01-01T01:00:00Z"}}),
            ),
            calls: Vec::new(),
        }
    }
    fn reserved_by(holder: &str) -> (u16, Value) {
        (
            200,
            json!({"ok":true,"lease":{"id":"lease-1","threadId":"thread-1",
            "ownerThreadLabel":holder,"fencingToken":"never-forward",
            "expiresAt":"2026-01-01T02:00:00Z"}}),
        )
    }
    fn acted(&self, verb: &str) -> usize {
        let suffix = format!("/{verb}");
        self.calls
            .iter()
            .filter(|(method, path, _)| method == "POST" && path.ends_with(&suffix))
            .count()
    }
}

fn answer(v1: &mut FakeV1, method: &str, path: &str, body: Value) -> (u16, Value) {
    v1.calls.push((method.into(), path.into(), body));
    if method == "GET" && path == "/api/browser-sessions?inventory=owner" {
        return (200, json!({"ok":true,"sessions":v1.sessions}));
    }
    if method == "GET" && path == "/api/desktops/desk-a/lease" {
        return if v1.lease_reads.len() > 1 {
            v1.lease_reads.remove(0)
        } else {
            v1.lease_reads[0].clone()
        };
    }
    if method == "POST" && path == "/api/desktops/desk-a/share" {
        return v1.share.clone();
    }
    if method == "POST" && path.starts_with("/api/browsers/desk-a/") {
        return v1.action.clone();
    }
    (500, json!({"error":"unexpected_call"}))
}

async fn fake_v1(v1: StdArc<StdMutex<FakeV1>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            let (head, split) = loop {
                let n = socket.read(&mut buf).await.unwrap();
                raw.extend_from_slice(&buf[..n]);
                if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break (String::from_utf8_lossy(&raw[..end]).to_string(), end);
                }
            };
            let length = head
                .lines()
                .find_map(|l| l.strip_prefix("Content-Length: "))
                .map_or(0, |v| v.parse().unwrap());
            while raw.len() < split + 4 + length {
                let n = socket.read(&mut buf).await.unwrap();
                raw.extend_from_slice(&buf[..n]);
            }
            let mut line = head.lines().next().unwrap().split(' ');
            let (method, path) = (line.next().unwrap(), line.next().unwrap());
            assert!(head
                .lines()
                .any(|l| l == format!("Authorization: Bearer {V1_TOKEN}")));
            let body = serde_json::from_slice(&raw[split + 4..]).unwrap_or(Value::Null);
            let (status, value) = answer(&mut v1.lock().unwrap(), method, path, body);
            let text = value.to_string();
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                text.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    format!("http://{address}")
}

async fn setup(v1: FakeV1) -> (Case, StdArc<StdMutex<FakeV1>>) {
    let mut c = case().await;
    let v1 = StdArc::new(StdMutex::new(v1));
    let url = fake_v1(v1.clone()).await;
    c.state.desktop_broker = Some(Arc::new(Broker::new(&url, V1_TOKEN.into()).unwrap()));
    (c, v1)
}

/// The owner's browser session: cookie, same origin and CSRF token.
fn browser(c: &Case) -> [String; 3] {
    [
        format!("Cookie: orkestr_v2_session={}", c.cookie),
        "Origin: http://127.0.0.1:19882".into(),
        format!(
            "x-orkestr-csrf: {:x}",
            Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{}", c.cookie).as_bytes())
        ),
    ]
}

async fn post(c: &Case, path: &str, headers: &[String], body: &str) -> (u16, Value) {
    let headers: Vec<&str> = headers.iter().map(String::as_str).collect();
    send(&c.state, "POST", path, &headers, body).await
}

async fn stop_with(c: &Case, body: &str) -> (u16, Value) {
    post(c, "/api/v2/desktops/desk-a/stop", &browser(c), body).await
}

#[tokio::test]
async fn only_the_owner_browser_with_csrf_reaches_v1() {
    let (c, v1) = setup(FakeV1::running_free()).await;
    let routes = [
        ("/api/v2/desktops/desk-a/start", "{}"),
        ("/api/v2/desktops/desk-a/stop", STOP_FREE),
        ("/api/v2/desktops/desk-a/link", "{}"),
    ];
    let [cookie, origin, csrf] = browser(&c);
    for (path, body) in routes {
        let (status, _) = post(&c, path, &[], body).await;
        assert_eq!(status, 401, "{path} without a credential");
        // A valid owner Bearer is how service credentials authenticate.
        let (status, _) = post(&c, path, &[c.auth()], body).await;
        assert_eq!(status, 401, "{path} with a Bearer credential");
        let (status, value) = post(&c, path, &[cookie.clone(), origin.clone()], body).await;
        assert_eq!(
            (status, value["code"].as_str()),
            (403, Some("csrf_rejected")),
            "{path} without CSRF"
        );
        let foreign = "Origin: https://other.example.test".to_string();
        let (status, _) = post(&c, path, &[cookie.clone(), foreign, csrf.clone()], body).await;
        assert_eq!(status, 403, "{path} from another origin");
    }
    assert!(v1.lock().unwrap().calls.is_empty());
    c.finish().await;
}

#[tokio::test]
async fn invalid_slugs_and_extra_fields_never_reach_v1() {
    let (c, v1) = setup(FakeV1::running_free()).await;
    let headers = browser(&c);
    for (path, body) in [
        ("/api/v2/desktops/UPPER/stop", STOP_FREE),
        ("/api/v2/desktops/desk-a/start", r#"{"force":true}"#),
        ("/api/v2/desktops/desk-a/link", r#"{"threadId":"other"}"#),
        (
            "/api/v2/desktops/desk-a/stop",
            r#"{"expected_lease_state":"unreserved","force":true}"#,
        ),
    ] {
        let (status, _) = post(&c, path, &headers, body).await;
        assert_eq!(status, 400, "{path} {body}");
    }
    assert!(v1.lock().unwrap().calls.is_empty());
    c.finish().await;
}

#[tokio::test]
async fn a_free_desk_stops_with_an_empty_v1_body() {
    let (c, v1) = setup(FakeV1::running_free()).await;
    let (status, value) = stop_with(&c, STOP_FREE).await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["stopped"], true);
    assert_eq!(value["state"], "inactive");
    assert_eq!(value["interrupted_holder"], Value::Null);
    let calls = v1.lock().unwrap().calls.clone();
    let stop = calls.iter().find(|c| c.1.ends_with("/stop")).unwrap();
    assert_eq!(
        (stop.1.as_str(), &stop.2),
        ("/api/browsers/desk-a/stop", &json!({}))
    );
    // The lease is read after the inventory, as close to the stop as possible.
    let order: Vec<&str> = calls.iter().map(|c| c.1.as_str()).collect();
    assert_eq!(
        order[..3],
        [
            "/api/browser-sessions?inventory=owner",
            "/api/desktops/desk-a/lease",
            "/api/browsers/desk-a/stop"
        ]
    );
    c.finish().await;
}

#[tokio::test]
async fn a_reserved_desk_needs_a_confirmation_naming_its_current_holder() {
    let mut fake = FakeV1::running_free();
    let lease = FakeV1::reserved_by("Chat one");
    fake.sessions[0]["lease"] = lease.1["lease"].clone();
    fake.lease_reads = vec![lease];
    let (c, v1) = setup(fake).await;

    for (body, code) in [
        (STOP_FREE, "desktop_reservation_changed"),
        (
            r#"{"expected_lease_state":"reserved","expected_holder":"Chat one"}"#,
            "desktop_stop_confirmation_required",
        ),
        (
            r#"{"expected_lease_state":"reserved","expected_holder":"Chat two","confirm_interruption":true}"#,
            "desktop_reservation_changed",
        ),
    ] {
        let (status, value) = stop_with(&c, body).await;
        assert_eq!(
            (status, value["code"].as_str()),
            (409, Some(code)),
            "{body}"
        );
        assert_eq!(v1.lock().unwrap().acted("stop"), 0, "{body}");
    }

    let (status, value) = stop_with(
        &c,
        r#"{"expected_lease_state":"reserved","expected_holder":"Chat one","confirm_interruption":true}"#,
    )
    .await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(v1.lock().unwrap().acted("stop"), 1);
    // The confirmed holder is not reported as a surprise, and the V1 call does
    // not touch the lease.
    assert_eq!(value["interrupted_holder"], Value::Null);
    let calls = v1.lock().unwrap().calls.clone();
    assert_eq!(
        calls.iter().find(|c| c.1.ends_with("/stop")).unwrap().2,
        json!({})
    );
    assert!(!value.to_string().contains("never-forward"));
    assert!(!calls
        .iter()
        .any(|c| c.1.contains("/release") || c.1.contains("/acquire")));
    c.finish().await;
}

#[tokio::test]
async fn a_failed_lease_read_is_unknown_even_when_the_inventory_says_free() {
    let mut fake = FakeV1::running_free();
    // The inventory's lease join turns a store error into `lease: null`.
    fake.lease_reads = vec![(500, json!({"error":"store_unavailable"}))];
    let (c, v1) = setup(fake).await;
    let (status, value) = stop_with(&c, STOP_FREE).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_reservation_changed"))
    );
    let (status, value) = stop_with(&c, r#"{"expected_lease_state":"unknown"}"#).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_stop_confirmation_required"))
    );
    assert_eq!(v1.lock().unwrap().acted("stop"), 0);
    let (status, value) = stop_with(
        &c,
        r#"{"expected_lease_state":"unknown","confirm_interruption":true}"#,
    )
    .await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["reservation_after_verified"], false);
    c.finish().await;
}

#[tokio::test]
async fn an_inventory_reservation_outranks_a_lease_read_of_free() {
    let mut fake = FakeV1::running_free();
    fake.sessions[0]["lease"] = FakeV1::reserved_by("Chat one").1["lease"].clone();
    let (c, v1) = setup(fake).await;
    let (status, value) = stop_with(&c, STOP_FREE).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_reservation_changed"))
    );
    assert_eq!(v1.lock().unwrap().acted("stop"), 0);
    c.finish().await;
}

#[tokio::test]
async fn a_reservation_that_appears_during_the_stop_is_reported() {
    let mut fake = FakeV1::running_free();
    fake.lease_reads = vec![
        (200, json!({"ok":true,"lease":null})),
        FakeV1::reserved_by("Chat two"),
    ];
    let (c, _) = setup(fake).await;
    let (status, value) = stop_with(&c, STOP_FREE).await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["interrupted_holder"], "Chat two");
    c.finish().await;
}

#[tokio::test]
async fn an_unverified_runtime_needs_confirmation_and_a_stopped_desk_is_refused() {
    let mut fake = FakeV1::running_free();
    fake.sessions[0]["status"] = json!("unknown");
    let (c, v1) = setup(fake).await;
    let (status, value) = stop_with(&c, STOP_FREE).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_stop_confirmation_required"))
    );
    v1.lock().unwrap().sessions[0]["status"] = json!("inactive");
    let (status, value) = stop_with(&c, STOP_FREE).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_stop_not_applicable"))
    );
    assert_eq!(v1.lock().unwrap().acted("stop"), 0);
    c.finish().await;
}

#[tokio::test]
async fn start_only_touches_a_desk_that_is_down() {
    let (c, v1) = setup(FakeV1::running_free()).await;
    let start = "/api/v2/desktops/desk-a/start";
    let headers = browser(&c);
    let (status, value) = post(&c, start, &headers, "{}").await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_start_not_applicable"))
    );
    assert_eq!(
        v1.lock().unwrap().acted("start"),
        0,
        "running desks are left alone"
    );

    {
        let mut fake = v1.lock().unwrap();
        fake.sessions[0]["status"] = json!("inactive");
        fake.action = (200, json!({"browser":{"status":"active","ok":true}}));
    }
    let (status, value) = post(&c, start, &headers, "{}").await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(
        (value["started"].as_bool(), value["state"].as_str()),
        (Some(true), Some("active"))
    );
    let calls = v1.lock().unwrap().calls.clone();
    let start_call = calls.iter().find(|c| c.1.ends_with("/start")).unwrap();
    assert_eq!(
        (start_call.1.as_str(), &start_call.2),
        ("/api/browsers/desk-a/start", &json!({}))
    );
    c.finish().await;
}

#[tokio::test]
async fn v1_refusals_stay_refusals() {
    let (c, v1) = setup(FakeV1::running_free()).await;
    let headers = browser(&c);
    v1.lock().unwrap().sessions[0]["status"] = json!("inactive");
    let start = "/api/v2/desktops/desk-a/start";
    let cases = [
        (
            403,
            json!({"error":"desktop_thread_scope_required"}),
            403,
            "desktop_action_denied",
        ),
        (
            409,
            json!({"error":"desktop_leased"}),
            409,
            "desktop_action_conflict",
        ),
        (
            404,
            json!({"error":"browser_session_not_found"}),
            404,
            "desktop_not_found",
        ),
        (
            500,
            json!({"error":"browserctl_failed"}),
            503,
            "desktop_action_failed",
        ),
        (
            200,
            json!({"browser":{"ok":false}}),
            503,
            "desktop_action_failed",
        ),
        (
            200,
            json!({"browser":{"ok":true,"launchError":"synthetic"}}),
            503,
            "desktop_action_failed",
        ),
    ];
    for (v1_status, v1_body, status, code) in cases {
        v1.lock().unwrap().action = (v1_status, v1_body);
        let (actual, value) = post(&c, start, &headers, "{}").await;
        assert_eq!((actual, value["code"].as_str()), (status, Some(code)));
    }
    c.finish().await;
}

#[tokio::test]
async fn link_never_starts_the_desk_and_only_publishes_a_safe_url() {
    let (c, v1) = setup(FakeV1::running_free()).await;
    let link = "/api/v2/desktops/desk-a/link";
    let headers = browser(&c);
    let (status, value) = post(&c, link, &headers, "{}").await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(
        value,
        json!({"url":SAFE_URL,"challenge_required":true,"expires_at":"2026-01-01T01:00:00Z"})
    );
    let calls = v1.lock().unwrap().calls.clone();
    assert_eq!(
        calls.len(),
        1,
        "a link needs no lifecycle or inventory call"
    );
    assert_eq!(
        (calls[0].0.as_str(), calls[0].1.as_str(), &calls[0].2),
        (
            "POST",
            "/api/desktops/desk-a/share",
            &json!({"start":false,"ifAbsent":true})
        )
    );

    for unsafe_url in [
        "javascript:alert(1)",
        "http://desk.example.test/desktop-share/synthetic?key=opaque",
        "https://user:password@desk.example.test/desktop-share/synthetic",
        "https://desk.example.test/elsewhere",
    ] {
        v1.lock().unwrap().share = (201, json!({"ok":true,"url":unsafe_url}));
        let (status, value) = post(&c, link, &headers, "{}").await;
        assert_eq!(
            (status, value["code"].as_str()),
            (503, Some("desktop_action_failed")),
            "{unsafe_url}"
        );
        assert!(!value.to_string().contains(unsafe_url));
    }

    for (v1_status, status, code) in [
        (409, 409, "desktop_link_exists"),
        (403, 403, "desktop_action_denied"),
        (503, 503, "desktop_link_not_ready"),
    ] {
        v1.lock().unwrap().share = (v1_status, json!({"error":"synthetic"}));
        let (actual, value) = post(&c, link, &headers, "{}").await;
        assert_eq!((actual, value["code"].as_str()), (status, Some(code)));
    }
    c.finish().await;
}

#[test]
fn owner_actions_get_the_long_deadline() {
    for action in ["start", "stop", "link"] {
        assert!(crate::desktop_slow_path(&format!(
            "/api/v2/desktops/desk-a/{action}"
        )));
    }
    assert!(!crate::desktop_slow_path("/api/v2/desktops/desk-a/other"));
    assert!(!crate::desktop_slow_path("/api/v2/desktops"));
}
