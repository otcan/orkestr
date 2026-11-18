//! Core's side of the workspace reader (`v2/tools/workspace_reader.py`): one
//! JSON request line over a Unix socket, one JSON reply line, then exactly
//! `length` raw bytes for a read. Core names a conversation, its provider and
//! a relative path, never a folder; the reader resolves and confines it.
use axum::body::{Body, Bytes};
use orkestr_v2_contracts::{
    ConversationId, ConversationProvider, WorkspaceEntry, WorkspaceRootKind, WORKSPACE_LIST_MAX,
};
use serde::Deserialize;
use serde_json::json;
use std::{future::Future, path::PathBuf, pin::Pin, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

/// Where Core looks for the reader when `ORKESTR_V2_WORKSPACE_READER_SOCKET`
/// names no other socket. No socket there: this host shows no folder.
pub(crate) const DEFAULT_SOCKET: &str = "/run/orkestr-workspace-reader/reader.sock";
pub(crate) const SOCKET_ENV: &str = "ORKESTR_V2_WORKSPACE_READER_SOCKET";
const CONNECT: Duration = Duration::from_secs(2);
const REPLY: Duration = Duration::from_secs(8);
const IDLE: Duration = Duration::from_secs(15);
const REQUEST_MAX: usize = 8192;
/// A full listing of `WORKSPACE_LIST_MAX` long names stays well below this.
const HEADER_MAX: u64 = 2 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Request {
    pub conversation: ConversationId,
    pub provider: ConversationProvider,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Listing {
    pub root_kind: WorkspaceRootKind,
    pub root_name: String,
    pub entries: Vec<WorkspaceEntry>,
    pub hidden: u32,
    pub truncated: bool,
}

pub(crate) struct Read {
    /// The whole file's size.
    pub size: u64,
    /// Bytes in `body` (less than `size` only for a partial read).
    pub length: u64,
    pub modified_ms: i64,
    pub body: Body,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReaderError {
    /// No reader on this host.
    NotConfigured,
    /// The reader did not answer or broke the protocol.
    Unavailable,
    /// The reader refused: its stable code, and a file's size for `too_large`.
    Refused(String, Option<u64>),
}

pub(crate) type ReaderFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ReaderError>> + Send + 'a>>;

/// The swappable reading side. The socket reader is the real one; tests use
/// a fake. Every implementation enforces confinement and protected names.
pub(crate) trait Reader: Send + Sync {
    fn list<'a>(&'a self, request: &'a Request) -> ReaderFuture<'a, Listing>;
    fn read<'a>(
        &'a self,
        request: &'a Request,
        limit: u64,
        partial: bool,
    ) -> ReaderFuture<'a, Read>;
}

pub(crate) struct SocketReader {
    path: PathBuf,
}

impl SocketReader {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub(crate) fn from_env() -> Self {
        let path = std::env::var_os(SOCKET_ENV)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| PathBuf::from(DEFAULT_SOCKET));
        Self::new(path)
    }

    fn request(request: &Request, op: &str) -> serde_json::Value {
        json!({"version": 1, "op": op, "conversation_id": request.conversation,
               "provider": request.provider.as_str(), "path": request.path})
    }

    /// Send one request and read the reply line. The stream stays positioned
    /// at the first body byte.
    async fn exchange(
        &self,
        request: serde_json::Value,
    ) -> Result<(serde_json::Value, BufReader<UnixStream>), ReaderError> {
        use std::os::unix::fs::FileTypeExt;
        match std::fs::symlink_metadata(&self.path) {
            Ok(meta) if meta.file_type().is_socket() => {}
            Ok(_) => return Err(ReaderError::Unavailable),
            Err(_) => return Err(ReaderError::NotConfigured),
        }
        let mut line = serde_json::to_vec(&request).map_err(|_| ReaderError::Unavailable)?;
        line.push(b'\n');
        if line.len() > REQUEST_MAX {
            return Err(ReaderError::Refused("invalid_path".into(), None));
        }
        let stream = tokio::time::timeout(CONNECT, UnixStream::connect(&self.path))
            .await
            .map_err(|_| ReaderError::Unavailable)?
            .map_err(|_| ReaderError::Unavailable)?;
        let mut stream = BufReader::new(stream);
        let mut header = Vec::new();
        let exchanged = tokio::time::timeout(REPLY, async {
            stream.get_mut().write_all(&line).await?;
            let read = (&mut stream)
                .take(HEADER_MAX)
                .read_until(b'\n', &mut header)
                .await?;
            Ok::<usize, std::io::Error>(read)
        })
        .await;
        match exchanged {
            Ok(Ok(_)) if header.last() == Some(&b'\n') => {}
            _ => return Err(ReaderError::Unavailable),
        }
        let value: serde_json::Value =
            serde_json::from_slice(&header).map_err(|_| ReaderError::Unavailable)?;
        match value["ok"].as_bool() {
            Some(true) => Ok((value, stream)),
            Some(false) => match value["error"].as_str() {
                Some(code)
                    if !code.is_empty()
                        && code.len() <= 64
                        && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') =>
                {
                    Err(ReaderError::Refused(code.into(), value["size"].as_u64()))
                }
                _ => Err(ReaderError::Unavailable),
            },
            None => Err(ReaderError::Unavailable),
        }
    }
}

#[derive(Deserialize)]
struct ListReply {
    entries: Vec<WorkspaceEntry>,
    hidden: u32,
    truncated: bool,
    root_kind: WorkspaceRootKind,
    root_name: String,
}

#[derive(Deserialize)]
struct ReadReply {
    size: u64,
    length: u64,
    modified_ms: i64,
}

/// Exactly `length` bytes from the reader; a short or stalled body ends the
/// response with an error instead of passing as a whole file.
fn body(mut stream: BufReader<UnixStream>, length: u64) -> Body {
    Body::from_stream(async_stream::stream! {
        let mut left = length;
        let mut buffer = vec![0_u8; CHUNK];
        while left > 0 {
            let want = usize::try_from(left).map_or(CHUNK, |left| left.min(CHUNK));
            match tokio::time::timeout(IDLE, stream.read(&mut buffer[..want])).await {
                Ok(Ok(0)) => {
                    yield Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "workspace reader closed early"));
                    return;
                }
                Ok(Ok(read)) => {
                    left -= read as u64;
                    yield Ok::<Bytes, std::io::Error>(Bytes::copy_from_slice(&buffer[..read]));
                }
                Ok(Err(error)) => {
                    yield Err(error);
                    return;
                }
                Err(_) => {
                    yield Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "workspace reader stalled"));
                    return;
                }
            }
        }
    })
}

