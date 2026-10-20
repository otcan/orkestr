use super::*;
use crate::conversation_resources_http::tests::{case, send};
use serde_json::{json, Value};
use std::sync::{Arc as StdArc, Mutex as StdMutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const V1_TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";

/// Synthetic V1 lease broker with V1's observable semantics: one lease per
/// slug, same-thread acquire renews with the same token, stale token -> 404,
/// other thread -> 409.
#[derive(Default)]
struct FakeV1 {
    grants: Vec<String>,
    lease: Option<(String, String, String, i64)>,
    counter: i64,
    calls: Vec<String>,
}
fn reply(status: u16, body: Value) -> (u16, Value) {
    (status, body)
}
fn handle(v1: &mut FakeV1, method: &str, path: &str, auth: bool, body: Value) -> (u16, Value) {
    v1.calls.push(format!("{method} {path}"));
    if !auth {
        return reply(401, json!({"error":"unauthorized"}));
    }
    if method == "GET" && path.ends_with("/desktop-grants") {
        let grants: Vec<Value> = v1
            .grants
            .iter()
            .map(|s| json!({"desktopSlug": s, "permissions": ["discover","acquire"]}))
            .collect();
        return reply(200, json!({"grants": grants}));
    }
    let slug = path.split('/').nth(3).unwrap_or_default().to_owned();
    let thread = body["threadId"].as_str().unwrap_or_default().to_owned();
    let token = body["fencingToken"].as_str().unwrap_or_default().to_owned();
    let lease = |t: &str, k: &str, v: i64| {
        json!({"id": format!("{slug}:u:{t}:{v}"), "desktopSlug": slug, "threadId": t,
        "fencingToken": k, "fencingVersion": v, "expiresAt": "2026-10-20T13:00:00.000Z"})
    };
    match path.rsplit('/').next() {
        Some("acquire") => match v1.lease.clone() {
            Some((s, t, k, v)) if s == slug && t == thread => {
                reply(201, json!({"ok": true, "lease": lease(&t, &k, v)}))
            }
            Some((s, _, _, _)) if s == slug => reply(409, json!({"error":"desktop_leased"})),
            _ => {
                v1.counter += 1;
                let key = format!("{:08}-0000-4000-8000-000000000000", v1.counter);
                v1.lease = Some((slug.clone(), thread.clone(), key.clone(), v1.counter));
                reply(
                    201,
                    json!({"ok": true, "lease": lease(&thread, &key, v1.counter)}),
                )
            }
        },
        Some(action @ ("heartbeat" | "release")) => match v1.lease.clone() {
            Some((s, t, _, _)) if s == slug && t != thread => {
                reply(409, json!({"error":"lease_owned_by_other_thread"}))
            }
            Some((s, _, k, v)) if s == slug && k == token => {
                if action == "release" {
                    v1.lease = None;
                }
                reply(200, json!({"ok": true, "lease": lease(&thread, &k, v)}))
            }
            _ => reply(404, json!({"error":"lease_fencing_token_invalid"})),
        },
        _ => reply(404, json!({"error":"not_found"})),
    }
}
async fn fake_v1(v1: StdArc<StdMutex<FakeV1>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                raw.extend_from_slice(&buf[..n]);
                if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&raw[..end]).to_string();
                    let length = head
                        .lines()
                        .find_map(|l| l.strip_prefix("Content-Length: "))
                        .map_or(0, |v| v.parse().unwrap());
                    if raw.len() >= end + 4 + length || n == 0 {
                        let line = head.lines().next().unwrap().to_owned();
                        let mut parts = line.split(' ');
                        let (method, path) = (
                            parts.next().unwrap().to_owned(),
                            parts.next().unwrap().to_owned(),
                        );
                        let auth = head
                            .lines()
                            .any(|l| l == format!("Authorization: Bearer {V1_TOKEN}"));
                        let body = serde_json::from_slice(&raw[end + 4..]).unwrap_or(Value::Null);
                        let (status, value) =
                            handle(&mut v1.lock().unwrap(), &method, &path, auth, body);
                        let text = value.to_string();
                        let response = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
                        socket.write_all(response.as_bytes()).await.unwrap();
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
        }
    });
    format!("http://{address}")
}

