//! Synthetic committed Core time rows and a controllable, read-only V1 peer.
use crate::conversation_resources_http::tests::{case, send, Case};
use crate::*;
use axum::{extract::State, response::IntoResponse};
use orkestr_v2_contracts::{ArchivedImportRequest, ArchivedMessage, ConversationLineage};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
use tokio::sync::{watch, Semaphore};

pub(crate) struct Peer {
    pub calls: AtomicUsize,
    pub gate: Semaphore,
    pub response: Mutex<(u16, Value)>,
    pub paths: Mutex<Vec<String>>,
    started: watch::Sender<usize>,
}
async fn serve(State(peer): State<Arc<Peer>>, request: axum::extract::Request) -> Response {
    assert_eq!(request.method(), axum::http::Method::GET);
    assert_eq!(
        request.headers()[header::AUTHORIZATION],
        "Bearer synthetic-v1-read-token"
    );
    peer.paths.lock().unwrap().push(request.uri().to_string());
    let calls = peer.calls.fetch_add(1, Ordering::SeqCst) + 1;
    peer.started.send_modify(|seen| *seen = (*seen).max(calls));
    peer.gate.acquire().await.unwrap().forget();
    let (status, body) = peer.response.lock().unwrap().clone();
    let status = StatusCode::from_u16(status).unwrap();
    if matches!(status, StatusCode::NO_CONTENT | StatusCode::NOT_MODIFIED) {
        status.into_response()
    } else {
        (status, Json(body)).into_response()
    }
}
impl Peer {
    pub async fn started(&self, count: usize) {
        self.started
            .subscribe()
            .wait_for(|seen| *seen >= count)
            .await
            .unwrap();
    }
}

