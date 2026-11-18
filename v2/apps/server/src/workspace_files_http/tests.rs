//! The Files panel's folder routes through the canonical router and guard:
//! with a fake reader (Core's own checks), and end to end with the real
//! workspace reader (`v2/tools/workspace_reader.py`) on a temporary folder.
//! Synthetic folders and ids only.
use super::reader::{Listing, Read, Reader, ReaderError, ReaderFuture, Request, SocketReader};
use super::*;
use crate::conversation_resources_http::tests::{case, Case};
use serde_json::Value;
use std::{
    path::{Path as FsPath, PathBuf},
    sync::Mutex as StdMutex,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HOST: &str = "127.0.0.1:19882";

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    fn code(&self) -> String {
        self.json()["code"].as_str().unwrap_or("").to_owned()
    }
}

async fn get(state: &AppState, path: &str, headers: &[&str]) -> Reply {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = crate::router(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    let mut request = format!("GET {path} HTTP/1.1\r\nHost: {HOST}\r\nConnection: close\r\n");
    for header in headers {
        request.push_str(header);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    socket.read_to_end(&mut raw).await.unwrap();
    let _ = stop.send(());
    server.await.unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8(raw[..split].to_vec()).unwrap();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    Reply {
        status,
        headers,
        body: raw[split + 4..].to_vec(),
    }
}

fn cookie(case: &Case) -> String {
    format!("Cookie: orkestr_v2_session={}", case.cookie)
}
fn url(case: &Case, route: &str, path: &str) -> String {
    let mut encoded = String::new();
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!(
        "/api/v2/conversations/{}/workspace{route}?path={encoded}",
        case.conversation
    )
}

/// A reader that serves fixed answers and records what reached it.
#[derive(Default)]
struct Fake {
    listing: StdMutex<Option<Result<Listing, ReaderError>>>,
    file: StdMutex<Option<(u64, Vec<u8>)>>,
    asked: StdMutex<Vec<(String, u64, bool)>>,
}
impl Reader for Fake {
    fn list<'a>(&'a self, request: &'a Request) -> ReaderFuture<'a, Listing> {
        self.asked
            .lock()
            .unwrap()
            .push((request.path.clone(), 0, false));
        let answer = self
            .listing
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(Err(ReaderError::Unavailable));
        Box::pin(async move { answer })
    }
    fn read<'a>(
        &'a self,
        request: &'a Request,
        limit: u64,
        partial: bool,
    ) -> ReaderFuture<'a, Read> {
        self.asked
            .lock()
            .unwrap()
            .push((request.path.clone(), limit, partial));
        let file = self.file.lock().unwrap().clone();
        Box::pin(async move {
            let (size, bytes) =
                file.ok_or_else(|| ReaderError::Refused("not_found".into(), None))?;
            if size > limit && !partial {
                return Err(ReaderError::Refused("too_large".into(), Some(size)));
            }
            let length = size.min(limit);
            Ok(Read {
                size,
                length,
                modified_ms: 1_700_000_000_000,
                body: axum::body::Body::from(bytes[..length as usize].to_vec()),
            })
        })
    }
}

fn entry(name: &str, kind: WorkspaceEntryKind) -> WorkspaceEntry {
    WorkspaceEntry {
        name: name.into(),
        kind,
        size: (kind == WorkspaceEntryKind::File).then_some(5),
        modified_ms: 1_700_000_000_000,
        target: (kind == WorkspaceEntryKind::Link).then_some(WorkspaceLinkTarget::Outside),
    }
}

#[tokio::test]
async fn only_the_owner_password_session_reaches_the_folder() {
    let case = case().await;
    let fake = Arc::new(Fake::default());
    let state = case.state.clone().with_workspace_reader(fake.clone());
    let service = "6".repeat(64);
    let service_cookie = "7".repeat(64);
    state
        .store
        .create_service_credential(
            &format!("browser:{}", case.cookie),
            "synthetic-hash",
            "adapter",
            &service,
        )
        .await
        .unwrap()
        .unwrap();
    state
        .store
        .exchange_service_session(&service, &format!("browser:{service_cookie}"))
        .await
        .unwrap()
        .unwrap();
    let auth = case.auth();
    let owner = cookie(&case);
    let service_header = format!("Cookie: orkestr_v2_session={service_cookie}");
    for route in ["", "/preview", "/file"] {
        let path = url(&case, route, "notes.md");
        for headers in [
            vec![],
            vec![auth.as_str()],
            vec![service_header.as_str()],
            vec![owner.as_str(), auth.as_str()],
        ] {
            let reply = get(&state, &path, &headers).await;
            assert_eq!(
                (reply.status, reply.code().as_str()),
                (401, "unauthorized"),
                "{route} {headers:?}"
            );
        }
    }
    // Another owner's or an unknown conversation is not found.
    let other = format!(
        "/api/v2/conversations/{}/workspace?path=",
        uuid::Uuid::new_v4()
    );
    let reply = get(&state, &other, &[&owner]).await;
    assert_eq!((reply.status, reply.code().as_str()), (404, "not_found"));
    assert!(
        fake.asked.lock().unwrap().is_empty(),
        "nothing reached the reader"
    );
    case.finish().await;
}

