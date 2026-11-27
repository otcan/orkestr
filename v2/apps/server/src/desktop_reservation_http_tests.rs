//! Desk reservations over HTTP, with a replay of the 2026-11-26 collision.
use super::*;
use crate::conversation_resources_http::tests::{case, send, Case};
use sha2::{Digest, Sha256};
use std::sync::{Arc as StdArc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const V1_TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SAFE_URL: &str = "https://desk.example.test/desktop-share/synthetic?key=opaque";
/// One tool step, as the desk tools take it.
const ACQUIRE: &str = r#"{"ttl_ms":120000,"purpose":"desk-form-click"}"#;

/// V1 with its observable lease rules: one lease per desk, the same thread
/// renews it, another thread gets 409, a stale token 404. Plus the owner
/// inventory (leases without tokens) and owner links.
#[derive(Default)]
struct FakeV1 {
    desks: Vec<&'static str>,
    leases: HashMap<String, (String, String, i64)>,
    counter: i64,
    calls: Vec<String>,
    acquire_delay_ms: u64,
}

fn handle(v1: &mut FakeV1, method: &str, path: &str, body: &Value) -> (u16, Value) {
    v1.calls.push(format!("{method} {path}"));
    if method == "GET" && path == "/api/browser-sessions?inventory=owner" {
        let sessions: Vec<Value> = v1
            .desks
            .iter()
            .map(|slug| {
                let lease = v1.leases.get(*slug).map(
                    |(thread, _, _)| json!({"threadId": thread, "fencingToken": "never-expose"}),
                );
                json!({"slug": slug, "label": slug, "status": "running", "lease": lease})
            })
            .collect();
        return (200, json!({"ok": true, "sessions": sessions}));
    }
    if method == "GET" && path.ends_with("/desktop-grants") {
        return (200, json!({"grants": []}));
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() != 5 || parts[2] != "desktops" {
        return (404, json!({"error": "not_found"}));
    }
    let (slug, action) = (parts[3].to_owned(), parts[4]);
    let thread = body["threadId"].as_str().unwrap_or_default().to_owned();
    let token = body["fencingToken"].as_str().unwrap_or_default().to_owned();
    let lease = |thread: &str, token: &str, version: i64| {
        json!({"id": format!("{slug}:{thread}:{version}"), "desktopSlug": slug,
            "threadId": thread, "fencingToken": token, "fencingVersion": version,
            "expiresAt": "2026-11-26T20:00:00.000Z"})
    };
    match (method, action) {
        ("POST", "acquire") => match v1.leases.get(&slug).cloned() {
            Some((t, k, v)) if t == thread => (201, json!({"ok": true, "lease": lease(&t, &k, v)})),
            Some(_) => (409, json!({"error": "desktop_leased"})),
            None => {
                v1.counter += 1;
                let key = format!("{:08}-0000-4000-8000-000000000000", v1.counter);
                v1.leases
                    .insert(slug.clone(), (thread.clone(), key.clone(), v1.counter));
                (
                    201,
                    json!({"ok": true, "lease": lease(&thread, &key, v1.counter)}),
                )
            }
        },
        ("POST", "release" | "heartbeat") => match v1.leases.get(&slug).cloned() {
            Some((t, k, v)) if t == thread && k == token => {
                if action == "release" {
                    v1.leases.remove(&slug);
                }
                (200, json!({"ok": true, "lease": lease(&t, &k, v)}))
            }
            Some(_) => (409, json!({"error": "lease_owned_by_other_thread"})),
            None => (404, json!({"error": "lease_fencing_token_invalid"})),
        },
        ("POST", "share") => (
            201,
            json!({"ok": true, "url": SAFE_URL,
                "share": {"id": "share-1", "expiresAt": "2099-01-01T00:00:00Z"}}),
        ),
        _ => (404, json!({"error": "not_found"})),
    }
}

async fn fake_v1(v1: StdArc<StdMutex<FakeV1>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let v1 = v1.clone();
            tokio::spawn(async move {
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                let (head, split) = loop {
                    let n = socket.read(&mut buf).await.unwrap();
                    raw.extend_from_slice(&buf[..n]);
                    if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        break (String::from_utf8_lossy(&raw[..end]).to_string(), end);
                    }
                    if n == 0 {
                        return;
                    }
                };
                let length = head
                    .lines()
                    .find_map(|l| l.strip_prefix("Content-Length: "))
                    .map_or(0, |v| v.parse().unwrap());
                while raw.len() < split + 4 + length {
                    let n = socket.read(&mut buf).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    raw.extend_from_slice(&buf[..n]);
                }
                let mut line = head.lines().next().unwrap().split(' ');
                let (method, path) = (
                    line.next().unwrap().to_owned(),
                    line.next().unwrap().to_owned(),
                );
                assert!(head
                    .lines()
                    .any(|l| l == format!("Authorization: Bearer {V1_TOKEN}")));
                let body = serde_json::from_slice(&raw[split + 4..]).unwrap_or(Value::Null);
                let delay = v1.lock().unwrap().acquire_delay_ms;
                if path.ends_with("/acquire") && delay > 0 {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
                let (status, value) = handle(&mut v1.lock().unwrap(), &method, &path, &body);
                let text = value.to_string();
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                    text.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            });
        }
    });
    format!("http://{address}")
}

