use super::*;
use orkestr_v2_store_sqlite::history_import::timers::{TimerImportRequest, TimerSchedule};
use sha2::Digest;
use std::io::{Read, Write};
const NOW: i64 = 1_767_225_600_000;
async fn request(
    address: std::net::SocketAddr,
    method: &str,
    path: &str,
    token: &str,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    request_headers(
        address,
        method,
        path,
        format!("Authorization: Bearer {token}\r\n"),
        body,
    )
    .await
}
async fn request_headers(
    address: std::net::SocketAddr,
    method: &str,
    path: &str,
    extra: String,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    let body = body.to_string();
    let method = method.to_owned();
    let path = path.to_owned();

    tokio::task::spawn_blocking(move || {
        let mut socket=std::net::TcpStream::connect_timeout(&address,std::time::Duration::from_secs(5)).unwrap();
        socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        socket.set_write_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let request=format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
        socket.write_all(request.as_bytes()).unwrap();
        let mut response=String::new();socket.read_to_string(&mut response).unwrap();
        let (headers,body)=response.split_once("\r\n\r\n").unwrap();
        (headers.split_whitespace().nth(1).unwrap().parse().unwrap(),serde_json::from_str(body).unwrap())
    }).await.unwrap()
}
#[tokio::test]
async fn timer_loopback_enable_due_input_disable_held_and_refusals() {
    let directory = std::env::temp_dir().join(format!("timer-http-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let database = directory.join("store.sqlite3");
    let store = Store::open(&database).await.unwrap();
    let conversation = store
        .setup("synthetic-http-owner", "synthetic-password-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-http-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = "a1".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let namespace = Uuid::new_v4();
    store
        .import_dormant_timer(
            &token,
            &owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "synthetic-http".into(),
                source_timer_id: "fake-timer".into(),
                source_enabled: true,
                schedule: TimerSchedule::Interval { every_ms: 60_000 },
            },
        )
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();

    let controller = DurableOwnerController::new(store.clone());
    controller
        .ready
        .store(true, std::sync::atomic::Ordering::Release);
    let bound = store
        .authorize_supervisor(
            &token,
            orkestr_v2_application::runtime::ProductionSupervisorConfig {
                provider: orkestr_v2_application::runtime::ProviderKind::Codex,
                namespace: "synthetic-http-scheduler".into(),
                supervisor_key: "synthetic".into(),
                takeover: orkestr_v2_application::runtime::ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let mut scheduler = durable::DurableTimerController::new(bound);
    let mut state =
        AppState::new(store.clone(), "b".repeat(32), format!("http://{address}")).unwrap();
    state.timers = controller.clone();
    // Actual mounted router: the timer routes share the ordinary auth guards.
    let router = crate::router(state);
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let path = format!("/api/v2/timers/{namespace}");
    let (status, read) = request(address, "GET", &path, &token, serde_json::Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(read["state"], "paused");
    assert_eq!(read["controller_armed"], false);
    let enable = serde_json::json!({"expected_revision":1,"request_key":"synthetic-enable","conversation_id":conversation,"text":"Synthetic fresh owner work"});
    let mut injected = enable.clone();
    injected["now_ms"] = NOW.into();
    assert_eq!(
        request(address, "POST", &format!("{path}/enable"), &token, injected)
            .await
            .0,
        400
    );
    let browser_token = "c2".repeat(32);
    store
        .save_session(&format!("browser:{browser_token}"), &owner)
        .await
        .unwrap();
    let cookie = format!("Cookie: orkestr_v2_session={browser_token}\r\n");
    let origin = format!("Origin: http://{address}\r\n");
    let csrf = format!(
        "{:x}",
        sha2::Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{browser_token}").as_bytes())
    );
    let browser_headers = format!("{cookie}{origin}x-orkestr-csrf: {csrf}\r\n");
    assert_eq!(
        request_headers(
            address,
            "GET",
            &path,
            cookie.clone(),
            serde_json::Value::Null
        )
        .await
        .0,
        200
    );
    assert_eq!(
        request_headers(
            address,
            "POST",
            &format!("{path}/enable"),
            format!("{cookie}{origin}"),
            enable.clone()
        )
        .await
        .0,
        403
    );
    assert_eq!(
        request_headers(
            address,
            "POST",
            &format!("{path}/enable"),
            format!("{cookie}{origin}x-orkestr-csrf: wrong\r\n"),
            enable.clone()
        )
        .await
        .0,
        403
    );
    assert_eq!(
        request_headers(
            address,
            "POST",
            &format!("{path}/enable"),
            format!("{cookie}Origin: http://fake.invalid\r\nx-orkestr-csrf: {csrf}\r\n"),
            enable.clone()
        )
        .await
        .0,
        403
    );
    assert_eq!(
        request_headers(
            address,
            "GET",
            &path,
            format!("{cookie}Authorization: Bearer {token}\r\n"),
            serde_json::Value::Null
        )
        .await
        .0,
        401
    );
    assert_eq!(
        request_headers(
            address,
            "POST",
            &format!("{path}/enable"),
            browser_headers,
            enable.clone()
        )
        .await
        .0,
        200
    );
    let (status, enabled) = request(
        address,
        "POST",
        &format!("{path}/enable"),
        &token,
        enable.clone(),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(enabled["controller_armed"], true);
    assert_eq!(
        request(
            address,
            "POST",
            &format!("{path}/enable"),
            &token,
            enable.clone()
        )
        .await
        .1,
        enabled
    );
    let mut changed = enable;
    changed["text"] = "Different fresh text".into();
    assert_eq!(
        request(address, "POST", &format!("{path}/enable"), &token, changed)
            .await
            .0,
        409
    );
    assert_eq!(scheduler.tick().await.unwrap().admitted, 0);
    // Natural due admission is exercised separately; this long-due route stays inert.
    assert_eq!(scheduler.tick().await.unwrap().admitted, 0);
    let control = serde_json::json!({"expected_revision":enabled["revision"],"request_key":"synthetic-disable","action":"disable"});
    let (status, disabled) =
        request(address, "POST", &format!("{path}/control"), &token, control).await;
    assert_eq!(status, 200);
    assert_eq!(disabled["controller_armed"], false);
    // Read-only synthetic DB oracle checks route-created native input is held.
    let result=std::process::Command::new("python3").arg("-c").arg("import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); assert c.execute('select count(*) from durable_timer_authorities').fetchone()==(1,); assert c.execute('select count(*) from messages').fetchone()==(0,)").arg(&database).status().unwrap();
    assert!(result.success());

    assert_eq!(scheduler.tick().await.unwrap().admitted, 0);
    store
        .revoke_session(&format!("browser:{browser_token}"))
        .await
        .unwrap();
    assert_eq!(
        request_headers(address, "GET", &path, cookie, serde_json::Value::Null)
            .await
            .0,
        401
    );
    store.revoke_session(&token).await.unwrap();
    assert_eq!(
        request(address, "GET", &path, &token, serde_json::Value::Null)
            .await
            .0,
        401
    );
    server.abort();
    let _ = server.await;
    drop(controller);
    store.close().await;
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn timer_dtos_refuse_duplicate_fields_and_claim_authority() {
    assert!(serde_json::from_str::<dto::Control>(
        r#"{"expected_revision":1,"request_key":"a","action":"disable","action":"stop"}"#
    )
    .is_err());
    assert!(serde_json::from_str::<dto::Control>(
        r#"{"expected_revision":1,"request_key":"a","action":"disable","generation":1}"#
    )
    .is_err());
    assert!(serde_json::from_str::<dto::Read>(r#"{"due_ms":0}"#).is_err());
}
