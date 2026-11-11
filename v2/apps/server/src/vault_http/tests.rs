//! Actual HTTP through the canonical router and guard; synthetic data only.
use super::reader::ReaderState;
use crate::AppState;
use orkestr_v2_contracts::DesktopBindingRequest;
use orkestr_v2_store_sqlite::{DesktopCaller, Store, V1LeaseGrant};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const SECRET: &str = "synthetic-Http-Vault-Secret-4417";
const COOKIE: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const SERVICE_COOKIE: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const MACHINE: &str = "3333333333333333333333333333333333333333333333333333333333333333";
const READER_TOKEN: &str = "4444444444444444444444444444444444444444444444444444444444444444";
const FENCE: &str = "fence-http-vault-01";

struct Case {
    root: PathBuf,
    store: Store,
    socket: PathBuf,
    server: tokio::task::JoinHandle<()>,
    conversation: String,
    reader: age::x25519::Identity,
}
fn reader_config(recipient: &str, owner: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(READER_TOKEN.as_bytes()));
    serde_json::json!({"format":"orkestr-v2-vault-stored-login-v1","owner_id":owner,"recipient":recipient,"reader_token_sha256":digest}).to_string()
}
impl Case {
    async fn new(with_reader: bool) -> Self {
        let root = std::env::temp_dir().join(format!("vault-http-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let conversation = store.setup("synthetic", "hash").await.unwrap();
        let owner = store.credentials("synthetic").await.unwrap().unwrap().0;
        store
            .save_session(&format!("browser:{COOKIE}"), &owner)
            .await
            .unwrap();
        store.save_session(MACHINE, &owner).await.unwrap();
        // The adapter's kind of session: a service credential exchanged for a cookie.
        let service = "6".repeat(64);
        store
            .create_service_credential(&format!("browser:{COOKIE}"), "hash", "adapter", &service)
            .await
            .unwrap()
            .unwrap();
        store
            .exchange_service_session(&service, &format!("browser:{SERVICE_COOKIE}"))
            .await
            .unwrap()
            .unwrap();
        let reader = age::x25519::Identity::generate();
        let mut state =
            AppState::new(store.clone(), "ef".repeat(32), "http://localhost".into()).unwrap();
        if with_reader {
            let config = reader_config(&reader.to_public().to_string(), &owner.to_string());
            state = state.with_vault_reader(ReaderState::parse(&config));
        }
        let app = crate::router(state);
        let socket = root.join("http.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            root,
            store,
            socket,
            server,
            conversation: conversation.to_string(),
            reader,
        }
    }
    async fn call(&self, method: &str, path: &str, headers: &str, body: &str) -> (u16, String) {
        call(&self.socket, method, path, headers, body.as_bytes()).await
    }
    async fn owner(&self, method: &str, path: &str, body: &str) -> (u16, serde_json::Value) {
        let (status, text) = self.call(method, path, &browser(true), body).await;
        (
            status,
            serde_json::from_str(&text).unwrap_or(serde_json::Value::Null),
        )
    }
    async fn lease(&self, desk: &str) {
        let owner = self
            .store
            .credentials("synthetic")
            .await
            .unwrap()
            .unwrap()
            .0;
        let conversation =
            orkestr_v2_contracts::ConversationId(Uuid::parse_str(&self.conversation).unwrap());
        let caller = DesktopCaller::Owner {
            credential: MACHINE,
            owner: &owner,
        };
        self.store
            .bind_desktops(
                MACHINE,
                &owner,
                &conversation,
                &DesktopBindingRequest {
                    expected_revision: 0,
                    v1_thread_id: "thr_synthetic_http".into(),
                    desktop_slugs: vec![desk.into()],
                },
            )
            .await
            .unwrap();
        let prepared = self
            .store
            .prepare_desktop_acquire(caller, &conversation, desk)
            .await
            .unwrap();
        self.store
            .record_desktop_acquired(
                caller,
                &conversation,
                &prepared,
                desk,
                &V1LeaseGrant {
                    lease_id: "synthetic".into(),
                    fencing_token: FENCE.into(),
                    fencing_version: 1,
                    expires_at: None,
                },
                600_000,
            )
            .await
            .unwrap();
    }
    fn read_body(&self, site: &str, check: bool) -> String {
        serde_json::json!({"conversation_id": self.conversation, "desk": "owner-desk", "fencing_token": FENCE, "site": site, "mode": "auto", "operation": "op-http-1", "check": check}).to_string()
    }
    async fn finish(self) {
        self.server.abort();
        self.store.close().await;
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn csrf(token: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{token}").as_bytes())
    )
}
fn browser(with_csrf: bool) -> String {
    let mut h = format!("Cookie: orkestr_v2_session={COOKIE}\r\nOrigin: http://localhost\r\n");
    if with_csrf {
        h.push_str(&format!("x-orkestr-csrf: {}\r\n", csrf(COOKIE)));
    }
    h
}
async fn call(
    socket: &Path,
    method: &str,
    path: &str,
    headers: &str,
    body: &[u8],
) -> (u16, String) {
    let mut stream = tokio::net::UnixStream::connect(socket).await.unwrap();
    stream.write_all(format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        stream.read_to_end(&mut bytes),
    )
    .await
    .unwrap()
    .unwrap();
    let split = bytes.windows(4).position(|v| v == b"\r\n\r\n").unwrap();
    let head = std::str::from_utf8(&bytes[..split])
        .unwrap()
        .to_ascii_lowercase();
    let status: u16 = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    if status < 300 && status != 204 {
        assert!(head.contains("cache-control: no-store"), "{head}");
    }
    let mut body = bytes[split + 4..].to_vec();
    if head.contains("transfer-encoding: chunked") {
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
    (status, String::from_utf8(body).unwrap())
}
fn unbase64(text: &str) -> Vec<u8> {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0u32);
    for c in text.bytes().filter(|c| *c != b'=') {
        acc = (acc << 6) | A.iter().position(|a| *a == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}
fn opened(identity: &age::x25519::Identity, base64: &str) -> serde_json::Value {
    let ciphertext = unbase64(base64);
    let decryptor = age::Decryptor::new(&ciphertext[..]).unwrap();
    let mut reader = decryptor
        .decrypt(std::iter::once(identity as &dyn age::Identity))
        .unwrap();
    let mut plain = String::new();
    reader.read_to_string(&mut plain).unwrap();
    let (magic, json) = plain.split_once('\n').unwrap();
    assert_eq!(magic, "ORKESTR-VAULT-LOGIN/1");
    serde_json::from_str(json).unwrap()
}
fn item(name: &str, url: &str) -> String {
    serde_json::json!({"name": name, "url": url, "username": "synthetic-http-user", "password": SECRET, "notes": "", "tags": []}).to_string()
}

#[tokio::test]
async fn owner_routes_need_a_password_browser_session_and_csrf() {
    let case = Case::new(true).await;
    let path = "/api/v2/vault/items";
    // Anonymous, machine Bearer and service-credential cookies are refused.
    for headers in [
        String::new(),
        format!("Authorization: Bearer {MACHINE}\r\n"),
        format!("Cookie: orkestr_v2_session={SERVICE_COOKIE}\r\n"),
    ] {
        assert_eq!(
            case.call("GET", path, &headers, "").await.0,
            401,
            "{headers}"
        );
    }
    let service_post = format!("Cookie: orkestr_v2_session={SERVICE_COOKIE}\r\nOrigin: http://localhost\r\nx-orkestr-csrf: {}\r\n", csrf(SERVICE_COOKIE));
    assert_eq!(
        case.call(
            "POST",
            path,
            &service_post,
            &item("x", "https://example.com")
        )
        .await
        .0,
        401
    );
    // Browser mutations need the CSRF token and this origin.
    assert_eq!(
        case.call(
            "POST",
            path,
            &browser(false),
            &item("x", "https://example.com")
        )
        .await
        .0,
        403
    );
    let foreign = format!("Cookie: orkestr_v2_session={COOKIE}\r\nOrigin: http://foreign.invalid\r\nx-orkestr-csrf: {}\r\n", csrf(COOKIE));
    assert_eq!(
        case.call("POST", path, &foreign, &item("x", "https://example.com"))
            .await
            .0,
        403
    );
    assert_eq!(
        case.store_count("SELECT count(*) FROM vault_items").await,
        0
    );
    let (status, created) = case
        .owner(
            "POST",
            path,
            &item("Synthetic Mail", "https://mail.example.com"),
        )
        .await;
    assert_eq!(status, 201);
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(created["stored_login_ready"], true);
    // No response but the sealed form carries the value; errors never echo input.
    let (_, listed) = case.call("GET", path, &browser(false), "").await;
    assert!(
        listed.contains(&id) && !listed.contains(SECRET) && !listed.contains("synthetic-http-user")
    );
    assert!(!created.to_string().contains(SECRET));
    let bad = serde_json::json!({"name": "", "url": "https://example.com", "password": SECRET})
        .to_string();
    let (status, refused) = case.call("POST", path, &browser(true), &bad).await;
    assert_eq!(status, 400);
    assert!(!refused.contains(SECRET), "{refused}");
    let bad_url = serde_json::json!({"name": "x", "url": format!("https://{SECRET} host/"), "password": SECRET}).to_string();
    let (status, refused) = case.call("POST", path, &browser(true), &bad_url).await;
    assert_eq!((status, refused.contains(SECRET)), (400, false));
    let (status, audit) = case
        .call("GET", "/api/v2/vault/audit", &browser(false), "")
        .await;
    assert_eq!(status, 200);
    assert!(audit.contains("item_created") && !audit.contains(SECRET));
    // Delete needs CSRF too.
    let item_path = format!("{path}/{id}");
    assert_eq!(
        case.call("DELETE", &item_path, &browser(false), "").await.0,
        403
    );
    assert_eq!(
        case.call("DELETE", &item_path, &browser(true), "").await.0,
        204
    );
    let (status, status_body) = case.owner("GET", "/api/v2/vault", "").await;
    assert_eq!(
        (
            status,
            status_body["stored_login"].as_str(),
            status_body["items"].as_i64()
        ),
        (200, Some("ready"), Some(0))
    );
    case.finish().await;
}

#[tokio::test]
async fn the_helper_reads_one_sealed_login_with_its_token_while_the_lease_is_held() {
    let case = Case::new(true).await;
    let (_, created) = case
        .owner(
            "POST",
            "/api/v2/vault/items",
            &item("Synthetic Portal", "https://portal.example.com/login"),
        )
        .await;
    let path = "/api/v2/vault/stored-login";
    let reader = format!("x-orkestr-vault-reader: {READER_TOKEN}\r\n");
    let body = case.read_body("portal.example.com", false);
    // Without the lease: refused (and audited).
    assert_eq!(case.call("POST", path, &reader, &body).await.0, 409);
    case.lease("owner-desk").await;
    for headers in [
        String::new(),
        format!("x-orkestr-vault-reader: {}\r\n", "5".repeat(64)),
        format!("{reader}Authorization: Bearer {MACHINE}\r\n"),
        format!("{reader}{reader}"),
    ] {
        assert_eq!(
            case.call("POST", path, &headers, &body).await.0,
            401,
            "{headers}"
        );
    }
    // A cookie with the reader token: the browser guard or the route refuses it.
    let cookie = format!("{reader}Cookie: orkestr_v2_session={COOKIE}\r\n");
    assert!([401, 403].contains(&case.call("POST", path, &cookie, &body).await.0));
    // The owner's browser cannot use the helper route either.
    assert_eq!(case.call("POST", path, &browser(true), &body).await.0, 401);
    let (status, text) = case.call("POST", path, &reader, &body).await;
    assert_eq!(status, 200, "{text}");
    assert!(!text.contains(SECRET));
    let found: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(found["item_id"], created["id"]);
    let login = opened(&case.reader, found["sealed_base64"].as_str().unwrap());
    assert_eq!(
        (login["password"].as_str(), login["domain"].as_str()),
        (Some(SECRET), Some("portal.example.com"))
    );
    assert_eq!(login["item_id"], created["id"]);
    // --check carries no ciphertext; a parent domain gets nothing.
    let (_, checked) = case
        .call(
            "POST",
            path,
            &reader,
            &case.read_body("portal.example.com", true),
        )
        .await;
    assert!(!checked.contains("sealed_base64"));
    let (status, missing) = case
        .call("POST", path, &reader, &case.read_body("example.com", false))
        .await;
    assert_eq!(status, 404, "{missing}");
    assert!(missing.contains("no_credential_for_site"));
    let (status, _) = case
        .call("POST", path, &reader, "{\"conversation_id\":\"x\"}")
        .await;
    assert_eq!(status, 400);
    let refused = case
        .store_count("SELECT count(*) FROM vault_audit WHERE event='stored_login_refused'")
        .await;
    assert_eq!(refused, 2);
    case.finish().await;
    // No reader configured: the route is off.
    let off = Case::new(false).await;
    let (status, text) = off
        .call("POST", path, &reader, &off.read_body("example.com", false))
        .await;
    assert_eq!(status, 503, "{text}");
    off.finish().await;
}

#[tokio::test]
async fn the_import_route_is_idempotent_and_takes_a_large_body() {
    let case = Case::new(true).await;
    let entries: Vec<serde_json::Value> = (0..40)
        .map(|n| serde_json::json!({
            "source_id": format!("vi_synthetic{n:03}"),
            "source_checksum": format!("{:x}", Sha256::digest(format!("v1-record-{n}").as_bytes())),
            "name": format!("Imported {n}"),
            "url": format!("https://site{n}.example.com"),
            "username": "synthetic-import-user",
            "password": SECRET,
            "notes": "n".repeat(1500),
            "thread_grants": [{"v1_thread_id": "thr_synthetic_http"}],
        }))
        .collect();
    let body =
        serde_json::json!({"format": "orkestr-vault-import-v1", "source": "v1", "items": entries})
            .to_string();
    assert!(body.len() > 40 * 1024);
    let (status, first) = case.owner("POST", "/api/v2/vault/import", &body).await;
    assert_eq!(
        (status, first["imported"].as_u64()),
        (200, Some(40)),
        "{first}"
    );
    assert!(!first.to_string().contains(SECRET));
    let (status, again) = case.owner("POST", "/api/v2/vault/import", &body).await;
    assert_eq!(
        (
            status,
            again["unchanged"].as_u64(),
            again["imported"].as_u64()
        ),
        (200, Some(40), Some(0))
    );
    assert_eq!(
        case.store_count("SELECT count(*) FROM vault_items").await,
        40
    );
    // The import still needs CSRF (a small body: the guard answers before reading it).
    let small =
        serde_json::json!({"format": "orkestr-vault-import-v1", "source": "v1", "items": []})
            .to_string();
    assert_eq!(
        case.call("POST", "/api/v2/vault/import", &browser(false), &small)
            .await
            .0,
        403
    );
    case.finish().await;
}

#[test]
fn the_reader_file_must_be_private_and_well_formed() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("vault-reader-{}", Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("vault-stored-login.json");
    assert_eq!(ReaderState::load(&path).label(), "unconfigured");
    let recipient = age::x25519::Identity::generate().to_public().to_string();
    let owner = Uuid::new_v4().to_string();
    std::fs::write(&path, reader_config(&recipient, &owner)).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        ReaderState::load(&path).rejection(),
        Some("custody_rejected")
    );
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(ReaderState::load(&path).label(), "ready");
    let link = dir.join("link.json");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert_eq!(ReaderState::load(&link).label(), "config_rejected");
    for (text, reason) in [
        ("{", "invalid_json"),
        (
            r#"{"format":"other","owner_id":"x","recipient":"x","reader_token_sha256":"x"}"#,
            "unknown_format",
        ),
    ] {
        assert_eq!(ReaderState::parse(text).rejection(), Some(reason));
    }
    let wrong_recipient = reader_config("age1notarecipient", &owner);
    assert_eq!(
        ReaderState::parse(&wrong_recipient).rejection(),
        Some("invalid_recipient")
    );
    let _ = std::fs::remove_dir_all(&dir);
}

impl Case {
    async fn store_count(&self, sql: &str) -> i64 {
        let pool = sqlx::SqlitePool::connect(&format!(
            "sqlite://{}?mode=ro",
            self.root.join("core.sqlite3").display()
        ))
        .await
        .unwrap();
        let value = sqlx::query_scalar(sql).fetch_one(&pool).await.unwrap();
        pool.close().await;
        value
    }
}
