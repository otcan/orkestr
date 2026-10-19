#![cfg(target_os = "linux")]
//! Actual Store/Axum synthetic tests. No production paths, providers or auth imports.
use super::*;
use orkestr_v2_store_sqlite::Store;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::SocketAddr,
    sync::Arc,
};
use tokio::sync::Notify;
use uuid::Uuid;
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Stage {
    BeforeRead,
    BeforeDelivery,
}
pub(super) struct Pause {
    stage: Stage,
    entered: Notify,
    resume: Notify,
}
pub(super) async fn pause(catalog: &RegistryCatalog, stage: Stage) {
    if let Some(pause) = &catalog.pause {
        if pause.stage == stage {
            pause.entered.notify_one();
            pause.resume.notified().await;
        }
    }
}
struct Fixture {
    root: PathBuf,
    store: Store,
    owner: OwnerId,
    other: OwnerId,
    other_store: Store,
    catalog: RegistryCatalog,
}
impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("google-metadata-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("store.sqlite3");
        let store = Store::open(&path).await.unwrap();
        store
            .setup("synthetic-owner", "synthetic-password-hash")
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        let other_store = Store::open(&root.join("other.sqlite3")).await.unwrap();
        other_store
            .setup("synthetic-second", "synthetic-password-hash")
            .await
            .unwrap();
        let other = other_store
            .credentials("synthetic-second")
            .await
            .unwrap()
            .unwrap()
            .0;
        let mut bindings = Vec::new();
        for (number, target, legacy, capability) in [
            (0, &owner, "legacy-a", "gmail_read"),
            (1, &other, "legacy-b", "calendar_read"),
        ] {
            let directory = root.join(format!("registry-{number}"));
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join("google-workspace-connections.json");
            std::fs::write(&path, json!({"schemaVersion":1,"ownerUserId":legacy,"connections":[{
                "connectionId":"fake-account","ownerUserId":legacy,"capabilities":[capability],
                "tokenRef":"never-open-token.json","healthState":"connected","useMode":"explicit_only"}]}).to_string()).unwrap();
            bindings.push(RegistryBinding {
                owner: target.clone(),
                legacy_registry_owner: legacy.into(),
                path,
            });
        }
        Self {
            root,
            store,
            owner,
            other,
            other_store,
            catalog: RegistryCatalog::new(bindings).unwrap(),
        }
    }
    async fn session(&self, owner: &OwnerId, cookie: &str) {
        let store = if owner == &self.owner {
            &self.store
        } else {
            &self.other_store
        };
        store
            .save_session(&format!("browser:{cookie}"), owner)
            .await
            .unwrap();
    }
    async fn serve(&self, catalog: RegistryCatalog) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        self.serve_store(catalog, self.store.clone()).await
    }
    async fn serve_store(
        &self,
        catalog: RegistryCatalog,
        store: Store,
    ) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = AppState::new(store, "b".repeat(64), format!("http://{address}")).unwrap();
        let app = router(catalog)
            .route(
                "/api/v2/browser/session",
                axum::routing::delete(crate::browser::logout),
            )
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::guard,
            ))
            .with_state(state);
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (address, server)
    }
    async fn cleanup(self) {
        self.store.close().await;
        self.other_store.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
}
async fn request(
    address: SocketAddr,
    method: &str,
    path: &str,
    extra: String,
) -> (u16, String, Value) {
    let method = method.to_owned();
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut socket = std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_secs(5)).unwrap();
        socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        socket.set_write_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        socket.write_all(format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\n{extra}Content-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
        let mut raw = String::new(); socket.read_to_string(&mut raw).unwrap();
        let (headers, body) = raw.split_once("\r\n\r\n").unwrap();
        (headers.split_whitespace().nth(1).unwrap().parse().unwrap(), headers.to_lowercase(),
         if body.is_empty() { Value::Null } else { serde_json::from_str(body).unwrap() })
    }).await.unwrap()
}
fn cookie(value: &str) -> String {
    format!("Cookie: orkestr_v2_session={value}\r\n")
}
#[tokio::test]
async fn native_two_owner_cookie_routes_and_explicit_legacy_binding() {
    let fixture = Fixture::new().await;
    let a = "a".repeat(64);
    let b = "c".repeat(64);
    fixture.session(&fixture.owner, &a).await;
    fixture.session(&fixture.other, &b).await;
    let (address, server) = fixture.serve(fixture.catalog.clone()).await;
    let (other_address, other_server) = fixture
        .serve_store(fixture.catalog.clone(), fixture.other_store.clone())
        .await;
    for (address, token, present, absent) in [
        (address, &a, "gmail_read", "calendar_read"),
        (other_address, &b, "calendar_read", "gmail_read"),
    ] {
        let (status, headers, value) = request(address, "GET", ROUTE, cookie(token)).await;
        assert_eq!(status, 200);
        assert!(headers.contains("cache-control: no-store"));
        assert!(headers.contains("x-content-type-options: nosniff"));
        assert_eq!(value["metadata"]["capabilities"][present], 1);
        assert_eq!(value["metadata"]["capabilities"][absent], 0);
        assert_eq!(value["metadata"]["provider_readiness_verified"], false);
        assert!(!value.to_string().contains("legacy-"));
    }
    for extra in [
        String::new(),
        format!("Authorization: Bearer {a}\r\n"),
        format!("{}Authorization: Bearer {a}\r\n", cookie(&a)),
        format!("{}{}", cookie(&a), cookie(&a)),
    ] {
        assert_eq!(request(address, "GET", ROUTE, extra).await.0, 401);
    }
    assert_eq!(
        request(
            address,
            "GET",
            &format!("{ROUTE}?owner=foreign"),
            cookie(&a)
        )
        .await
        .0,
        400
    );
    assert_eq!(
        request(
            address,
            "GET",
            ROUTE,
            format!("{}X-Registry-Path: foreign\r\n", cookie(&a))
        )
        .await
        .0,
        400
    );
    assert_eq!(
        request(
            address,
            "GET",
            ROUTE,
            format!("{}Origin: https://foreign.example.invalid\r\n", cookie(&a))
        )
        .await
        .0,
        403
    );
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, "foreign.example.invalid".parse().unwrap());
    let state = AppState::new(
        fixture.store.clone(),
        "b".repeat(64),
        format!("http://{address}"),
    )
    .unwrap();
    assert_eq!(
        validate(&state, &headers, None, &[]).unwrap_err().1,
        "host_rejected"
    );
    server.abort();
    let _ = server.await;
    other_server.abort();
    let _ = other_server.await;
    fixture.cleanup().await;
}
#[tokio::test]
async fn native_revoke_logout_at_pre_read_and_pre_delivery_refuse() {
    for stage in [Stage::BeforeRead, Stage::BeforeDelivery] {
        for logout in [false, true] {
            let mut fixture = Fixture::new().await;
            let token = "a".repeat(64);
            fixture.session(&fixture.owner, &token).await;
            let hook = Arc::new(Pause {
                stage,
                entered: Notify::new(),
                resume: Notify::new(),
            });
            fixture.catalog.pause = Some(hook.clone());
            let (address, server) = fixture.serve(fixture.catalog.clone()).await;
            let request_token = token.clone();
            let pending = tokio::spawn(async move {
                request(address, "GET", ROUTE, cookie(&request_token)).await
            });
            tokio::time::timeout(std::time::Duration::from_secs(5), hook.entered.notified())
                .await
                .unwrap();
            if logout {
                let csrf = format!(
                    "{:x}",
                    Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{token}").as_bytes())
                );
                let (status, _, _) = request(
                    address,
                    "DELETE",
                    "/api/v2/browser/session",
                    format!(
                        "{}Origin: http://{address}\r\nX-Orkestr-Csrf: {csrf}\r\n",
                        cookie(&token)
                    ),
                )
                .await;
                assert_eq!(status, 204);
            } else {
                fixture
                    .store
                    .revoke_session(&format!("browser:{token}"))
                    .await
                    .unwrap();
            }
            hook.resume.notify_one();
            let (status, headers, value) = pending.await.unwrap();
            assert_eq!(status, 401);
            assert!(headers.contains("cache-control: no-store"));
            assert_eq!(value["error"], "authentication_required");
            assert!(value.get("metadata").is_none());
            server.abort();
            let _ = server.await;
            fixture.cleanup().await;
        }
    }
}
#[tokio::test]
async fn native_no_global_fallback_no_initialization_and_foreign_source_owner() {
    let fixture = Fixture::new().await;
    let token = "a".repeat(64);
    fixture.session(&fixture.owner, &token).await;
    let other = fixture
        .catalog
        .bindings
        .get(&fixture.other)
        .unwrap()
        .clone();
    let (address, server) = fixture
        .serve(RegistryCatalog::new(vec![other]).unwrap())
        .await;
    assert_eq!(request(address, "GET", ROUTE, cookie(&token)).await.0, 503);
    server.abort();
    let _ = server.await;
    let binding = fixture.catalog.bindings.get(&fixture.owner).unwrap();
    std::fs::remove_file(&binding.path).unwrap();
    let (address, server) = fixture.serve(fixture.catalog.clone()).await;
    assert_eq!(request(address, "GET", ROUTE, cookie(&token)).await.0, 503);
    assert!(!binding.path.exists());
    std::fs::write(
        &binding.path,
        json!({"schemaVersion":1,"ownerUserId":"foreign","connections":[]}).to_string(),
    )
    .unwrap();
    assert_eq!(request(address, "GET", ROUTE, cookie(&token)).await.0, 503);
    assert!(
        !binding
            .path
            .parent()
            .unwrap()
            .join("never-open-token.json")
            .exists()
    );
    server.abort();
    let _ = server.await;
    fixture.cleanup().await;
}
#[test]
fn native_strict_reader_and_dto_fixture() {
    let root = std::env::temp_dir().join(format!("google-reader-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("google-workspace-connections.json");
    std::fs::write(
        &path,
        r#"{"schemaVersion":1,"ownerUserId":"legacy-a","connections":[]}"#,
    )
    .unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/migration-audit/google-registry/status-v1.json"
    ))
    .unwrap();
    assert_eq!(
        reader::metadata(&path, "legacy-a").unwrap(),
        fixture["success"]["metadata"]
    );
    for raw in [
        r#"{"x":1,"x":2}"#,
        r#"{"nested":{"x":1,"x":2}}"#,
        "NaN",
        "{",
    ] {
        std::fs::write(&path, raw).unwrap();
        assert!(reader::metadata(&path, "legacy-a").is_err());
    }
    std::fs::write(&path, vec![b' '; reader::MAX_BYTES as usize + 1]).unwrap();
    assert!(reader::metadata(&path, "legacy-a").is_err());
    #[cfg(unix)]
    {
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(root.join("never-open-token.json"), &path).unwrap();
        assert!(reader::metadata(&path, "legacy-a").is_err());
    }
    std::fs::remove_dir_all(root).unwrap();
}