pub(crate) struct Fixture {
    pub case: Case,
    pub owner: OwnerId,
    pub event: String,
    pub peer: Arc<Peer>,
    pub pool: sqlx::SqlitePool,
    server: tokio::task::JoinHandle<()>,
}
impl Fixture {
    pub async fn new() -> Self {
        let mut case = case().await;
        let owner = case
            .state
            .store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        archive(&case, &owner, "thread-a").await;
        let pool = sqlx::SqlitePool::connect(&format!(
            "sqlite://{}",
            case.root.join("core.sqlite3").display()
        ))
        .await
        .unwrap();
        // A synthetic committed acceptance event; no provider is exercised.
        let sequence: i64 = sqlx::query_scalar(
            "UPDATE conversations SET sequence=sequence+1 WHERE id=? RETURNING sequence",
        )
        .bind(case.conversation.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        let event = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO events(id,owner_id,conversation_id,sequence,kind,schema_version) VALUES(?,?,?,?,'execution_accepted',9)")
            .bind(&event).bind(owner.to_string()).bind(case.conversation.to_string()).bind(sequence).execute(&pool).await.unwrap();
        let (started, _) = watch::channel(0);
        let peer = Arc::new(Peer {
            calls: AtomicUsize::new(0),
            gate: Semaphore::new(0),
            response: Mutex::new((200, ack(&event))),
            paths: Mutex::new(Vec::new()),
            started,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().fallback(serve).with_state(peer.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        case.state.desktop_broker = Some(Arc::new(
            crate::desktop_broker::Broker::new(
                &format!("http://{address}"),
                "synthetic-v1-read-token".into(),
            )
            .unwrap(),
        ));
        Self {
            case,
            owner,
            event,
            peer,
            pool,
            server,
        }
    }
    pub fn request(&self) -> tokio::task::JoinHandle<(u16, Value)> {
        self.request_path(self.case.path("/message-times?after=0&limit=200"))
    }
    pub fn request_path(&self, path: String) -> tokio::task::JoinHandle<(u16, Value)> {
        let state = self.case.state.clone();
        let auth = self.case.auth();
        tokio::spawn(async move { send(&state, "GET", &path, &[&auth], "").await })
    }
    pub async fn page(&self) -> Value {
        let (status, value) = self.request().await.unwrap();
        assert_eq!(status, 200, "{value}");
        value
    }
    pub async fn conditional(&self, tag: Option<&str>) -> (u16, String, Value) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let app = crate::router(self.case.state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        let mut request = format!(
            "GET {} HTTP/1.1\r\nHost: 127.0.0.1:19882\r\nConnection: close\r\n{}\r\n",
            self.case.path("/message-times?after=0&limit=200"),
            self.case.auth()
        );
        if let Some(tag) = tag {
            request.push_str(&format!("If-None-Match: {tag}\r\n"));
        }
        request.push_str("\r\n");
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        socket.read_to_end(&mut bytes).await.unwrap();
        let _ = stop.send(());
        server.await.unwrap();
        let end = bytes.windows(4).position(|v| v == b"\r\n\r\n").unwrap();
        let headers = std::str::from_utf8(&bytes[..end]).unwrap();
        let code = headers
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let etag = headers
            .lines()
            .find_map(|line| {
                line.split_once(':')
                    .filter(|(name, _)| name.eq_ignore_ascii_case("etag"))
                    .map(|(_, v)| v.trim().to_owned())
            })
            .unwrap_or_default();
        let body = if code == 304 {
            Value::Null
        } else {
            crate::desktop_broker::parse_response(&bytes).unwrap().1
        };
        (code, etag, body)
    }
    pub async fn release(&self) {
        self.peer.gate.add_permits(1);
        self.case.state.message_receipts.wait_for_refresh().await;
    }
    pub async fn rebind(&self) {
        archive(&self.case, &self.owner, "thread-b").await;
        self.case
            .state
            .store
            .record_conversation_lineage(
                &self.case.bearer,
                &self.owner,
                &self.case.conversation,
                &ConversationLineage {
                    source_instance: "synthetic-v1".into(),
                    source_thread_id: "thread-b".into(),
                    source_parent_thread_id: None,
                },
            )
            .await
            .unwrap();
    }
    pub async fn foreign_conversation(&self) -> ConversationId {
        let owner = OwnerId(Uuid::new_v4());
        let conversation = ConversationId(Uuid::new_v4());
        // Only bypass singleton setup in this synthetic fixture, restoring
        // the CHECK before exercising the real owner authorization path.
        let mut connection = self.pool.acquire().await.unwrap();
        sqlx::query("PRAGMA ignore_check_constraints=ON")
            .execute(&mut *connection)
            .await
            .unwrap();
        sqlx::query("INSERT INTO owners(id,username,password_hash,singleton) VALUES(?,'synthetic-foreign-owner','synthetic-hash',2)").bind(owner.to_string()).execute(&mut *connection).await.unwrap();
        sqlx::query("PRAGMA ignore_check_constraints=OFF")
            .execute(&mut *connection)
            .await
            .unwrap();
        let checks: i64 = sqlx::query_scalar("PRAGMA ignore_check_constraints")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        assert_eq!(checks, 0);
        sqlx::query("INSERT INTO conversations(id,owner_id) VALUES(?,?)")
            .bind(conversation.to_string())
            .bind(owner.to_string())
            .execute(&mut *connection)
            .await
            .unwrap();
        conversation
    }
    pub async fn finish(self) {
        self.server.abort();
        let _ = self.server.await;
        self.pool.close().await;
        self.case.finish().await;
    }
}

pub(crate) async fn archive(case: &Case, owner: &OwnerId, thread: &str) {
    case.state
        .store
        .import_archived_history(
            &case.bearer,
            owner,
            &case.conversation,
            &ArchivedImportRequest {
                source_instance: "synthetic-v1".into(),
                source_thread_id: thread.into(),
                snapshot_id: format!("snapshot-{thread}"),
                messages: vec![ArchivedMessage {
                    source_message_id: format!("{thread}-message"),
                    source_position: 1,
                    source_cursor: 1,
                    role: "user".into(),
                    phase: None,
                    state: Some("completed".into()),
                    source_kind: None,
                    created_at: None,
                    updated_at: None,
                    text: "Synthetic archived message".into(),
                    attachments: vec![],
                }],
            },
        )
        .await
        .unwrap();
}
pub(crate) fn ack(event: &str) -> Value {
    json!({"messages":[{"role":"assistant","connector":"whatsapp","deliveryState":"delivered",
        "deliveredAt":"2026-01-02T15:42:10.000Z","whatsappMessageIds":["synthetic"],
        "remoteBackend":"rust-v2","remoteMessageId":event,
        "remoteMirrorAck":{"outcome":"delivered","acknowledgedAt":"2026-01-02T15:42:20.000Z"}}]})
}