#[tokio::test]
async fn refused_paths_never_reach_the_reader() {
    let case = case().await;
    let fake = Arc::new(Fake::default());
    let state = case.state.clone().with_workspace_reader(fake.clone());
    let owner = cookie(&case);
    for route in ["", "/preview", "/file"] {
        for (path, status, code) in [
            ("..", 400, "workspace_path_outside"),
            ("docs/../../etc", 400, "workspace_path_outside"),
            ("/etc/passwd", 400, "workspace_path_outside"),
            ("docs//a", 400, "workspace_path_invalid"),
            (".ssh/id_ed25519", 403, "workspace_protected"),
            ("app/.env", 403, "workspace_protected"),
            ("github_token.txt", 403, "workspace_protected"),
            (".codex/auth.json", 403, "workspace_protected"),
        ] {
            let reply = get(&state, &url(&case, route, path), &[&owner]).await;
            assert_eq!(
                (reply.status, reply.code().as_str()),
                (status, code),
                "{route} {path}"
            );
        }
    }
    assert!(fake.asked.lock().unwrap().is_empty());
    case.finish().await;
}

#[tokio::test]
async fn listing_states_and_protected_names_from_a_reader_are_dropped() {
    let case = case().await;
    let owner = cookie(&case);
    // No reader on this host: the panel says so.
    let reply = get(&case.state, &url(&case, "", ""), &[&owner]).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.json()["state"], "not_configured");
    assert!(reply.header("cache-control").unwrap().contains("no-store"));
    let reply = get(&case.state, "/api/v2/health", &[]).await;
    assert!(reply.json()["features"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f == "workspace_files_v1"));
    let fake = Arc::new(Fake::default());
    let state = case.state.clone().with_workspace_reader(fake.clone());
    for (answer, expected) in [
        (Err(ReaderError::NotConfigured), "not_configured"),
        (Err(ReaderError::Unavailable), "unavailable"),
        (
            Err(ReaderError::Refused("root_missing".into(), None)),
            "missing",
        ),
        (
            Err(ReaderError::Refused("root_unreadable".into(), None)),
            "unavailable",
        ),
    ] {
        *fake.listing.lock().unwrap() = Some(answer);
        let reply = get(&state, &url(&case, "", ""), &[&owner]).await;
        assert_eq!(
            (reply.status, reply.json()["state"].as_str()),
            (200, Some(expected))
        );
        assert_eq!(reply.json()["entries"], serde_json::json!([]));
    }
    *fake.listing.lock().unwrap() = Some(Ok(Listing {
        root_kind: WorkspaceRootKind::SharedDefault,
        root_name: "workspace".into(),
        entries: vec![
            entry("docs", WorkspaceEntryKind::Dir),
            entry("notes.md", WorkspaceEntryKind::File),
            entry("escape", WorkspaceEntryKind::Link),
            entry(".env", WorkspaceEntryKind::File),
            entry("api_key.txt", WorkspaceEntryKind::File),
        ],
        hidden: 2,
        truncated: false,
    }));
    let reply = get(&state, &url(&case, "", "docs"), &[&owner]).await;
    assert_eq!(reply.status, 200);
    let value = reply.json();
    assert_eq!(
        (
            value["state"].as_str(),
            value["root_kind"].as_str(),
            value["root_name"].as_str(),
            value["path"].as_str(),
            value["hidden"].as_u64()
        ),
        (
            Some("ready"),
            Some("shared_default"),
            Some("workspace"),
            Some("docs"),
            Some(4)
        )
    );
    let names: Vec<&str> = value["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["docs", "notes.md", "escape"]);
    // A reader refusal maps to a fixed code.
    *fake.listing.lock().unwrap() = Some(Err(ReaderError::Refused("outside_root".into(), None)));
    let reply = get(&state, &url(&case, "", "escape"), &[&owner]).await;
    assert_eq!(
        (reply.status, reply.code().as_str()),
        (403, "workspace_path_outside")
    );
    case.finish().await;
}

