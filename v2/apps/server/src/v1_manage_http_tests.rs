use super::*;
use crate::conversation_resources_http::tests::{case, send};
use std::sync::{Arc as StdArc, Mutex as StdMutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const V1_TOKEN: &str = "gggggggggggggggggggggggg";

#[derive(Default)]
struct V1 {
    calls: Vec<(String, String, Value)>,
    timers: Vec<Value>,
    binding: Value,
    model: (String, String),
}
type Shared = StdArc<StdMutex<V1>>;

fn group(id: &str, delegated: bool) -> Value {
    let mut binding = json!({"connector": "whatsapp", "enabled": true, "chatId": "000@g.us"});
    if delegated {
        binding["remoteThreadId"] = json!("00000000-0000-4000-8000-000000000009");
    }
    json!({"id": id, "name": id, "lastActivityAt": "2026-01-01T00:00:00Z", "binding": binding})
}

fn answer(v1: &Shared, method: &str, path: &str, body: &Value) -> (u16, Value) {
    let mut v1 = v1.lock().unwrap();
    v1.calls.push((method.into(), path.into(), body.clone()));
    let path_only = path.split('?').next().unwrap_or_default();
    match (method, path_only) {
        ("GET", "/api/threads/summary") => (
            200,
            json!({"threads": [group("synthetic-group", false), group("synthetic-delegated", true)]}),
        ),
        ("GET", "/api/threads/synthetic-group/model-settings") => (
            200,
            json!({
            "models": [{"id": "synthetic-model", "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "high"}], "defaultReasoningEffort": "low"}],
            "readOnly": false, "readOnlyReason": "", "model": v1.model.0, "effort": v1.model.1}),
        ),
        ("POST", "/api/threads/synthetic-group/model-settings") => {
            v1.model = (
                body["model"].as_str().unwrap().into(),
                body["effort"].as_str().unwrap().into(),
            );
            (200, json!({"ok": true}))
        }
        ("GET", "/api/threads/synthetic-group/timers") => {
            let timers: Vec<Value> = v1
                .timers
                .iter()
                .filter(|t| t["target"] == "synthetic-group")
                .cloned()
                .collect();
            (200, json!({"thread": {}, "timers": timers}))
        }
        ("POST", "/api/threads/synthetic-group/timers") => {
            let id = format!("timer-{}", v1.timers.len() + 1);
            let mut timer = body.clone();
            timer["id"] = json!(id);
            timer["target"] = json!("synthetic-group");
            timer["enabled"] = json!(true);
            v1.timers.push(timer.clone());
            (200, json!({"timer": timer}))
        }
        ("GET", "/api/threads/synthetic-group") => (
            200,
            json!({"thread": {"id": "synthetic-group", "binding": v1.binding}}),
        ),
        ("PUT", "/api/threads/synthetic-group/binding") => {
            for (k, v) in body.as_object().unwrap() {
                v1.binding[k] = v.clone();
            }
            (200, json!({"ok": true}))
        }
        ("GET", "/api/threads/synthetic-group/desktop-grants") => (
            200,
            json!({"grants": [{"desktopSlug": "synthetic-desk", "permissions": ["discover", "acquire"]}]}),
        ),
        ("GET", "/api/desktops/leases") => (
            200,
            json!({"desktopLeases": [
            {"desktopSlug": "synthetic-desk", "threadId": "synthetic-group", "active": true, "expiresAt": "2026-01-01T00:10:00Z", "fencingToken": "secret-fencing-token"},
            {"desktopSlug": "other-desk", "threadId": "someone-else", "active": true, "fencingToken": "other-secret"}]}),
        ),
        _ => {
            // Timer item routes: PATCH, DELETE, pause/resume.
            let rest = path_only
                .strip_prefix("/api/threads/synthetic-group/timers/")
                .unwrap_or_default();
            let (id, action) = rest.split_once('/').unwrap_or((rest, ""));
            let Some(index) = v1.timers.iter().position(|t| t["id"] == id) else {
                return (404, json!({"error": "timer_not_found"}));
            };
            match (method, action) {
                ("PATCH", "") => {
                    for (k, v) in body.as_object().unwrap() {
                        v1.timers[index][k] = v.clone();
                    }
                    (200, json!({"timer": v1.timers[index]}))
                }
                ("POST", "pause") => {
                    v1.timers[index]["enabled"] = json!(false);
                    (200, json!({"timer": v1.timers[index]}))
                }
                ("POST", "resume") => {
                    v1.timers[index]["enabled"] = json!(true);
                    (200, json!({"timer": v1.timers[index]}))
                }
                ("DELETE", "") => {
                    v1.timers.remove(index);
                    (200, json!({"ok": true}))
                }
                _ => (404, json!({})),
            }
        }
    }
}

async fn serve(v1: Shared) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut raw = Vec::new();
            let mut buf = [0u8; 8192];
            let split = loop {
                if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break at;
                }
                let n = socket.read(&mut buf).await.unwrap();
                if n == 0 {
                    break raw.len();
                }
                raw.extend_from_slice(&buf[..n]);
            };
            let head = String::from_utf8_lossy(&raw[..split]).to_string();
            let length: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("Content-Length: "))
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
            let mut body = raw.get(split + 4..).unwrap_or_default().to_vec();
            while body.len() < length {
                let n = socket.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&buf[..n]);
            }
            let method = head.split(' ').next().unwrap_or_default().to_owned();
            let path = head.split(' ').nth(1).unwrap_or_default().to_owned();
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let (status, value) = if head
                .lines()
                .any(|l| l == format!("Authorization: Bearer {V1_TOKEN}"))
            {
                answer(&v1, &method, &path, &body)
            } else {
                (401, json!({}))
            };
            let text = value.to_string();
            let response = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    format!("http://{address}")
}

