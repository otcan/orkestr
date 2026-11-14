//! Actual HTTP through the canonical router and guard, against the built-in
//! vault and a synthetic OpenBao that enforces what the admin AppRole may do
//! (no value reads, check-and-set, metadata value limits). Synthetic data only.
use super::Backend;
use crate::AppState;
use axum::{extract::State, http::StatusCode, response::IntoResponse};
use orkestr_v2_store_sqlite::Store;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const COOKIE: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const SERVICE_COOKIE: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const MACHINE: &str = "3333333333333333333333333333333333333333333333333333333333333333";
const ROLE: &str = "00000000-0000-4000-8000-0000000000r1";
const SECRET_ID: &str = "00000000-0000-4000-8000-0000000000s1";
const PASSWORD: &str = "synthetic-Credential-Password-7781";
const API_KEY: &str = "synthetic-Credential-Key-5531";
const CHAT: &str = "00000000-0000-4000-8000-00000000000a";

#[derive(Default)]
struct Cred {
    custom: Map<String, Value>,
    data: Map<String, Value>,
    version: i64,
    deleted: bool,
    updated: String,
}
#[derive(Default)]
struct Fake {
    creds: Mutex<BTreeMap<String, Cred>>,
    log: Mutex<Vec<String>>,
    logins: Mutex<u32>,
    token: Mutex<String>,
    /// "ok", "rate" (429) or "down" (503).
    mode: Mutex<&'static str>,
    clock: Mutex<u64>,
}
impl Fake {
    fn tick(&self) -> String {
        let mut clock = self.clock.lock().unwrap();
        *clock += 1;
        format!("2026-01-01T00:00:00.{:09}Z", *clock)
    }
    fn seed(&self, slug: &str, custom: Value, data: Value) {
        let updated = self.tick();
        self.creds.lock().unwrap().insert(
            slug.into(),
            Cred {
                custom: custom.as_object().cloned().unwrap(),
                data: data.as_object().cloned().unwrap(),
                version: 1,
                deleted: false,
                updated,
            },
        );
    }
    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

fn answer(status: u16, body: Value) -> axum::response::Response {
    let status = StatusCode::from_u16(status).unwrap();
    if body.is_null() {
        status.into_response()
    } else {
        (status, axum::Json(body)).into_response()
    }
}

async fn fake_bao(
    State(fake): State<Arc<Fake>>,
    request: axum::extract::Request,
) -> axum::response::Response {
    let method = request.method().as_str().to_owned();
    let path = request.uri().path().to_owned();
    // The borrow of the request ends here, before the body is awaited.
    let (tool, token, kind) = {
        let header = |name: &str| {
            request
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned()
        };
        (
            header("x-orkestr-tool"),
            header("x-vault-token"),
            header("content-type"),
        )
    };
    let bytes = axum::body::to_bytes(request.into_body(), 1 << 20)
        .await
        .unwrap_or_default();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    fake.log
        .lock()
        .unwrap()
        .push(format!("{method} {path} tool={tool}"));
    match *fake.mode.lock().unwrap() {
        "rate" => return answer(429, json!({"errors": ["rate limit quota exceeded"]})),
        "down" => return answer(503, json!({"errors": ["Vault is sealed"]})),
        _ => {}
    }
    if path == "/v1/auth/approle/login" {
        if body["role_id"] != ROLE || body["secret_id"] != SECRET_ID {
            return answer(400, json!({"errors": ["invalid role or secret ID"]}));
        }
        let mut logins = fake.logins.lock().unwrap();
        *logins += 1;
        let issued = format!("synthetic-token-{logins}");
        *fake.token.lock().unwrap() = issued.clone();
        return answer(
            200,
            json!({"auth": {"client_token": issued, "lease_duration": 600}}),
        );
    }
    if token.is_empty() || token != *fake.token.lock().unwrap() {
        return answer(403, json!({"errors": ["permission denied"]}));
    }
    let Some(rest) = path.strip_prefix("/v1/orkestr/") else {
        return answer(404, json!({"errors": []}));
    };
    let (area, slug) = rest.split_once("/creds/").unwrap_or((rest, ""));
    let mut creds = fake.creds.lock().unwrap();
    match (method.as_str(), area, slug) {
        ("LIST", "metadata", "") => {
            if creds.is_empty() {
                return answer(404, json!({"errors": []}));
            }
            answer(
                200,
                json!({"data": {"keys": creds.keys().collect::<Vec<_>>()}}),
            )
        }
        ("GET", "metadata", slug) => match creds.get(slug) {
            None => answer(404, json!({"errors": []})),
            Some(c) => answer(
                200,
                json!({"data": {"current_version": c.version, "custom_metadata": c.custom, "updated_time": c.updated,
                "versions": {c.version.to_string(): {"deletion_time": if c.deleted { "2026-01-02T00:00:00Z" } else { "" }, "destroyed": false}}}}),
            ),
        },
        ("POST", "metadata", slug) => {
            let custom = body["custom_metadata"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            if custom
                .values()
                .any(|v| v.as_str().is_none_or(|s| s.is_empty() || s.len() > 512))
            {
                return answer(
                    400,
                    json!({"errors": ["custom_metadata validation failed"]}),
                );
            }
            let updated = fake.tick();
            let entry = creds.entry(slug.to_owned()).or_default();
            entry.custom = custom;
            entry.updated = updated;
            answer(204, Value::Null)
        }
        ("DELETE", "metadata", slug) => {
            creds.remove(slug);
            answer(204, Value::Null)
        }
        ("GET", "data", _) => answer(403, json!({"errors": ["permission denied"]})),
        ("POST" | "PATCH", "data", slug) => {
            if method == "PATCH" && kind != "application/merge-patch+json" {
                return answer(415, json!({"errors": ["unsupported content type"]}));
            }
            let Some(entry) = creds.get_mut(slug) else {
                return if method == "PATCH" {
                    answer(404, json!({"errors": []}))
                } else {
                    answer(400, json!({"errors": ["no metadata"]}))
                };
            };
            if body["options"]["cas"].as_i64() != Some(entry.version) {
                return answer(
                    400,
                    json!({"errors": ["check-and-set parameter did not match the current version"]}),
                );
            }
            let data = body["data"].as_object().cloned().unwrap_or_default();
            if method == "PATCH" {
                entry.data.extend(data);
            } else {
                entry.data = data;
            }
            entry.version += 1;
            entry.deleted = false;
            answer(200, json!({"data": {"version": entry.version}}))
        }
        ("POST", "delete", slug) => match creds.get_mut(slug) {
            Some(entry)
                if body["versions"]
                    .as_array()
                    .is_some_and(|v| v.contains(&json!(entry.version))) =>
            {
                entry.deleted = true;
                answer(204, Value::Null)
            }
            _ => answer(404, json!({"errors": []})),
        },
        _ => answer(404, json!({"errors": []})),
    }
}

struct Case {
    root: PathBuf,
    store: Store,
    socket: PathBuf,
    server: tokio::task::JoinHandle<()>,
    fake: Arc<Fake>,
}
impl Case {
    /// `backend`: "openbao", "openbao+catalog", "v2_vault" or "refused".
    async fn new(backend: &str) -> Self {
        let root = std::env::temp_dir().join(format!("credentials-http-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        store.setup("synthetic", "hash").await.unwrap();
        let owner = store.credentials("synthetic").await.unwrap().unwrap().0;
        store
            .save_session(&format!("browser:{COOKIE}"), &owner)
            .await
            .unwrap();
        store.save_session(MACHINE, &owner).await.unwrap();
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
        let fake = Arc::new(Fake::default());
        *fake.mode.lock().unwrap() = "ok";
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let bao = axum::Router::new()
            .fallback(fake_bao)
            .with_state(fake.clone());
        tokio::spawn(async move { axum::serve(listener, bao).await.unwrap() });
        let mut config = json!({"format": "orkestr-v2-credentials-backend-v1", "backend": "openbao", "address": format!("http://{address}"),
            "role_id": ROLE, "secret_id": SECRET_ID, "usage_summary": root.join("usage.json"),
            "reveal_url": "https://bao.example.invalid/ui/vault/secrets/orkestr/kv/creds%2F{id}"});
        if backend == "openbao+catalog" {
            config["catalog"] = json!(root.join("catalog.json"));
        }
        let mut state =
            AppState::new(store.clone(), "ef".repeat(32), "http://localhost".into()).unwrap();
        state = match backend {
            "v2_vault" => {
                let reader = age::x25519::Identity::generate();
                let digest = format!("{:x}", Sha256::digest("4".repeat(64).as_bytes()));
                let reader_config = json!({"format": "orkestr-v2-vault-stored-login-v1", "owner_id": owner.to_string(),
                    "recipient": reader.to_public().to_string(), "reader_token_sha256": digest});
                state
                    .with_vault_reader(crate::vault_http::ReaderState::parse(
                        &reader_config.to_string(),
                    ))
                    .with_credentials(Backend::V2Vault {
                        usage: Some(root.join("usage.json")),
                    })
            }
            "refused" => state.with_credentials(Backend::parse("{}", &root)),
            _ => state.with_credentials(Backend::parse(&config.to_string(), &root)),
        };
        let app = crate::router(state);
        let socket = root.join("http.sock");
        let unix = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move { axum::serve(unix, app).await.unwrap() });
        Self {
            root,
            store,
            socket,
            server,
            fake,
        }
    }
    async fn call(&self, method: &str, path: &str, headers: &str, body: &str) -> (u16, String) {
        let mut stream = tokio::net::UnixStream::connect(&self.socket).await.unwrap();
        stream.write_all(format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
        stream.write_all(body.as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(15),
            stream.read_to_end(&mut bytes),
        )
        .await
        .unwrap()
        .unwrap();
        let split = bytes.windows(4).position(|v| v == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&bytes[..split]).to_ascii_lowercase();
        let status: u16 = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        let mut body = bytes[split + 4..].to_vec();
        if head.contains("transfer-encoding: chunked") {
            let (mut out, mut rest) = (Vec::new(), body.as_slice());
            loop {
                let end = rest.windows(2).position(|w| w == b"\r\n").unwrap();
                let size =
                    usize::from_str_radix(std::str::from_utf8(&rest[..end]).unwrap().trim(), 16)
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
        let text = String::from_utf8(body).unwrap();
        assert!(
            !text.contains(PASSWORD) && !text.contains(API_KEY),
            "a value left the server: {text}"
        );
        (status, text)
    }
    async fn owner(&self, method: &str, path: &str, body: Value) -> (u16, Value) {
        let csrf = format!(
            "{:x}",
            Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{COOKIE}").as_bytes())
        );
        let headers = format!("Cookie: orkestr_v2_session={COOKIE}\r\nOrigin: http://localhost\r\nx-orkestr-csrf: {csrf}\r\n");
        let body = if body.is_null() {
            String::new()
        } else {
            body.to_string()
        };
        let (status, text) = self.call(method, path, &headers, &body).await;
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }
    async fn finish(self) {
        self.server.abort();
        self.store.close().await;
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A value-free file the root job would write: closed to writes by others,
/// whatever the umask of the test host.
fn write_shared(path: impl AsRef<std::path::Path>, text: String) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path.as_ref(), text)?;
    std::fs::set_permissions(path.as_ref(), std::fs::Permissions::from_mode(0o644))
}

fn row<'a>(list: &'a Value, id: &str) -> &'a Value {
    list["credentials"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or(&Value::Null)
}

#[tokio::test]
async fn openbao_credentials_are_listed_added_edited_and_deleted_without_reading_a_value() {
    let case = Case::new("openbao").await;
    case.fake.seed("search", json!({"type": "api_key", "site": "search.example.com", "label": "Search", "allowed": format!("{CHAT},owner-desks"), "legacy_id": "vi_synthetic01", "source": "v2-vault-import"}), json!({"api_key": API_KEY}));
    write_shared(case.root.join("usage.json"), json!({"format": "orkestr-credentials-usage-v1", "generated_at_ms": super::now_ms(),
        "credentials": {"search": {"last_used_at_ms": 1_700_000_000_000_i64, "last_used_by": CHAT, "chats": [{"id": CHAT, "last_at_ms": 1_700_000_000_000_i64, "uses": 2}]}}}).to_string()).unwrap();
    let (status, list) = case.owner("GET", "/api/v2/credentials", Value::Null).await;
    assert_eq!((status, list["backend"].as_str()), (200, Some("openbao")));
    assert_eq!(
        (
            list["capabilities"]["grant_ids"].as_str(),
            list["capabilities"]["reveal"].as_str()
        ),
        (Some("conversation"), Some("external"))
    );
    let search = row(&list, "search");
    assert_eq!(
        (
            search["type"].as_str(),
            search["owner_desks"].as_bool(),
            search["allowed"].clone()
        ),
        (Some("api_key"), Some(true), json!([CHAT]))
    );
    assert_eq!(
        (
            search["usage"]["status"].as_str(),
            search["usage"]["last_used_by"].as_str()
        ),
        (Some("ok"), Some(CHAT))
    );
    assert_eq!(list["usage"]["stale"], false);

    // Add: metadata first, then the value with check-and-set 0; the site becomes a bare domain.
    let add = json!({"type": "password", "label": "Example Portal", "site": "https://www.example.com/login", "allowed": [CHAT], "owner_desks": true,
        "value": {"username": "synthetic-user", "password": PASSWORD}});
    let (status, added) = case.owner("POST", "/api/v2/credentials", add.clone()).await;
    assert_eq!(
        (status, added["id"].as_str(), added["site"].as_str()),
        (201, Some("example-portal"), Some("example.com"))
    );
    assert_eq!(added["usage"]["status"], "never_used");
    {
        let creds = case.fake.creds.lock().unwrap();
        let stored = &creds["example-portal"];
        assert_eq!(stored.custom["allowed"], format!("{CHAT},owner-desks"));
        assert_eq!(stored.custom["source"], "orkestr-page");
        assert_eq!(
            (stored.data["password"].as_str(), stored.version),
            (Some(PASSWORD), 1)
        );
    }
    let log = case.fake.log();
    let meta = log
        .iter()
        .position(|l| l.starts_with("POST /v1/orkestr/metadata/creds/example-portal"))
        .unwrap();
    let data = log
        .iter()
        .position(|l| l.starts_with("POST /v1/orkestr/data/creds/example-portal"))
        .unwrap();
    assert!(meta < data, "{log:?}");
    let (_, again) = case.owner("POST", "/api/v2/credentials", add).await;
    assert_eq!(
        again["id"], "example-portal-2",
        "a taken slug gets a suffix"
    );

    // Edit with a stale revision is refused; with the current one it keeps the import's keys.
    let (status, stale) = case
        .owner(
            "PATCH",
            "/api/v2/credentials/search",
            json!({"expected_revision": "1:old", "label": "Search API v2"}),
        )
        .await;
    assert_eq!(
        (status, stale["code"].as_str()),
        (409, Some("credential_changed"))
    );
    let revision = search["revision"].as_str().unwrap();
    let (status, edited) = case.owner("PATCH", "/api/v2/credentials/search", json!({"expected_revision": revision, "label": "Search API v2", "allowed": [], "owner_desks": false})).await;
    assert_eq!(
        (
            status,
            edited["label"].as_str(),
            edited["allowed"].clone(),
            edited["owner_desks"].as_bool()
        ),
        (200, Some("Search API v2"), json!([]), Some(false))
    );
    {
        let creds = case.fake.creds.lock().unwrap();
        let custom = &creds["search"].custom;
        assert_eq!(
            (custom["legacy_id"].as_str(), custom["source"].as_str()),
            (Some("vi_synthetic01"), Some("orkestr-page"))
        );
        assert!(
            !custom.contains_key("allowed"),
            "an empty grant list is left out (the store refuses empty values)"
        );
    }

    // Replace only the password: a merge patch with check-and-set, the username stays.
    let revision = added["revision"].as_str().unwrap();
    let (status, replaced) = case
        .owner(
            "PUT",
            "/api/v2/credentials/example-portal/value",
            json!({"expected_revision": revision, "value": {"password": "synthetic-new-secret"}}),
        )
        .await;
    assert_eq!(status, 200, "{replaced}");
    {
        let creds = case.fake.creds.lock().unwrap();
        let stored = &creds["example-portal"];
        assert_eq!(
            (
                stored.data["username"].as_str(),
                stored.data["password"].as_str(),
                stored.version
            ),
            (Some("synthetic-user"), Some("synthetic-new-secret"), 2)
        );
    }
    let (status, wrong) = case
        .owner(
            "PUT",
            "/api/v2/credentials/example-portal/value",
            json!({"expected_revision": replaced["revision"], "value": {"api_key": "x"}}),
        )
        .await;
    assert_eq!(
        (status, wrong["code"].as_str()),
        (422, Some("credential_field_not_for_type"))
    );

    // Delete soft-deletes the current version; the list leaves it out.
    let path = format!(
        "/api/v2/credentials/example-portal?expected_revision={}",
        replaced["revision"].as_str().unwrap().replace(':', "%3A")
    );
    let (status, _) = case.owner("DELETE", &path, Value::Null).await;
    assert_eq!(status, 204);
    assert!(case.fake.creds.lock().unwrap()["example-portal"].deleted);
    let (_, list) = case.owner("GET", "/api/v2/credentials", Value::Null).await;
    assert!(row(&list, "example-portal").is_null() && !row(&list, "example-portal-2").is_null());

    // Never a value read; every request names the page; one sign-in served all of it.
    let log = case.fake.log();
    assert!(
        !log.iter().any(|l| l.starts_with("GET /v1/orkestr/data/")),
        "{log:?}"
    );
    assert!(
        log.iter().all(|l| l.ends_with("tool=credentials-page")),
        "{log:?}"
    );
    assert_eq!(*case.fake.logins.lock().unwrap(), 1);
    case.finish().await;
}

#[tokio::test]
async fn openbao_refusals_have_fixed_codes_and_a_lost_token_is_replaced() {
    let case = Case::new("openbao").await;
    let too_many: Vec<String> = (0..14)
        .map(|n| format!("00000000-0000-4000-8000-{n:012}"))
        .collect();
    for (body, code) in [
        (
            json!({"type": "password", "label": "No site", "value": {"password": PASSWORD}}),
            "credential_site_required",
        ),
        (
            json!({"type": "ssh", "label": "x", "value": {"token": "t"}}),
            "credential_type_invalid",
        ),
        (
            json!({"type": "token", "label": " ", "value": {"token": "t"}}),
            "credential_label_required",
        ),
        (
            json!({"type": "token", "label": "x", "value": {}}),
            "credential_value_required",
        ),
        (
            json!({"type": "token", "label": "x", "allowed": ["owner-desks"], "value": {"token": "t"}}),
            "credential_allowed_invalid",
        ),
        (
            json!({"type": "api_key", "label": "x", "allowed": too_many, "value": {"api_key": API_KEY}}),
            "credential_allowed_too_many",
        ),
    ] {
        let (status, refused) = case
            .owner("POST", "/api/v2/credentials", body.clone())
            .await;
        assert_eq!(
            (status, refused["code"].as_str()),
            (422, Some(code)),
            "{body}"
        );
    }
    let (status, _) = case
        .owner(
            "POST",
            "/api/v2/credentials",
            json!({"type": "token", "label": "x", "value": {"token": "t"}, "surprise": 1}),
        )
        .await;
    assert_eq!(status, 400);
    assert!(
        case.fake.creds.lock().unwrap().is_empty(),
        "nothing refused reached the store"
    );

    let (status, _) = case.owner("GET", "/api/v2/credentials", Value::Null).await;
    assert_eq!((status, *case.fake.logins.lock().unwrap()), (200, 1));
    *case.fake.token.lock().unwrap() = "revoked".into();
    let (status, _) = case.owner("GET", "/api/v2/credentials", Value::Null).await;
    assert_eq!(
        status, 200,
        "a token the store no longer accepts is replaced once"
    );
    assert_eq!(*case.fake.logins.lock().unwrap(), 2);
    *case.fake.mode.lock().unwrap() = "rate";
    let (status, limited) = case.owner("GET", "/api/v2/credentials", Value::Null).await;
    assert_eq!(
        (status, limited["code"].as_str()),
        (429, Some("credentials_rate_limited"))
    );
    *case.fake.mode.lock().unwrap() = "down";
    let (status, down) = case.owner("GET", "/api/v2/credentials", Value::Null).await;
    assert_eq!(
        (status, down["code"].as_str()),
        (503, Some("credentials_backend_unavailable"))
    );
    case.finish().await;
}

#[tokio::test]
async fn the_catalog_lists_without_reading_every_credential_and_shows_new_writes_at_once() {
    let case = Case::new("openbao+catalog").await;
    write_shared(case.root.join("catalog.json"), json!({"format": "orkestr-credentials-catalog-v1", "generated_at_ms": super::now_ms(),
        "credentials": [{"id": "portal", "type": "password", "site": "example.org", "label": "Portal", "allowed": ["owner-desks"], "version": 1, "updated_time": "2026-01-01T00:00:00Z"}]}).to_string()).unwrap();
    let (status, list) = case.owner("GET", "/api/v2/credentials", Value::Null).await;
    assert_eq!(
        (status, row(&list, "portal")["owner_desks"].as_bool()),
        (200, Some(true))
    );
    assert!(
        list["catalog_at_ms"].is_i64() && case.fake.log().is_empty(),
        "the catalog alone answers"
    );
    let (status, _) = case
        .owner(
            "POST",
            "/api/v2/credentials",
            json!({"type": "token", "label": "CI token", "value": {"token": "synthetic-token"}}),
        )
        .await;
    assert_eq!(status, 201);
    let (_, list) = case.owner("GET", "/api/v2/credentials", Value::Null).await;
    assert_eq!(
        row(&list, "ci-token")["type"],
        "token",
        "this server's own write shows before the next catalog"
    );
    case.finish().await;
}

#[tokio::test]
async fn the_built_in_vault_stays_the_default_store() {
    let case = Case::new("v2_vault").await;
    let (status, list) = case.owner("GET", "/api/v2/credentials", Value::Null).await;
    assert_eq!(
        (
            status,
            list["backend"].as_str(),
            list["capabilities"]["grant_ids"].as_str()
        ),
        (200, Some("v2_vault"), Some("v1_thread"))
    );
    let (status, added) = case
        .owner(
            "POST",
            "/api/v2/credentials",
            json!({"type": "api_key", "label": "Synthetic search", "site": "search.example.com",
        "allowed": ["thr_Synthetic_A"], "value": {"api_key": API_KEY}}),
        )
        .await;
    assert_eq!(
        (status, added["type"].as_str(), added["allowed"].clone()),
        (201, Some("api_key"), json!(["thr_Synthetic_A"])),
        "{added}"
    );
    let id = added["id"].as_str().unwrap().to_owned();
    let (status, fixed) = case
        .owner(
            "PATCH",
            &format!("/api/v2/credentials/{id}"),
            json!({"expected_revision": added["revision"], "owner_desks": true}),
        )
        .await;
    assert_eq!(
        (status, fixed["code"].as_str()),
        (422, Some("credential_owner_desks_fixed"))
    );
    let (status, renamed) = case
        .owner(
            "PATCH",
            &format!("/api/v2/credentials/{id}"),
            json!({"expected_revision": added["revision"], "label": "Search API"}),
        )
        .await;
    assert_eq!(
        (status, renamed["label"].as_str(), renamed["type"].as_str()),
        (200, Some("Search API"), Some("api_key"))
    );
    let (status, replaced) = case.owner("PUT", &format!("/api/v2/credentials/{id}/value"), json!({"expected_revision": renamed["revision"], "value": {"api_key": "synthetic-other"}})).await;
    assert_eq!(status, 200, "{replaced}");
    let (status, _) = case
        .owner(
            "DELETE",
            &format!("/api/v2/credentials/{id}?expected_revision=1"),
            Value::Null,
        )
        .await;
    assert_eq!(status, 409, "a stale delete is refused");
    let (status, _) = case
        .owner(
            "DELETE",
            &format!(
                "/api/v2/credentials/{id}?expected_revision={}",
                replaced["revision"].as_str().unwrap()
            ),
            Value::Null,
        )
        .await;
    assert_eq!(status, 204);
    let (_, list) = case.owner("GET", "/api/v2/credentials", Value::Null).await;
    assert_eq!(list["credentials"], json!([]));
    case.finish().await;
}

#[tokio::test]
async fn credential_routes_need_the_owner_password_session_and_a_refused_store_says_so() {
    let case = Case::new("openbao").await;
    for headers in [
        String::new(),
        format!("Authorization: Bearer {MACHINE}\r\n"),
        format!("Cookie: orkestr_v2_session={SERVICE_COOKIE}\r\n"),
    ] {
        assert_eq!(
            case.call("GET", "/api/v2/credentials", &headers, "")
                .await
                .0,
            401,
            "{headers}"
        );
    }
    let no_csrf = format!("Cookie: orkestr_v2_session={COOKIE}\r\nOrigin: http://localhost\r\n");
    let body = json!({"type": "token", "label": "x", "value": {"token": "t"}}).to_string();
    assert_eq!(
        case.call("POST", "/api/v2/credentials", &no_csrf, &body)
            .await
            .0,
        403
    );
    assert!(case.fake.log().is_empty(), "nothing reached the store");
    case.finish().await;
    let case = Case::new("refused").await;
    let (status, refused) = case.owner("GET", "/api/v2/credentials", Value::Null).await;
    assert_eq!(
        (status, refused["code"].as_str()),
        (503, Some("credentials_backend_unconfigured"))
    );
    case.finish().await;
}
