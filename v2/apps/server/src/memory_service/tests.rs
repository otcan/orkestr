use super::*;
use orkestr_v2_contracts::MemoryReceipt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
async fn request(method: &str, path: &str, body: Value, headers: &str) -> (u16, String, Value) {
    let (method, path, headers) = (method.to_owned(), path.to_owned(), headers.to_owned());
    tokio::task::spawn_blocking(move|| {
  let text=body.to_string(); let mut stream=std::net::TcpStream::connect("127.0.0.1:47389").unwrap();
  stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
  write!(stream,"{method} /api/v2/memory/{path} HTTP/1.1\r\nHost: memory.test\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}\r\n{text}",text.len()).unwrap();
  let mut text=String::new();stream.read_to_string(&mut text).unwrap();
  let(h,b)=text.split_once("\r\n\r\n").unwrap();assert!(h.to_lowercase().contains("cache-control: no-store"));
  (h.split_whitespace().nth(1).unwrap().parse().unwrap(),h.into(),serde_json::from_str(b).unwrap_or(Value::Null))
 }).await.unwrap()
}
#[tokio::test]
async fn ordinary_http_consent_auth_and_bounds() {
    let dir = std::env::temp_dir().join(format!("memory-http-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let store = orkestr_v2_store_sqlite::Store::open(&dir.join("core.sqlite3"))
        .await
        .unwrap();
    store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = "ab".repeat(32);
    let credential = format!("browser:{token}");
    store.save_session(&credential, &owner).await.unwrap();
    let csrf = format!(
        "{:x}",
        Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{token}").as_bytes())
    );
    let auth=format!("Cookie: orkestr_v2_session={token}\r\nOrigin: http://memory.test\r\nX-Orkestr-Csrf: {csrf}\r\n");
    let state = crate::AppState::new(
        store.clone(),
        "synthetic-bootstrap-only".repeat(3),
        "http://memory.test".into(),
    )
    .unwrap();
    // Fixed disposable test lane port; collisions refuse, no foreign health probe.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:47389")
        .await
        .expect("test lane port unavailable");
    let server = tokio::spawn(async move {
        axum::serve(listener, router(state.clone()).with_state(state))
            .await
            .unwrap()
    });
    assert_eq!(
        request("GET", "settings", Value::Null, &auth).await.2,
        json!({"owner_id":owner,"enabled":false})
    );
    for h in [
        String::new(),
        format!("Authorization: Bearer {token}\r\n"),
        format!("{auth}Cookie: orkestr_v2_session={token}\r\n"),
    ] {
        assert_eq!(request("GET", "settings", Value::Null, &h).await.0, 401);
    }
    assert_eq!(
        request(
            "PUT",
            "settings",
            json!({"enabled":true}),
            &auth.replace("http://memory.test", "http://foreign.test")
        )
        .await
        .0,
        403
    );
    assert_eq!(
        request(
            "PUT",
            "settings",
            json!({"enabled":true}),
            &format!("Cookie: orkestr_v2_session={token}\r\nOrigin: http://memory.test\r\n")
        )
        .await
        .0,
        403
    );
    assert_eq!(
        request(
            "PUT",
            "settings",
            json!({"enabled":true,"owner_id":owner}),
            &auth
        )
        .await
        .0,
        400
    );
    let query = json!({"project_id":null,"query":"","limit":100});
    assert_eq!(
        request("POST", "query", query.clone(), &auth).await.2["code"],
        "memory_disabled"
    );
    assert_eq!(
        request("PUT", "settings", json!({"enabled":true}), &auth)
            .await
            .0,
        204
    );
    let operation = json!({"operation":"create","candidate":{"scope":{"kind":"owner"},"content":{"category":"fact","statement":"synthetic remembered fact"},"source":{"kind":"owner","actor_id":owner,"origin":"explicit-owner-control","captured_at_ms":1700000000000_i64,"task_id":null,"event_id":null,"cursor":null}}});
    let (s, _, p) = request(
        "POST",
        "proposals",
        json!({"request_key":"create-synthetic","operation":operation}),
        &auth,
    )
    .await;
    assert_eq!(s, 200);
    let decision = json!({"proposal":p,"decision":{"action":"remember","digest":p["digest"]}});
    let (s, _, r) = request("POST", "decisions", decision.clone(), &auth).await;
    assert_eq!(s, 200);
    assert_eq!(
        request("POST", "decisions", decision.clone(), &auth)
            .await
            .2,
        r
    );
    let mut changed = decision.clone();
    changed["proposal"]["request_key"] = json!("changed");
    assert_eq!(request("POST", "decisions", changed, &auth).await.0, 400);
    assert_eq!(
        request("POST", "query", query.clone(), &auth).await.2["records"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let (s, h, b) = request("GET", "export", Value::Null, &auth).await;
    assert_eq!(s, 200);
    assert!(h
        .to_lowercase()
        .contains("content-disposition: attachment;"));
    assert_eq!(b["records"].as_array().unwrap().len(), 1);
    for q in [
        json!({"project_id":null,"query":"a".repeat(257),"limit":1}),
        json!({"project_id":null,"query":"","limit":101}),
    ] {
        assert_eq!(request("POST", "query", q, &auth).await.0, 400);
    }
    assert_eq!(
        request("GET", "settings?owner_id=foreign", Value::Null, &auth)
            .await
            .0,
        400
    );
    assert_eq!(
        request(
            "POST",
            "proposals",
            json!({"request_key":"x".repeat(65536),"operation":operation}),
            &auth
        )
        .await
        .0,
        413
    );
    let forget =
        json!({"operation":"forget","memory_id":r["memory_id"],"expected_revision":r["revision"]});
    let (s, _, fp) = request(
        "POST",
        "proposals",
        json!({"request_key":"forget-synthetic","operation":forget}),
        &auth,
    )
    .await;
    assert_eq!(s, 200);
    let fd = json!({"proposal":fp,"decision":{"action":"forget","digest":fp["digest"]}});
    assert_eq!(request("POST", "decisions", fd, &auth).await.0, 200);
    // Receipt replay is historical, never resurrection after explicit forget.
    assert_eq!(
        request("POST", "decisions", decision.clone(), &auth)
            .await
            .2,
        r
    );
    assert_eq!(
        request("POST", "query", query.clone(), &auth).await.2["records"],
        json!([])
    );
    request("PUT", "settings", json!({"enabled":false}), &auth).await;
    assert_eq!(
        request("POST", "decisions", decision.clone(), &auth)
            .await
            .2["code"],
        "memory_disabled"
    );
    store.revoke_session(&credential).await.unwrap();
    assert_eq!(request("POST", "decisions", decision, &auth).await.0, 401);
    server.abort();
    let _ = server.await;
    store.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn exact_integer_and_response_limits() {
    let receipt = MemoryReceipt {
        memory_id: uuid::Uuid::new_v4(),
        revision: 9007199254740993,
        forgotten: false,
    };
    let text = serde_json::to_string(&receipt).unwrap();
    assert!(text.contains("9007199254740993"));
    assert_eq!(
        serde_json::from_str::<MemoryReceipt>(&text).unwrap(),
        receipt
    );
    for limit in [wire::QUERY_MAX, wire::EXPORT_MAX] {
        assert!(wire::response(&"x".repeat(limit - 2), limit).is_ok());
        let error = wire::response(&"x".repeat(limit - 1), limit).unwrap_err();
        assert_eq!(error.0, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error.1, "memory_limit");
    }
}