impl Reader for SocketReader {
    fn list<'a>(&'a self, request: &'a Request) -> ReaderFuture<'a, Listing> {
        Box::pin(async move {
            let (value, _) = self.exchange(Self::request(request, "list")).await?;
            let reply: ListReply =
                serde_json::from_value(value).map_err(|_| ReaderError::Unavailable)?;
            if reply.entries.len() > WORKSPACE_LIST_MAX
                || reply.root_name.is_empty()
                || reply.root_name.contains('/')
            {
                return Err(ReaderError::Unavailable);
            }
            Ok(Listing {
                root_kind: reply.root_kind,
                root_name: reply.root_name,
                entries: reply.entries,
                hidden: reply.hidden,
                truncated: reply.truncated,
            })
        })
    }

    fn read<'a>(
        &'a self,
        request: &'a Request,
        limit: u64,
        partial: bool,
    ) -> ReaderFuture<'a, Read> {
        Box::pin(async move {
            let mut message = Self::request(request, "read");
            message["limit"] = json!(limit);
            message["partial"] = json!(partial);
            let (value, stream) = self.exchange(message).await?;
            let reply: ReadReply =
                serde_json::from_value(value).map_err(|_| ReaderError::Unavailable)?;
            if reply.length > limit
                || reply.length > reply.size
                || (!partial && reply.length != reply.size)
            {
                return Err(ReaderError::Unavailable);
            }
            Ok(Read {
                size: reply.size,
                length: reply.length,
                modified_ms: reply.modified_ms,
                body: body(stream, reply.length),
            })
        })
    }
}