#[tokio::test]
async fn worker_grant_acquires_heartbeats_and_releases_through_v1() {
    let mut case = case().await;
    let v1 = StdArc::new(StdMutex::new(FakeV1 {
        grants: vec!["sales-nav".into()],
        ..Default::default()
    }));
    let url = fake_v1(v1.clone()).await;
    let auth = case.auth();
    // Unconfigured broker: lease routes fail closed.
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/desktops/sales-nav/acquire"),
        &[&auth],
        r#"{"ttl_ms":600000}"#,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (503, Some("desktop_broker_unconfigured"))
    );
    case.state.desktop_broker = Some(Arc::new(
        desktop_broker::Broker::new(&url, V1_TOKEN.into()).unwrap(),
    ));
    // Binding is checked against the V1 grant of the thread.
    let bind = |slugs: &[&str]| {
        json!({"expected_revision":0,"v1_thread_id":"v1-parent","desktop_slugs":slugs}).to_string()
    };
    let (status, value) = send(
        &case.state,
        "PUT",
        &case.path("/desktop-binding"),
        &[&auth],
        &bind(&["sales-nav", "gmail"]),
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (403, Some("desktop_not_granted_by_v1"))
    );
    let (status, _) = send(
        &case.state,
        "PUT",
        &case.path("/desktop-binding"),
        &[&auth],
        &bind(&["sales-nav"]),
    )
    .await;
    assert_eq!(status, 200);
    let (status, issued) = send(
        &case.state,
        "POST",
        &case.path("/desktop-binding/grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 201);
    let grant = format!(
        "{DESKTOP_GRANT_HEADER}: {}",
        issued["grant"].as_str().unwrap()
    );
    // Grant cannot be combined with owner credentials or an Origin.
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path("/desktops"),
        &[&grant, &auth],
        "",
    )
    .await;
    assert_eq!(status, 401);
    // Grant is not owner authority.
    let (status, _) = send(&case.state, "GET", &case.path("/settings"), &[&grant], "").await;
    assert_eq!(status, 401);
    let (status, granted) = send(
        &case.state,
        "POST",
        &case.path("/desktops/sales-nav/acquire"),
        &[&grant],
        r#"{"ttl_ms":600000,"purpose":"sales navigator"}"#,
    )
    .await;
    assert_eq!(status, 201, "{granted}");
    let token = granted["fencing_token"].as_str().unwrap().to_owned();
    assert_eq!(
        (
            granted["lease"]["v1_thread_id"].as_str(),
            granted["lease"]["fencing_version"].as_i64()
        ),
        (Some("v1-parent"), Some(1))
    );
    // Listing never exposes the token.
    let (_, list) = send(&case.state, "GET", &case.path("/desktops"), &[&grant], "").await;
    assert!(!list.to_string().contains(&token));
    // Wrong token is fenced by V2 before reaching V1.
    let calls = v1.lock().unwrap().calls.len();
    let wrong = json!({"fencing_token": "99999999-0000-4000-8000-000000000000"}).to_string();
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/desktops/sales-nav/heartbeat"),
        &[&grant],
        &wrong,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_fence_rejected"))
    );
    assert_eq!(v1.lock().unwrap().calls.len(), calls);
    let beat = json!({"fencing_token": token, "extend_ttl_ms": 900000}).to_string();
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/desktops/sales-nav/heartbeat"),
        &[&grant],
        &beat,
    )
    .await;
    assert_eq!(
        (status, value["state"].as_str()),
        (200, Some("active")),
        "{value}"
    );
    let release = json!({"fencing_token": token, "reason": "done"}).to_string();
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/desktops/sales-nav/release"),
        &[&grant],
        &release,
    )
    .await;
    assert_eq!(
        (
            status,
            value["state"].as_str(),
            value["end_reason"].as_str()
        ),
        (200, Some("released"), Some("done"))
    );
    assert!(v1.lock().unwrap().lease.is_none());
    case.finish().await;
}

