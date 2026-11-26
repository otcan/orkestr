//! Browser live channel (`docs/v2/live-channel.md`): one server-to-browser
//! channel per tab that says which watched reads changed, so the browser
//! refetches only then instead of polling. `GET /api/v2/live` is the
//! WebSocket; `GET /api/v2/live/events` is the server-sent events fallback
//! for networks that refuse the upgrade. Both need the same browser session
//! cookie and Host as every polled read, and every watched path is read with
//! that session, so a channel only reports on what the session may read.
mod protocol;
mod session;
#[cfg(test)]
mod tests;
mod watch;

use crate::{observability::Observer, AppState, Error};
use axum::{
    extract::{
        rejection::QueryRejection,
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{
        sse::{Event, Sse},
        IntoResponse, Response,
    },
    routing::get,
    Router,
};
use protocol::{ClientFrame, CLIENT_FRAME_MAX, HEARTBEAT};
use session::{Reason, Session};
use std::{
    collections::VecDeque,
    convert::Infallible,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch as signal, Semaphore};

/// Channels open at once; a new one replaces the oldest (a tab that went
/// away behind a proxy can leave its stream open for minutes).
const MAX_CHANNELS: usize = 16;
/// Fingerprint reads running at once across all channels.
const READS: usize = 2;
/// The server ends a WebSocket after this; the browser reconnects at once.
const WEBSOCKET_LIFETIME: Duration = Duration::from_secs(3600);
/// Event streams end sooner: behind a buffering proxy the server cannot tell
/// whether anybody still reads them.
const SSE_LIFETIME: Duration = Duration::from_secs(300);
/// A WebSocket with no frame or pong from the browser for this long is dead.
const IDLE: Duration = Duration::from_secs(45);
/// Each write must finish within this, otherwise the channel closes.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Leading comment that pushes the first frames through proxies that
/// buffer the start of a response.
const PADDING: usize = 2048;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v2/live", get(websocket))
        .route("/api/v2/live/events", get(events))
}

/// Registered channels, for the replacement limit and server-side closes.
pub(crate) struct Hub {
    channels: Mutex<VecDeque<(u64, signal::Sender<Option<Reason>>)>>,
    next: AtomicU64,
    pub(crate) reads: Semaphore,
}

impl Default for Hub {
    fn default() -> Self {
        Self {
            channels: Mutex::default(),
            next: AtomicU64::new(1),
            reads: Semaphore::new(READS),
        }
    }
}

pub(crate) struct Registration {
    hub: Arc<Hub>,
    id: u64,
}

impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut channels) = self.hub.channels.lock() {
            channels.retain(|(id, _)| *id != self.id);
        }
    }
}

impl Hub {
    fn register(self: &Arc<Self>) -> (Registration, signal::Receiver<Option<Reason>>) {
        let (sender, receiver) = signal::channel(None);
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut channels) = self.channels.lock() {
            while channels.len() >= MAX_CHANNELS {
                if let Some((_, oldest)) = channels.pop_front() {
                    let _ = oldest.send(Some("replaced"));
                }
            }
            channels.push_back((id, sender));
        }
        (
            Registration {
                hub: self.clone(),
                id,
            },
            receiver,
        )
    }
    /// Asks every open channel to close (server shutdown).
    pub(crate) fn close_all(&self) {
        if let Ok(channels) = self.channels.lock() {
            for (_, channel) in channels.iter() {
                let _ = channel.send(Some("shutdown"));
            }
        }
    }
    #[cfg(test)]
    pub(crate) fn open(&self) -> usize {
        self.channels.lock().map(|c| c.len()).unwrap_or(0)
    }
}

/// An authenticated channel request.
pub(crate) struct Opening {
    /// Only what the watched reads need: `Host` and `Cookie`.
    headers: HeaderMap,
    channel: String,
    transport: &'static str,
    paths: Vec<String>,
    lifetime: Duration,
    resumed: bool,
}

impl Opening {
    async fn authenticate(
        state: &AppState,
        headers: &HeaderMap,
        query: Result<Query<Vec<(String, String)>>, QueryRejection>,
        transport: &'static str,
    ) -> Result<Self, Error> {
        // The same browser session check as every polled read.
        crate::browser::owner(state, headers).await?;
        crate::browser::credential(headers)?;
        // A browser always sends Origin on a WebSocket; a cookie-bearing
        // upgrade from any other origin is cross-site WebSocket hijacking.
        if transport == "websocket"
            && headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
                != Some(state.origin.as_str())
        {
            return Err(Error(
                StatusCode::FORBIDDEN,
                "origin_rejected",
                "Origin rejected",
            ));
        }
        let Query(pairs) = query.map_err(|_| {
            Error(
                StatusCode::BAD_REQUEST,
                "invalid_live_request",
                "Invalid live channel request",
            )
        })?;
        let mut paths = Vec::new();
        let (mut resumed, mut polls, mut reconnects) = (false, 0, 0);
        for (key, value) in pairs.into_iter().take(4 * watch::MAX_PATHS) {
            match key.as_str() {
                "w" if !paths.contains(&value) => paths.push(value),
                "resume" => resumed = value == "1",
                "fallback_polls" => polls = value.parse().unwrap_or(0),
                "reconnects" => reconnects = value.parse().unwrap_or(0),
                _ => {}
            }
        }
        Observer::global().metrics.live.reported(polls, reconnects);
        let mut kept = HeaderMap::new();
        for name in [header::HOST, header::COOKIE] {
            for value in headers.get_all(&name) {
                kept.append(name.clone(), value.clone());
            }
        }
        Ok(Self {
            headers: kept,
            channel: uuid::Uuid::new_v4().simple().to_string(),
            transport,
            paths,
            lifetime: if transport == "websocket" {
                WEBSOCKET_LIFETIME
            } else {
                SSE_LIFETIME
            },
            resumed,
        })
    }
}