#[tokio::test]
async fn previews_are_capped_and_downloads_are_attachments() {
    let case = case().await;
    let owner = cookie(&case);
    let fake = Arc::new(Fake::default());
    let state = case.state.clone().with_workspace_reader(fake.clone());
    // Text: only the first 512 KiB are read.
    let big = WORKSPACE_TEXT_PREVIEW_MAX + 10;
    *fake.file.lock().unwrap() = Some((big, vec![b'a'; big as usize]));
    let reply = get(&state, &url(&case, "/preview", "logs/run.log"), &[&owner]).await;
    assert_eq!(reply.status, 200);
    let value = reply.json();
    assert_eq!(
        (
            value["name"].as_str(),
            value["size"].as_u64(),
            value["preview"]["kind"].as_str(),
            value["preview"]["truncated"].as_bool(),
            value["preview"]["text"].as_str().map(str::len),
            value["downloadable"].as_bool()
        ),
        (
            Some("run.log"),
            Some(big),
            Some("text"),
            Some(true),
            Some(WORKSPACE_TEXT_PREVIEW_MAX as usize),
            Some(true)
        )
    );
    assert_eq!(
        fake.asked.lock().unwrap().last(),
        Some(&("logs/run.log".to_owned(), WORKSPACE_TEXT_PREVIEW_MAX, true))
    );
    // Binary and image files.
    *fake.file.lock().unwrap() = Some((4, vec![0, 159, 146, 150]));
    let reply = get(&state, &url(&case, "/preview", "data.bin"), &[&owner]).await;
    assert_eq!(reply.json()["preview"]["kind"], "binary");
    let reply = get(&state, &url(&case, "/preview", "chart.png"), &[&owner]).await;
    assert_eq!(
        reply.json()["preview"],
        serde_json::json!({"kind": "image", "media_type": "image/png"})
    );
    // An image is shown inline with its type; nothing else is.
    let reply = get(
        &state,
        &format!("{}&inline=true", url(&case, "/file", "chart.png")),
        &[&owner],
    )
    .await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("content-type"), Some("image/png"));
    assert!(reply
        .header("content-disposition")
        .unwrap()
        .starts_with("inline;"));
    assert_eq!(reply.body, vec![0, 159, 146, 150]);
    let reply = get(
        &state,
        &format!("{}&inline=true", url(&case, "/file", "page.html")),
        &[&owner],
    )
    .await;
    assert_eq!(
        (reply.status, reply.code().as_str()),
        (415, "workspace_not_an_image")
    );
    // A download is an attachment with fixed safe headers.
    let reply = get(
        &state,
        &url(&case, "/file", "dir/naïve \"x\".bin"),
        &[&owner],
    )
    .await;
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.header("content-type"),
        Some("application/octet-stream")
    );
    assert_eq!(
        reply.header("content-disposition"),
        Some("attachment; filename=\"download\"; filename*=UTF-8''na%C3%AFve%20%22x%22.bin")
    );
    assert_eq!(reply.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(
        reply.header("content-security-policy"),
        Some("default-src 'none'; sandbox")
    );
    assert_eq!(reply.header("content-length"), Some("4"));
    // Above the download cap: refused, not truncated.
    *fake.file.lock().unwrap() = Some((WORKSPACE_DOWNLOAD_MAX + 1, vec![]));
    let reply = get(&state, &url(&case, "/file", "huge.iso"), &[&owner]).await;
    assert_eq!(
        (reply.status, reply.code().as_str()),
        (413, "workspace_file_too_large")
    );
    case.finish().await;
}

/// The real workspace reader, run by the test's own user on a temporary
/// folder; Core talks to it over its socket exactly as on a host.
struct RealReader {
    child: std::process::Child,
    socket: PathBuf,
}
impl Drop for RealReader {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
async fn real_reader(root: &FsPath, conversation: &ConversationId) -> RealReader {
    let pinned = root.join("pinned");
    std::fs::create_dir_all(&pinned).unwrap();
    std::fs::create_dir_all(root.join("shared")).unwrap();
    let plan = root.join("beta.json");
    let mut pinned_folders = serde_json::Map::new();
    pinned_folders.insert(
        conversation.to_string(),
        serde_json::json!({"path": pinned.to_str().unwrap(), "shared": true}),
    );
    let shared = root.join("shared");
    std::fs::write(
        &plan,
        serde_json::json!({"workspace": shared.to_str().unwrap(),
            "conversation_workspaces": pinned_folders})
        .to_string(),
    )
    .unwrap();
    let socket = root.join("reader.sock");
    let script = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tools/workspace_reader.py"
    );
    let child = std::process::Command::new("python3")
        .args(["-I", "-S", "-B", script, "serve", "--plan"])
        .arg(plan)
        .arg("--peer-uid")
        .arg(rustix::process::getuid().as_raw().to_string())
        .arg("--socket")
        .arg(&socket)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .spawn()
        .expect("python3 runs the workspace reader");
    for _ in 0..200 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(socket.exists(), "the workspace reader started");
    RealReader { child, socket }
}

