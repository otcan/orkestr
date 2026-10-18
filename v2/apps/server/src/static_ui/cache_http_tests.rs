//! Real HTTP through the complete router, with a listener owned throughout.
use super::*;
use crate::{router, AppState};
use orkestr_v2_store_sqlite::Store;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

struct Directory(std::path::PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct HttpResult {
    code: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
fn request(address: SocketAddr, method: &str, path: &str, tag: Option<&str>) -> HttpResult {
    let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(5)).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    socket
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut input = format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n");
    if let Some(tag) = tag {
        input.push_str(&format!("If-None-Match: {tag}\r\n"));
    }
    input.push_str("\r\n");
    socket.write_all(input.as_bytes()).unwrap();
    let mut output = Vec::new();
    socket.take(65_536).read_to_end(&mut output).unwrap();
    let boundary = output
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .unwrap();
    let head = std::str::from_utf8(&output[..boundary]).unwrap();
    let mut lines = head.split("\r\n");
    let code = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_ascii_lowercase(), value.trim().to_owned())
        })
        .collect();
    HttpResult {
        code,
        headers,
        body: output[boundary + 4..].to_vec(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_router_revalidates_public_assets_and_keeps_api_uncacheable() {
    let root =
        Directory(std::env::temp_dir().join(format!("v2-static-cache-{}", uuid::Uuid::new_v4())));
    let dist = root.0.join("dist");
    fs::create_dir_all(&dist).unwrap();
    fs::write(dist.join("index.html"), b"<html>public UI</html>").unwrap();
    let wasm = b"\0asm\x01\0\0\0";
    fs::write(dist.join("app.wasm"), wasm).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state = AppState::new(
        Store::open(&root.0.join("core.sqlite3")).await.unwrap(),
        "synthetic-bootstrap-for-static-cache-tests".into(),
        format!("http://{address}"),
    )
    .unwrap();
    let app = with_static_ui(router(state), &dist).unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let result = tokio::task::spawn_blocking(move || {
        let first = request(address, "GET", "/app.wasm", None);
        assert_eq!(first.code, 200);
        assert_eq!(first.body, wasm);
        assert_eq!(first.headers["cache-control"], cache::POLICY);
        assert_eq!(first.headers["content-type"], "application/wasm");
        let tag = &first.headers["etag"];
        for method in ["GET", "HEAD"] {
            let cached = request(address, method, "/app.wasm", Some(tag));
            assert_eq!(cached.code, 304);
            assert!(cached.body.is_empty());
            assert_eq!(cached.headers["etag"], *tag);
            assert_eq!(cached.headers["cache-control"], cache::POLICY);
            // RFC9110 permits omission on304. If the HTTP stack preserves it
            // (notably HEAD), it must name the full representation size.
            if let Some(length) = cached.headers.get("content-length") {
                assert_eq!(*length, wasm.len().to_string());
            }
        }
        let weak = request(address, "GET", "/app.wasm", Some(&format!("W/{tag}")));
        assert_eq!(weak.code, 304);
        let changed = request(address, "GET", "/app.wasm", Some("\"old-content\""));
        assert_eq!(changed.code, 200);
        assert_eq!(changed.body, wasm);
        let private = request(address, "GET", "/api/v2/resources", Some("*"));
        assert_eq!(private.code, 401);
        assert_eq!(private.headers["cache-control"], "no-store");
        assert!(!private.headers.contains_key("etag"));
        assert_eq!(
            request(address, "GET", "/missing.wasm", Some("*")).code,
            404
        );
        assert_eq!(request(address, "POST", "/app.wasm", Some("*")).code, 405);
        let index = request(address, "GET", "/", None);
        assert_eq!(index.code, 200);
        assert_eq!(index.headers["cache-control"], cache::POLICY);
    })
    .await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    result.unwrap();
}

#[tokio::test]
async fn new_snapshot_changes_validator_and_unchanged_returns_no_bytes() {
    let mut assets = Assets::new();
    assets.insert(
        "/app.js".into(),
        Asset::new("text/javascript", Bytes::from_static(b"version one")),
    );
    let old_tag = assets["/app.js"].etag.clone();
    let mut headers = HeaderMap::new();
    headers.insert(header::IF_NONE_MATCH, old_tag.clone());
    let cached = respond(Method::GET, "/app.js".parse().unwrap(), &headers, &assets);
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
    assert!(axum::body::to_bytes(cached.into_body(), 32)
        .await
        .unwrap()
        .is_empty());
    assets.insert(
        "/app.js".into(),
        Asset::new("text/javascript", Bytes::from_static(b"version two")),
    );
    let new = respond(Method::GET, "/app.js".parse().unwrap(), &headers, &assets);
    assert_eq!(new.status(), StatusCode::OK);
    assert_ne!(new.headers()[header::ETAG], old_tag);
    assert_eq!(
        axum::body::to_bytes(new.into_body(), 32).await.unwrap(),
        "version two"
    );
}