fn session_reason(result: Result<Reason, tokio::task::JoinError>) -> Reason {
    result.unwrap_or("shutdown")
}

async fn websocket(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<Vec<(String, String)>>, QueryRejection>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, Error> {
    let opening = Opening::authenticate(&state, &headers, query, "websocket").await?;
    Ok(upgrade
        .max_message_size(CLIENT_FRAME_MAX)
        .max_frame_size(CLIENT_FRAME_MAX)
        // Every frame is written out at once, never held back for batching.
        .write_buffer_size(0)
        .on_upgrade(move |socket| serve_websocket(state, opening, socket)))
}

async fn write(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(WRITE_TIMEOUT, socket.send(message)).await,
        Ok(Ok(()))
    )
}

async fn serve_websocket(state: AppState, opening: Opening, mut socket: WebSocket) {
    let live = &Observer::global().metrics.live;
    live.opened("websocket", opening.resumed);
    let hub = state.live.clone();
    let (registration, closing) = hub.register();
    let (to_session, inbound) = mpsc::channel(16);
    let (out, mut frames) = mpsc::channel(32);
    let mut session =
        tokio::spawn(Session::new(state, hub.clone(), opening).run(inbound, out, closing));
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
    let mut seen = Instant::now();
    let reason: Reason = loop {
        tokio::select! {
            frame = frames.recv() => {
                let Some(frame) = frame else {
                    break session_reason((&mut session).await);
                };
                live.frame(frame.kind());
                let last = frame.last();
                if !write(&mut socket, Message::text(frame.json())).await {
                    break "write_error";
                }
                if last {
                    break session_reason((&mut session).await);
                }
            }
            message = socket.recv() => match message {
                Some(Ok(Message::Text(text))) => {
                    seen = Instant::now();
                    match serde_json::from_str::<ClientFrame>(text.as_str()) {
                        // Never wait on the session here (it may be waiting on
                        // this loop to write): a browser that floods frames is
                        // closed instead.
                        Ok(frame) => match to_session.try_send(frame) {
                            Ok(()) => {}
                            Err(mpsc::error::TrySendError::Full(_)) => break "protocol",
                            Err(mpsc::error::TrySendError::Closed(_)) => {
                                break session_reason((&mut session).await)
                            }
                        },
                        Err(_) => break "protocol",
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => seen = Instant::now(),
                Some(Ok(Message::Binary(_))) => break "protocol",
                Some(Ok(Message::Close(_)) | Err(_)) | None => break "client",
            },
            _ = ping.tick() => {
                if seen.elapsed() > IDLE {
                    break "idle";
                }
                if !write(&mut socket, Message::Ping(axum::body::Bytes::from_static(b"hb"))).await {
                    break "write_error";
                }
            }
        }
    };
    session.abort();
    drop(registration);
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Close(None))).await;
    live.closed("websocket", reason);
}

/// Ends the event stream's session when hyper drops the body (the browser
/// or a proxy went away, or a write failed).
struct StreamGuard {
    session: tokio::task::JoinHandle<Reason>,
    _registration: Registration,
    _inbound: mpsc::Sender<ClientFrame>,
    reason: Option<Reason>,
}

impl StreamGuard {
    /// The stream ended on its own: its session's reason is the close reason.
    async fn finish(&mut self) {
        self.reason = Some(session_reason((&mut self.session).await));
    }
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.session.abort();
        Observer::global()
            .metrics
            .live
            .closed("sse", self.reason.unwrap_or("write_error"));
    }
}

async fn events(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<Vec<(String, String)>>, QueryRejection>,
) -> Result<Response, Error> {
    let opening = Opening::authenticate(&state, &headers, query, "sse").await?;
    let live = &Observer::global().metrics.live;
    live.opened("sse", opening.resumed);
    let hub = state.live.clone();
    let (registration, closing) = hub.register();
    let (to_session, inbound) = mpsc::channel(1);
    let (out, mut frames) = mpsc::channel(32);
    let session = tokio::spawn(Session::new(state, hub, opening).run(inbound, out, closing));
    let mut guard = StreamGuard {
        session,
        _registration: registration,
        _inbound: to_session,
        reason: None,
    };
    let stream = async_stream::stream! {
        yield Ok::<Event, Infallible>(Event::default().comment(" ".repeat(PADDING)));
        while let Some(frame) = frames.recv().await {
            live.frame(frame.kind());
            yield Ok(Event::default().event(frame.kind()).data(frame.json()));
        }
        guard.finish().await;
    };
    let mut response = Sse::new(stream).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-transform"),
    );
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}