#[tokio::test]
async fn the_real_reader_confines_every_request_to_the_folder() {
    let case = case().await;
    let owner = cookie(&case);
    let root = std::fs::canonicalize(&case.root).unwrap().join("folders");
    std::fs::create_dir_all(&root).unwrap();
    let reader = real_reader(&root, &case.conversation).await;
    let pinned = root.join("pinned");
    let outside = root.join("outside");
    std::fs::create_dir_all(pinned.join("docs")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("private.txt"), "outside the folder").unwrap();
    std::fs::write(pinned.join("docs/plan.md"), "# Plan\n").unwrap();
    std::fs::write(pinned.join(".env"), "SECRET=1").unwrap();
    std::os::unix::fs::symlink(&outside, pinned.join("escape")).unwrap();
    std::os::unix::fs::symlink(outside.join("private.txt"), pinned.join("escape.txt")).unwrap();
    std::os::unix::fs::symlink(".env", pinned.join("settings")).unwrap();
    std::os::unix::fs::symlink("docs/plan.md", pinned.join("readme")).unwrap();
    // Sparse: above the download cap without writing 25 MiB.
    std::fs::File::create(pinned.join("huge.iso"))
        .unwrap()
        .set_len(WORKSPACE_DOWNLOAD_MAX + 1)
        .unwrap();
    std::fs::write(
        pinned.join("big.log"),
        vec![b'l'; WORKSPACE_TEXT_PREVIEW_MAX as usize + 100],
    )
    .unwrap();
    let state = case
        .state
        .clone()
        .with_workspace_reader(Arc::new(SocketReader::new(reader.socket.clone())));

    let reply = get(&state, &url(&case, "", ""), &[&owner]).await;
    assert_eq!(reply.status, 200);
    let value = reply.json();
    assert_eq!(
        (
            value["state"].as_str(),
            value["root_kind"].as_str(),
            value["root_name"].as_str(),
            value["hidden"].as_u64()
        ),
        (Some("ready"), Some("conversation"), Some("pinned"), Some(2))
    );
    let names: Vec<&str> = value["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(names[0], "docs", "folders first");
    assert!(!names.contains(&".env") && !names.contains(&"settings"));
    let escape = value["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "escape")
        .unwrap();
    assert_eq!(
        (escape["kind"].as_str(), escape["target"].as_str()),
        (Some("link"), Some("outside"))
    );

    // A symlink that leaves the folder is never followed.
    for (route, path) in [
        ("", "escape"),
        ("/preview", "escape/private.txt"),
        ("/file", "escape.txt"),
    ] {
        let reply = get(&state, &url(&case, route, path), &[&owner]).await;
        assert_eq!(
            (reply.status, reply.code().as_str()),
            (403, "workspace_path_outside"),
            "{route} {path}"
        );
        assert!(!String::from_utf8_lossy(&reply.body).contains("outside the folder"));
    }
    // A harmless name linked to a protected file stays protected.
    let reply = get(&state, &url(&case, "/file", "settings"), &[&owner]).await;
    assert_eq!(
        (reply.status, reply.code().as_str()),
        (403, "workspace_protected")
    );
    // An in-folder link opens; previews and downloads stay within their caps.
    let reply = get(&state, &url(&case, "/file", "readme"), &[&owner]).await;
    assert_eq!(
        (reply.status, reply.body.as_slice()),
        (200, b"# Plan\n".as_slice())
    );
    let reply = get(&state, &url(&case, "/preview", "big.log"), &[&owner]).await;
    assert_eq!(
        (
            reply.json()["preview"]["truncated"].as_bool(),
            reply.json()["preview"]["text"].as_str().map(str::len)
        ),
        (Some(true), Some(WORKSPACE_TEXT_PREVIEW_MAX as usize))
    );
    let reply = get(&state, &url(&case, "/file", "huge.iso"), &[&owner]).await;
    assert_eq!(
        (reply.status, reply.code().as_str()),
        (413, "workspace_file_too_large")
    );
    let reply = get(&state, &url(&case, "/file", "missing.txt"), &[&owner]).await;
    assert_eq!(
        (reply.status, reply.code().as_str()),
        (404, "workspace_not_found")
    );
    // A missing folder is a state, not an error.
    std::fs::rename(&pinned, root.join("moved")).unwrap();
    let reply = get(&state, &url(&case, "", ""), &[&owner]).await;
    assert_eq!(
        (reply.status, reply.json()["state"].as_str()),
        (200, Some("missing"))
    );
    drop(reader);
    case.finish().await;
}