struct Chat {
    id: ConversationId,
    grant: String,
}
impl Chat {
    fn path(&self, rest: &str) -> String {
        format!("/api/v2/conversations/{}{rest}", self.id)
    }
    fn header(&self) -> String {
        format!("{DESKTOP_GRANT_HEADER}: {}", self.grant)
    }
}

/// A chat bound to its own V1 thread, no desk listed: all desks are shared.
async fn chat(c: &Case, name: &str, thread: &str) -> Chat {
    let id = c
        .state
        .store
        .create_conversation_authenticated(
            &c.bearer,
            &ConversationInput {
                client_request_id: format!("reservation-{name}"),
                name: name.into(),
            },
        )
        .await
        .unwrap()
        .0
        .conversation_id;
    let path = format!("/api/v2/conversations/{id}");
    let auth = c.auth();
    let bind = json!({"expected_revision": 0, "v1_thread_id": thread, "desktop_slugs": []});
    let (status, value) = send(
        &c.state,
        "PUT",
        &format!("{path}/desktop-binding"),
        &[&auth],
        &bind.to_string(),
    )
    .await;
    assert_eq!(status, 200, "{value}");
    let (status, issued) = send(
        &c.state,
        "POST",
        &format!("{path}/desktop-binding/grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 201, "{issued}");
    Chat {
        id,
        grant: issued["grant"].as_str().unwrap().to_owned(),
    }
}

async fn setup(v1: FakeV1) -> (Case, StdArc<StdMutex<FakeV1>>, Chat, Chat) {
    let mut c = case().await;
    let v1 = StdArc::new(StdMutex::new(v1));
    let url = fake_v1(v1.clone()).await;
    c.state.desktop_broker = Some(Arc::new(
        crate::desktop_broker::Broker::new(&url, V1_TOKEN.into()).unwrap(),
    ));
    let on = r#"{"expected_revision":0,"share_all_desks":true}"#;
    let (status, _) = send(&c.state, "PUT", "/api/v2/desktop-sharing", &[&c.auth()], on).await;
    assert_eq!(status, 200);
    let a = chat(&c, "chat-a", "v1-a").await;
    let b = chat(&c, "chat-b", "v1-b").await;
    (c, v1, a, b)
}

/// One tool step: acquire and, when granted, release.
async fn step(c: &Case, chat: &Chat, desk: &str) -> (u16, Value) {
    let grant = chat.header();
    let path = chat.path(&format!("/desktops/{desk}/acquire"));
    let (status, value) = send(&c.state, "POST", &path, &[&grant], ACQUIRE).await;
    if status == 201 {
        let token = value["fencing_token"].as_str().unwrap();
        let release = json!({"fencing_token": token, "reason": "hold_finished"}).to_string();
        let path = chat.path(&format!("/desktops/{desk}/release"));
        let (released, _) = send(&c.state, "POST", &path, &[&grant], &release).await;
        assert_eq!(released, 200);
    }
    (status, value)
}

async fn reservation(c: &Case, chat: &Chat, desk: &str, body: Value) -> (u16, Value) {
    let path = chat.path(&format!("/desktops/{desk}/reservation"));
    send(
        &c.state,
        "POST",
        &path,
        &[&chat.header()],
        &body.to_string(),
    )
    .await
}

async fn look(c: &Case, chat: &Chat, rest: &str) -> (u16, Value) {
    send(&c.state, "GET", &chat.path(rest), &[&chat.header()], "").await
}

fn v1_acquires(v1: &StdArc<StdMutex<FakeV1>>, desk: &str) -> usize {
    let wanted = format!("POST /api/desktops/{desk}/acquire");
    v1.lock()
        .unwrap()
        .calls
        .iter()
        .filter(|call| **call == wanted)
        .count()
}

/// The owner's browser session: cookie, same origin and CSRF token.
fn browser(c: &Case) -> Vec<String> {
    vec![
        format!("Cookie: orkestr_v2_session={}", c.cookie),
        "Origin: http://127.0.0.1:19882".into(),
        format!(
            "x-orkestr-csrf: {:x}",
            Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{}", c.cookie).as_bytes())
        ),
    ]
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// 2026-11-26, replayed with the reservations in Core. Chat A worked on pa-4
/// one lease per step and handed it to the owner for a sign-in; chat B worked
/// on pa-3. B moved to pa-4 while it was handed over, and later acted on pa-4
/// while the owner was connected through Virtual Desks. Every one of those
/// steps is now refused where any tool takes the lease, before V1 is asked.
#[tokio::test]
async fn the_pa4_collision_is_refused_at_the_acquire_for_every_tool() {
    let (c, v1, a, b) = setup(FakeV1 {
        desks: vec!["pa", "pa-3", "pa-4"],
        ..Default::default()
    })
    .await;
    // 18:40-19:31: A's steps on pa-4; B's own desk is pa-3.
    for _ in 0..3 {
        assert_eq!(step(&c, &a, "pa-4").await.0, 201);
    }
    assert_eq!(step(&c, &b, "pa-3").await.0, 201);
    // Between A's steps no other chat takes pa-4.
    let (status, refused) = step(&c, &b, "pa-4").await;
    assert_eq!(
        (status, refused["code"].as_str()),
        (409, Some("desk_busy")),
        "{refused}"
    );
    assert_eq!(
        (
            refused["holder"]["kind"].as_str(),
            refused["holder"]["chat"].as_str()
        ),
        (Some("task"), Some("chat-a"))
    );
    assert!(refused["holder"].get("conversation_id").is_none());
    assert!(!refused.to_string().contains(&a.id.to_string()));
    assert_eq!(refused["free_desks"], json!(["pa-3"]));
    let message = refused["message"].as_str().unwrap();
    assert!(
        message.contains("nothing was done") && message.ends_with("Free now: pa-3."),
        "{message}"
    );
    assert_eq!(v1_acquires(&v1, "pa-4"), 3, "refused before V1 is asked");

    // 19:20: A hands pa-4 to the owner with a sign-in link (30 minutes).
    let until = now_ms() + 30 * 60_000;
    let (status, handed) =
        reservation(&c, &a, "pa-4", json!({"op": "handoff", "until_ms": until})).await;
    assert_eq!(
        (
            status,
            handed["verdict"].as_str(),
            handed["reservation"]["until_ms"].as_i64()
        ),
        (200, Some("desk_handed_to_owner"), Some(until)),
        "{handed}"
    );
    // No chat acts on it, A neither.
    let (status, own) = step(&c, &a, "pa-4").await;
    assert_eq!(
        (status, own["code"].as_str(), own["free_desks"].clone()),
        (409, Some("desk_handed_to_owner"), json!([]))
    );
    assert!(own["message"].as_str().unwrap().contains("handback"));
    // 19:35: B, kept off pa-3 by a stale row before #658, moves to pa-4.
    let (status, refused) = step(&c, &b, "pa-4").await;
    assert_eq!(
        (
            status,
            refused["code"].as_str(),
            refused["holder"]["kind"].as_str()
        ),
        (409, Some("desk_busy"), Some("owner_handoff"))
    );
    assert!(refused["message"]
        .as_str()
        .unwrap()
        .contains("handed over by chat-a"));
    assert_eq!(refused["free_desks"], json!(["pa-3"]));
    assert_eq!(v1_acquires(&v1, "pa-4"), 3);

    // The owner is done: A hands back and goes on; B still waits.
    let (status, back) = reservation(&c, &a, "pa-4", json!({"op": "handback"})).await;
    assert_eq!(
        (
            status,
            back["verdict"].as_str(),
            back["reservation"]["kind"].as_str()
        ),
        (200, Some("allowed"), Some("task"))
    );
    assert_eq!(step(&c, &a, "pa-4").await.0, 201);
    assert_eq!(step(&c, &b, "pa-4").await.0, 409);
    // A finishes. 19:51: the owner opens pa-4 through Virtual Desks.
    assert_eq!(
        reservation(&c, &a, "pa-4", json!({"op": "unreserve"}))
            .await
            .0,
        200
    );
    let headers = browser(&c);
    let headers: Vec<&str> = headers.iter().map(String::as_str).collect();
    let (status, link) = send(
        &c.state,
        "POST",
        "/api/v2/desktops/pa-4/link",
        &headers,
        "{}",
    )
    .await;
    assert_eq!(status, 200, "{link}");
    assert!(link["viewer_until_ms"].as_i64().unwrap() > now_ms());
    // 19:51:36: steps on pa-4 while the owner is connected are refused, for
    // every chat without the desk's task, and reserving is no way around it.
    for chat in [&b, &a] {
        let (status, refused) = step(&c, chat, "pa-4").await;
        assert_eq!(
            (status, refused["holder"]["kind"].as_str()),
            (409, Some("owner_viewer"))
        );
        assert!(refused["message"]
            .as_str()
            .unwrap()
            .contains("owner is viewing pa-4"));
        let (status, refused) = reservation(&c, chat, "pa-4", json!({"op": "reserve"})).await;
        assert_eq!((status, refused["code"].as_str()), (409, Some("desk_busy")));
    }
    assert_eq!(v1_acquires(&v1, "pa-4"), 4);

    // The owner's Virtual Desks list shows holder, kind and until.
    let (status, inventory) = send(&c.state, "GET", "/api/v2/desktops", &[&c.auth()], "").await;
    assert_eq!(status, 200);
    let desk = |slug: &str| {
        inventory["resources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|desk| desk["slug"] == slug)
            .unwrap()
            .clone()
    };
    assert_eq!(desk("pa-4")["owner_viewer"]["kind"], "owner_viewer");
    assert!(desk("pa-4")["owner_viewer"]["until_ms"].as_i64().is_some());
    let task = desk("pa-3")["reservation"].clone();
    assert_eq!(
        (
            task["kind"].as_str(),
            task["chat"].as_str(),
            task["conversation_id"].as_str()
        ),
        (
            Some("task"),
            Some("chat-b"),
            Some(b.id.to_string().as_str())
        )
    );
    assert!(desk("pa")["reservation"].is_null() && desk("pa")["owner_viewer"].is_null());

    // The owner frees pa-4; a chat's grant cannot.
    let free = "/api/v2/desktops/pa-4/reservation";
    let (status, _) = send(&c.state, "DELETE", free, &[&b.header()], "").await;
    assert_eq!(status, 401);
    let (status, freed) = send(&c.state, "DELETE", free, &[&c.auth()], "").await;
    assert_eq!((status, freed["ended"].as_u64()), (200, Some(1)));
    assert_eq!(step(&c, &b, "pa-4").await.0, 201);
    c.finish().await;
}

/// A tool that started its acquire just before another chat handed the desk
/// over: V1 granted the lease while preparing the desk, V2 refuses to record
/// it and releases it at V1.
#[tokio::test]
async fn a_desk_handed_over_while_v1_prepares_it_is_released_and_refused() {
    let (c, v1, a, b) = setup(FakeV1 {
        desks: vec!["pa-3", "pa-4"],
        acquire_delay_ms: 1500,
        ..Default::default()
    })
    .await;
    let acquire = async {
        let path = b.path("/desktops/pa-4/acquire");
        send(&c.state, "POST", &path, &[&b.header()], ACQUIRE).await
    };
    let handoff = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        reservation(&c, &a, "pa-4", json!({"op": "handoff", "minutes": 5})).await
    };
    let ((status, refused), (handed, _)) = tokio::join!(acquire, handoff);
    assert_eq!(handed, 200);
    assert_eq!(
        (
            status,
            refused["code"].as_str(),
            refused["holder"]["kind"].as_str()
        ),
        (409, Some("desk_busy"), Some("owner_handoff")),
        "{refused}"
    );
    assert_eq!(v1_acquires(&v1, "pa-4"), 1);
    assert!(v1.lock().unwrap().leases.is_empty(), "released at V1");
    let (_, listed) = send(&c.state, "GET", &b.path("/desktops"), &[&b.header()], "").await;
    assert!(listed["leases"].as_array().unwrap().is_empty(), "{listed}");
    c.finish().await;
}

#[tokio::test]
async fn a_chat_changes_only_its_own_reservation_and_sees_other_chats_by_name() {
    let (c, _v1, a, b) = setup(FakeV1 {
        desks: vec!["pa-3", "pa-4", "spare"],
        ..Default::default()
    })
    .await;
    let (status, reserved) =
        reservation(&c, &a, "pa-4", json!({"op": "reserve", "minutes": 45})).await;
    assert_eq!(
        (
            status,
            reserved["reservation"]["kind"].as_str(),
            reserved["reservation"]["mine"].as_bool()
        ),
        (200, Some("task"), Some(true)),
        "{reserved}"
    );
    let (status, seen) = look(&c, &b, "/desktops/pa-4/reservation?candidates=spare,pa-4").await;
    assert_eq!(
        (
            status,
            seen["verdict"].as_str(),
            seen["holder"]["chat"].as_str()
        ),
        (200, Some("desk_busy"), Some("chat-a"))
    );
    assert_eq!(seen["holder"]["mine"].as_bool(), Some(false));
    assert!(seen["holder"].get("conversation_id").is_none());
    assert_eq!(seen["free_desks"], json!(["spare"]));
    let (status, mine) = look(&c, &a, "/desktops/pa-4/reservation").await;
    assert_eq!(
        (status, mine["verdict"].as_str(), mine["free_desks"].clone()),
        (200, Some("allowed"), json!([]))
    );
    let (status, list) = look(&c, &b, "/desktop-reservations").await;
    assert_eq!(status, 200);
    assert_eq!(list["reservations"].as_array().unwrap().len(), 1);
    assert_eq!(list["reservations"][0]["chat"], "chat-a");
    assert!(!list.to_string().contains(&a.id.to_string()));
    // Another chat's claim is not B's to end; bad input is refused.
    let (status, value) = reservation(&c, &b, "pa-4", json!({"op": "unreserve"})).await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("reservation_of_another_chat"))
    );
    for body in [
        json!({"op": "reserve", "minutes": 121}),
        json!({"op": "steal"}),
        json!({"op": "reserve", "until_ms": 1}),
    ] {
        assert_eq!(reservation(&c, &a, "pa-4", body).await.0, 400);
    }
    assert_eq!(
        look(&c, &b, "/desktops/pa-4/reservation?candidates=../x")
            .await
            .0,
        400
    );
    // A grant never comes with owner credentials.
    let path = b.path("/desktops/pa-4/reservation");
    let (status, _) = send(&c.state, "GET", &path, &[&b.header(), &c.auth()], "").await;
    assert_eq!(status, 401);
    c.finish().await;
}