#[tokio::test]
async fn v1_conflicts_and_lost_leases_fail_closed() {
    let mut case = case().await;
    let v1 = StdArc::new(StdMutex::new(FakeV1 {
        grants: vec!["gmail".into()],
        ..Default::default()
    }));
    let url = fake_v1(v1.clone()).await;
    case.state.desktop_broker = Some(Arc::new(
        desktop_broker::Broker::new(&url, V1_TOKEN.into()).unwrap(),
    ));
    let auth = case.auth();
    let bind = json!({"expected_revision":0,"v1_thread_id":"v1-parent","desktop_slugs":["gmail"]})
        .to_string();
    send(
        &case.state,
        "PUT",
        &case.path("/desktop-binding"),
        &[&auth],
        &bind,
    )
    .await;
    // A V1 thread already holds the desktop.
    v1.lock().unwrap().lease = Some((
        "gmail".into(),
        "v1-other".into(),
        "aaaaaaaa-0000-4000-8000-000000000000".into(),
        9,
    ));
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/desktops/gmail/acquire"),
        &[&auth],
        r#"{"ttl_ms":600000}"#,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_leased"))
    );
    v1.lock().unwrap().lease = None;
    let (status, granted) = send(
        &case.state,
        "POST",
        &case.path("/desktops/gmail/acquire"),
        &[&auth],
        r#"{"ttl_ms":600000}"#,
    )
    .await;
    assert_eq!(status, 201);
    let token = granted["fencing_token"].as_str().unwrap().to_owned();
    // V1 force-acquired it for another thread: heartbeat reports lost and V2 ends it.
    v1.lock().unwrap().lease = Some((
        "gmail".into(),
        "v1-other".into(),
        "bbbbbbbb-0000-4000-8000-000000000000".into(),
        10,
    ));
    let beat = json!({"fencing_token": token}).to_string();
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/desktops/gmail/heartbeat"),
        &[&auth],
        &beat,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_lease_lost"))
    );
    let (_, list) = send(&case.state, "GET", &case.path("/desktops"), &[&auth], "").await;
    assert_eq!(
        (
            list["leases"][0]["state"].as_str(),
            list["leases"][0]["end_reason"].as_str()
        ),
        (Some("lost"), Some("v1_lease_lost"))
    );
    // Ungranted slug is refused before V1 acquire.
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/desktops/linkedin/acquire"),
        &[&auth],
        r#"{"ttl_ms":600000}"#,
    )
    .await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("desktop_not_granted"))
    );
    assert!(!v1
        .lock()
        .unwrap()
        .calls
        .iter()
        .any(|c| c.contains("linkedin")));
    case.finish().await;
}

#[test]
fn broker_url_must_be_ipv4_loopback_http() {
    for url in [
        "https://127.0.0.1:18912",
        "http://10.0.0.1:18912",
        "http://localhost:18912",
        "http://127.0.0.1",
        "http://127.0.0.1:0",
    ] {
        assert!(
            desktop_broker::Broker::new(url, V1_TOKEN.into()).is_err(),
            "{url}"
        );
    }
    assert!(desktop_broker::Broker::new("http://127.0.0.1:18912/", V1_TOKEN.into()).is_ok());
    assert!(desktop_broker::Broker::new("http://127.0.0.1:18912", "short".into()).is_err());
    let chunked =
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"a\":1}\r\n0\r\n\r\n";
    assert_eq!(
        desktop_broker::parse_response(chunked),
        Some((200, json!({"a":1})))
    );
}
