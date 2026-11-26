//! The live channel over real loopback HTTP: WebSocket and event stream,
//! session and Origin checks, change reports, session expiry, replacement
//! and freeing abandoned channels.
use super::*;
use crate::conversation_resources_http::tests::case;
use orkestr_v2_contracts::ConversationInput;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

const HOST: &str = "127.0.0.1:19882";
const ORIGIN: &str = "http://127.0.0.1:19882";
const PATIENCE: Duration = Duration::from_secs(10);

async fn serve(state: &AppState) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = crate::router(state.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (address, server)
}

/// Percent-encodes a watched path for the `w` query parameter.
fn encode(path: &str) -> String {
    path.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn request(address: std::net::SocketAddr, head: &str) -> (TcpStream, u16, String, Vec<u8>) {
    let mut socket = TcpStream::connect(address).await.unwrap();
    socket.write_all(head.as_bytes()).await.unwrap();
    let mut buffer = Vec::new();
    let end = loop {
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break end;
        }
        let mut chunk = [0u8; 4096];
        let n = tokio::time::timeout(PATIENCE, socket.read(&mut chunk))
            .await
            .expect("response head")
            .unwrap();
        assert!(n > 0, "connection closed before the response head");
        buffer.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buffer[..end]).to_string();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let rest = buffer[end + 4..].to_vec();
    (socket, status, head, rest)
}

struct Ws {
    socket: TcpStream,
    buffer: Vec<u8>,
}