#[tokio::test]
async fn v1_chats_are_managed_through_v1_with_ownership_checks() {
    let mut case = case().await;
    let auth = case.auth();
    let v1: Shared = Default::default();
    {
        let mut v = v1.lock().unwrap();
        v.model = ("synthetic-model".into(), "low".into());
        v.binding = json!({"connector": "whatsapp", "enabled": true, "chatId": "000@g.us", "replyPrefix": "synthetic:",
            "additionalParticipantsEnabled": false, "additionalParticipantIds": [], "ownerContactIds": ["10000000009@c.us"]});
        v.timers.push(json!({"id": "foreign-timer", "target": "someone-else", "label": "Not ours", "enabled": true}));
        v.timers.push(json!({"id": "v2-timer", "target": "synthetic-group", "label": "Run by V2", "ownedBy": "v2", "enabled": false}));
    }
    let url = serve(v1.clone()).await;
    case.state.desktop_broker = Some(Arc::new(
        desktop_broker::Broker::new(&url, V1_TOKEN.into()).unwrap(),
    ));
    let base = "/api/v2/v1-threads/synthetic-group";

    // Model and effort.
    let (status, value) = send(
        &case.state,
        "GET",
        &format!("{base}/settings"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 200, "{value}");
    let settings: V1ThreadSettings = serde_json::from_value(value).unwrap();
    assert_eq!(settings.models[0].efforts, vec!["low", "high"]);
    let (status, value) = send(
        &case.state,
        "PUT",
        &format!("{base}/settings"),
        &[&auth],
        r#"{"model":"synthetic-model","effort":"high"}"#,
    )
    .await;
    assert_eq!((status, value["effort"].as_str()), (200, Some("high")));

    // Timers: create (idempotent), edit, pause, resume, delete.
    let create = json!({"client_request_id": "00000000-0000-4000-8000-000000000001", "label": "Synthetic brief",
        "cadence": "daily", "time": "07:30", "timezone": "Europe/Berlin", "prompt": "Synthetic prompt"}).to_string();
    let (status, created) = send(
        &case.state,
        "POST",
        &format!("{base}/timers"),
        &[&auth],
        &create,
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let (status, again) = send(
        &case.state,
        "POST",
        &format!("{base}/timers"),
        &[&auth],
        &create,
    )
    .await;
    assert_eq!(
        (status, again["id"].clone()),
        (200, created["id"].clone()),
        "a retry never creates a second timer"
    );
    let id = created["id"].as_str().unwrap().to_owned();
    let (status, list) = send(&case.state, "GET", &format!("{base}/timers"), &[&auth], "").await;
    assert_eq!(status, 200);
    let list: V1TimerList = serde_json::from_value(list).unwrap();
    assert_eq!(list.timers.len(), 2, "only this thread's timers");
    assert!(list.timers.iter().any(|t| t.owned_by_v2));
    let mut edit: Value = serde_json::from_str(&create).unwrap();
    edit["time"] = json!("08:00");
    let (status, edited) = send(
        &case.state,
        "PATCH",
        &format!("{base}/timers/{id}"),
        &[&auth],
        &edit.to_string(),
    )
    .await;
    assert_eq!((status, edited["time"].as_str()), (200, Some("08:00")));
    let (status, paused) = send(
        &case.state,
        "POST",
        &format!("{base}/timers/{id}/pause"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!((status, paused["enabled"].as_bool()), (200, Some(false)));
    let (status, resumed) = send(
        &case.state,
        "POST",
        &format!("{base}/timers/{id}/resume"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!((status, resumed["enabled"].as_bool()), (200, Some(true)));
    // Another thread's timer and V2-run timers are refused here.
    let (status, _) = send(
        &case.state,
        "DELETE",
        &format!("{base}/timers/foreign-timer"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 404);
    let (status, refused) = send(
        &case.state,
        "POST",
        &format!("{base}/timers/v2-timer/pause"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(
        (status, refused["code"].as_str()),
        (409, Some("timer_owned_by_v2"))
    );
    let (status, _) = send(
        &case.state,
        "POST",
        &format!("{base}/timers/{id}/explode"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 400);
    let (status, _) = send(
        &case.state,
        "DELETE",
        &format!("{base}/timers/{id}"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 204);
    assert!(v1
        .lock()
        .unwrap()
        .timers
        .iter()
        .any(|t| t["id"] == "foreign-timer"));

    // WhatsApp options: only the owner-managed fields are sent.
    let (status, options) = send(
        &case.state,
        "GET",
        &format!("{base}/whatsapp"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(
        (status, options["reply_prefix"].as_str()),
        (200, Some("synthetic:"))
    );
    let update = json!({"reply_prefix": "synthetic-new:", "suppress_updates": true, "suppress_debug_footer": false,
        "additional_participants_enabled": true, "additional_participant_ids": ["10000000001@c.us"]});
    let (status, options) = send(
        &case.state,
        "PUT",
        &format!("{base}/whatsapp"),
        &[&auth],
        &update.to_string(),
    )
    .await;
    assert_eq!(status, 200, "{options}");
    assert_eq!(
        options["additional_participant_ids"],
        json!(["10000000001@c.us"])
    );
    let sent = v1
        .lock()
        .unwrap()
        .calls
        .iter()
        .rev()
        .find(|(m, p, _)| m == "PUT" && p.ends_with("/binding"))
        .unwrap()
        .2
        .clone();
    assert_eq!(
        sent.as_object().unwrap().len(),
        5,
        "no accounts, chat, contacts or remote fields"
    );
    assert_eq!(
        v1.lock().unwrap().binding["ownerContactIds"],
        json!(["10000000009@c.us"])
    );
    let bad = json!({"reply_prefix": null, "suppress_updates": false, "suppress_debug_footer": false,
        "additional_participants_enabled": true, "additional_participant_ids": ["not-a-number"]});
    let (status, _) = send(
        &case.state,
        "PUT",
        &format!("{base}/whatsapp"),
        &[&auth],
        &bad.to_string(),
    )
    .await;
    assert_eq!(status, 400);

    // Desktops: grants and this thread's leases, never fencing tokens.
    let (status, desktops) = send(
        &case.state,
        "GET",
        &format!("{base}/desktops"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 200);
    assert!(!desktops.to_string().contains("secret"));
    let desktops: V1Desktops = serde_json::from_value(desktops).unwrap();
    assert_eq!((desktops.grants.len(), desktops.leases.len()), (1, 1));

    // A delegated thread is read-only here; unlisted threads are not found.
    let delegated = "/api/v2/v1-threads/synthetic-delegated";
    let (status, refused) = send(
        &case.state,
        "PUT",
        &format!("{delegated}/settings"),
        &[&auth],
        r#"{"model":"m","effort":"low"}"#,
    )
    .await;
    assert_eq!(
        (status, refused["code"].as_str()),
        (409, Some("v1_thread_delegated"))
    );
    let (status, _) = send(
        &case.state,
        "POST",
        &format!("{delegated}/timers"),
        &[&auth],
        &create,
    )
    .await;
    assert_eq!(status, 409);
    let (status, _) = send(
        &case.state,
        "GET",
        "/api/v2/v1-threads/unlisted/timers",
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 404);
    let (status, _) = send(&case.state, "GET", &format!("{base}/timers"), &[], "").await;
    assert_eq!(status, 401);
    case.finish().await;
}
