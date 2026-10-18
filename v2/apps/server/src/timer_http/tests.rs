use super::*;
use orkestr_v2_store_sqlite::history_import::timers::{TimerImportRequest, TimerSchedule};
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc,
};
const NOW: i64 = 1_767_225_600_000;
struct FakeClock(AtomicI64);
impl Clock for FakeClock {
    fn now_ms(&self) -> Result<i64, HistoryError> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}
async fn request(
    address: std::net::SocketAddr,
    method: &str,
    path: &str,
    token: &str,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    let body = body.to_string();
    let method = method.to_owned();
    let path = path.to_owned();
    let token = token.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut socket=std::net::TcpStream::connect_timeout(&address,std::time::Duration::from_secs(5)).unwrap();
        socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        socket.set_write_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let request=format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
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
    let clock = Arc::new(FakeClock(AtomicI64::new(NOW)));
    let controller = TimerController::with_clock(store.clone(), clock.clone());
    let state = AppState::new(store.clone(), "b".repeat(32), format!("http://{address}")).unwrap();
    // Exact leaf plus existing guards/auth, without editing shared registration.
    let router = routes(controller.clone())
        .layer(axum::extract::DefaultBodyLimit::max(40 * 1024))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::guard,
        ))
        .with_state(state);
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
    assert_eq!(controller.tick().await.unwrap(), 0);
    clock.0.store(NOW + 60_000, Ordering::SeqCst);
    assert_eq!(controller.tick().await.unwrap(), 1);
    assert_eq!(controller.tick().await.unwrap(), 0);
    let control = serde_json::json!({"expected_revision":enabled["revision"],"request_key":"synthetic-disable","action":"disable"});
    let (status, disabled) =
        request(address, "POST", &format!("{path}/control"), &token, control).await;
    assert_eq!(status, 200);
    assert_eq!(disabled["controller_armed"], false);
    // Read-only synthetic DB oracle checks route-created native input is held.
    let result=std::process::Command::new("python3").arg("-c").arg("import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); assert c.execute('select count(*) from dormant_timer_inputs').fetchone()==(1,); assert c.execute('select count(*) from ordinary_input_holds').fetchone()==(1,); assert c.execute('select count(*) from messages').fetchone()==(1,)").arg(&database).status().unwrap();
    assert!(result.success());
    clock.0.store(NOW + 120_000, Ordering::SeqCst);
    assert_eq!(controller.tick().await.unwrap(), 0);
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