async fn websocket(
    address: std::net::SocketAddr,
    path: &str,
    headers: &[&str],
) -> Result<Ws, (u16, String)> {
    let mut head = format!("GET {path} HTTP/1.1\r\nHost: {HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n");
    for header in headers {
        head.push_str(header);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    let (socket, status, head, buffer) = request(address, &head).await;
    if status != 101 {
        return Err((status, head));
    }
    Ok(Ws { socket, buffer })
}

/// One unmasked server frame: (opcode, payload, bytes used).
fn parse(b: &[u8]) -> Option<(u8, Vec<u8>, usize)> {
    if b.len() < 2 {
        return None;
    }
    let (mut length, mut at) = (usize::from(b[1] & 0x7f), 2);
    if length == 126 {
        length = usize::from(u16::from_be_bytes([*b.get(2)?, *b.get(3)?]));
        at = 4;
    } else if length == 127 {
        length = u64::from_be_bytes(b.get(2..10)?.try_into().ok()?) as usize;
        at = 10;
    }
    let payload = b.get(at..at + length)?.to_vec();
    Some((b[0] & 0x0f, payload, at + length))
}

impl Ws {
    /// The next frame, or `None` when the server closed the connection.
    async fn frame(&mut self) -> Option<(u8, Vec<u8>)> {
        loop {
            if let Some((opcode, payload, used)) = parse(&self.buffer) {
                self.buffer.drain(..used);
                return Some((opcode, payload));
            }
            let mut chunk = [0u8; 4096];
            let n = tokio::time::timeout(PATIENCE, self.socket.read(&mut chunk))
                .await
                .expect("a frame in time")
                .ok()?;
            if n == 0 {
                return None;
            }
            self.buffer.extend_from_slice(&chunk[..n]);
        }
    }
    /// The next text frame of type `t`, skipping pings and other frames.
    async fn until(&mut self, t: &str) -> Value {
        loop {
            let (opcode, payload) = self.frame().await.expect("open channel");
            if opcode == 1 {
                let value: Value = serde_json::from_slice(&payload).unwrap();
                if value["t"] == t {
                    return value;
                }
            }
        }
    }
    /// One masked client text frame.
    async fn send(&mut self, text: &str) {
        let payload = text.as_bytes();
        let mask = [0x11u8, 0x22, 0x33, 0x44];
        let mut frame = vec![0x81u8];
        if payload.len() < 126 {
            frame.push(0x80 | payload.len() as u8);
        } else {
            frame.push(0x80 | 126);
            frame.extend((payload.len() as u16).to_be_bytes());
        }
        frame.extend(mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.socket.write_all(&frame).await.unwrap();
    }
}

async fn create(state: &AppState, cookie: &str, name: &str) {
    state
        .store
        .create_conversation_authenticated(
            &format!("browser:{cookie}"),
            &ConversationInput {
                client_request_id: format!("live-{name}"),
                name: name.into(),
            },
        )
        .await
        .unwrap();
}

struct Stream {
    socket: TcpStream,
    seen: Vec<u8>,
}

impl Stream {
    /// Reads until `needle`; returns what came before it.
    async fn until(&mut self, needle: &str) -> String {
        loop {
            if let Some(at) = self
                .seen
                .windows(needle.len())
                .position(|w| w == needle.as_bytes())
            {
                let rest = self.seen.split_off(at + needle.len());
                let before = std::mem::replace(&mut self.seen, rest);
                return String::from_utf8_lossy(&before).to_string();
            }
            let mut chunk = [0u8; 8192];
            let n = tokio::time::timeout(PATIENCE, self.socket.read(&mut chunk))
                .await
                .expect(needle)
                .unwrap();
            assert!(n > 0, "stream closed before {needle}");
            self.seen.extend_from_slice(&chunk[..n]);
        }
    }
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + PATIENCE;
    while !check() {
        assert!(Instant::now() < deadline, "{what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn websocket_reports_watched_reads_and_their_changes() {
    let case = case().await;
    let (address, server) = serve(&case.state).await;
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let origin = format!("Origin: {ORIGIN}");
    let sidebar = "/api/v2/sidebar?include_hidden=true";
    let mut ws = websocket(
        address,
        &format!("/api/v2/live?w={}", encode(sidebar)),
        &[&cookie, &origin],
    )
    .await
    .unwrap();
    let hello = ws.until("hello").await;
    assert_eq!(hello["v"], 1);
    assert_eq!(hello["transport"], "websocket");
    assert_eq!(hello["max_paths"], watch::MAX_PATHS);
    let watching = ws.until("watching").await;
    assert_eq!(watching["paths"][0]["path"], sidebar);
    let first = watching["paths"][0]["fp"].as_str().unwrap().to_owned();
    assert!(
        first.starts_with('~'),
        "the sidebar carries a read time: {first}"
    );

    // More paths over the socket; a non-read route is refused.
    let posts = case.path("/posts?limit=50");
    ws.send(&json!({"t": "watch", "add": [posts, "/api/v2/live"]}).to_string())
        .await;
    let refused = ws.until("refused").await;
    assert_eq!(refused["path"], "/api/v2/live");
    assert_eq!(refused["reason"], "not_watchable");
    let watching = ws.until("watching").await;
    assert_eq!(watching["paths"][0]["path"], posts.as_str());
    // Without read-time samples the fingerprint is the browser's own ETag.
    let read = crate::observability::tests::raw(
        crate::router(case.state.clone()),
        "GET",
        &posts,
        &[&cookie],
    )
    .await;
    assert_eq!(read.status, 200);
    assert_eq!(watching["paths"][0]["fp"], read.headers["etag"].as_str());

    // A committed change is pushed for the sidebar only.
    create(&case.state, &case.cookie, "Pushed").await;
    let changed = ws.until("changed").await;
    let paths = changed["paths"].as_array().unwrap();
    assert_eq!(paths.len(), 1, "{changed}");
    assert_eq!(paths[0]["path"], sidebar);
    assert_ne!(paths[0]["fp"], first.as_str());
    ws.until("hb").await;
    ws.send(r#"{"t":"report","fallback_polls":3,"reconnects":1}"#)
        .await;
    ws.send(r#"{"t":"hb"}"#).await;
    ws.until("hb").await;
    assert_eq!(case.state.live.open(), 1);
    drop(ws);
    eventually("an abandoned WebSocket is freed", || {
        case.state.live.open() == 0
    })
    .await;
    server.abort();
    case.finish().await;
}

#[tokio::test]
async fn channels_need_the_browser_session_and_websockets_their_origin() {
    let case = case().await;
    let (address, server) = serve(&case.state).await;
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let origin = format!("Origin: {ORIGIN}");
    let foreign = "Origin: http://elsewhere.invalid";
    assert_eq!(
        websocket(address, "/api/v2/live", &[&origin])
            .await
            .err()
            .unwrap()
            .0,
        401
    );
    assert_eq!(
        websocket(address, "/api/v2/live", &[&cookie])
            .await
            .err()
            .unwrap()
            .0,
        403,
        "a cookie-bearing upgrade without Origin"
    );
    assert_eq!(
        websocket(address, "/api/v2/live", &[&cookie, foreign])
            .await
            .err()
            .unwrap()
            .0,
        403
    );
    let bearer = case.auth();
    assert_eq!(
        websocket(address, "/api/v2/live", &[&bearer])
            .await
            .err()
            .unwrap()
            .0,
        401,
        "machine credentials do not open a browser channel"
    );
    let (status, _) = crate::conversation_resources_http::tests::send(
        &case.state,
        "GET",
        "/api/v2/live/events",
        &[],
        "",
    )
    .await;
    assert_eq!(status, 401);
    assert_eq!(case.state.live.open(), 0);
    server.abort();
    case.finish().await;
}

#[tokio::test]
async fn event_stream_pads_flushes_reports_changes_and_frees_on_disconnect() {
    let case = case().await;
    let (address, server) = serve(&case.state).await;
    let sidebar = "/api/v2/sidebar";
    let head = format!(
        "GET /api/v2/live/events?w={}&w=%2Fapi%2Fv2%2Flive&resume=1 HTTP/1.1\r\nHost: {HOST}\r\nCookie: orkestr_v2_session={}\r\n\r\n",
        encode(sidebar),
        case.cookie
    );
    let (socket, status, head, seen) = request(address, &head).await;
    assert_eq!(status, 200, "{head}");
    let lower = head.to_ascii_lowercase();
    assert!(lower.contains("content-type: text/event-stream"), "{head}");
    assert!(
        lower.contains("cache-control: no-store, no-transform"),
        "{head}"
    );
    assert!(lower.contains("x-accel-buffering: no"), "{head}");
    let mut stream = Stream { socket, seen };
    let start = stream.until("event: hello").await;
    assert!(
        start.contains(&format!(":{}", " ".repeat(PADDING))),
        "the stream starts with a padding comment"
    );
    stream.until("event: refused").await;
    stream.until("event: watching").await;
    stream.until("event: hb").await;
    create(&case.state, &case.cookie, "Streamed").await;
    stream.until("event: changed").await;
    stream.until(sidebar).await;
    assert_eq!(case.state.live.open(), 1);
    drop(stream);
    // The next heartbeat write fails and the stream's session ends.
    eventually("an abandoned event stream is freed", || {
        case.state.live.open() == 0
    })
    .await;
    server.abort();
    case.finish().await;
}

#[tokio::test]
async fn a_revoked_session_ends_the_channel() {
    let case = case().await;
    let (address, server) = serve(&case.state).await;
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let origin = format!("Origin: {ORIGIN}");
    let mut ws = websocket(address, "/api/v2/live", &[&cookie, &origin])
        .await
        .unwrap();
    ws.until("hello").await;
    case.state
        .store
        .revoke_session(&format!("browser:{}", case.cookie))
        .await
        .unwrap();
    ws.until("expired").await;
    // The server then closes the WebSocket.
    loop {
        match ws.frame().await {
            None | Some((8, _)) => break,
            Some(_) => {}
        }
    }
    eventually("the expired channel is freed", || {
        case.state.live.open() == 0
    })
    .await;
    server.abort();
    case.finish().await;
}

#[test]
fn the_oldest_channel_is_replaced_beyond_the_limit() {
    let hub = Arc::new(Hub::default());
    let mut open: Vec<_> = (0..MAX_CHANNELS).map(|_| hub.register()).collect();
    let newest = hub.register();
    assert_eq!(*open[0].1.borrow(), Some("replaced"));
    assert_eq!(*open[1].1.borrow(), None);
    assert_eq!(*newest.1.borrow(), None);
    assert_eq!(hub.open(), MAX_CHANNELS);
    hub.close_all();
    assert_eq!(*open[1].1.borrow(), Some("shutdown"));
    open.clear();
    assert_eq!(hub.open(), 1);
    drop(newest);
    assert_eq!(hub.open(), 0);
}
