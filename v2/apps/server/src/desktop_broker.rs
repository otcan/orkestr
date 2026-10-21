//! Minimal client for the V1 desktop lease broker on IPv4 loopback. V1 stays
//! the lease authority; this client only forwards acquire/heartbeat/release
//! for the bound V1 thread and reads that thread's V1 desktop grants. The
//! operator credential comes from a private file and is never logged.
use orkestr_v2_store_sqlite::V1LeaseGrant;
use serde_json::{json, Value};
use std::{net::SocketAddrV4, path::Path, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TIMEOUT: Duration = Duration::from_secs(3);
const RESPONSE_MAX: usize = 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// V1 admits input before it answers; a busy V1 can take a few seconds.
const WRITE_TIMEOUT: Duration = Duration::from_secs(12);
/// V1 acquire prepares the desktop (8-20 s observed for `pa`) before it
/// answers. A same-thread acquire renews the same lease, so a retry after a
/// timeout never creates a second one.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrokerError {
    /// V1 refused: another thread holds the desktop (409 desktop_leased).
    Leased,
    /// V1 no longer recognises the lease or token (stale fence, expired, forced).
    Lost,
    /// V1 policy denied the thread (403) or the grant is missing.
    Denied,
    /// Transport failure, timeout or unexpected response.
    Unavailable,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    v1_url: String,
    bearer_token: String,
}

pub(crate) struct Broker {
    address: SocketAddrV4,
    host: String,
    token: String,
}

impl Broker {
    /// `{"v1_url":"http://127.0.0.1:PORT","bearer_token":"..."}` in a private
    /// (0600, service-user-owned) regular file.
    pub(crate) fn load(path: &Path) -> Result<Self, &'static str> {
        use std::os::unix::fs::MetadataExt;
        let meta =
            std::fs::symlink_metadata(path).map_err(|_| "desktop broker config unreadable")?;
        if !meta.file_type().is_file() || meta.mode() & 0o077 != 0 || meta.uid() != current_uid() {
            return Err("desktop broker config must be a private regular file");
        }
        let raw = std::fs::read(path).map_err(|_| "desktop broker config unreadable")?;
        let config: FileConfig =
            serde_json::from_slice(&raw).map_err(|_| "desktop broker config invalid")?;
        Self::new(&config.v1_url, config.bearer_token)
    }

    pub(crate) fn new(url: &str, token: String) -> Result<Self, &'static str> {
        let rest = url
            .strip_prefix("http://")
            .ok_or("desktop broker must be http on IPv4 loopback")?;
        let address: SocketAddrV4 = rest
            .trim_end_matches('/')
            .parse()
            .map_err(|_| "desktop broker must be http on IPv4 loopback")?;
        if !address.ip().is_loopback() || address.port() == 0 {
            return Err("desktop broker must be http on IPv4 loopback");
        }
        if token.len() < 16 || token.len() > 512 || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("desktop broker token invalid");
        }
        Ok(Self {
            host: address.to_string(),
            address,
            token,
        })
    }

    /// Slugs V1 grants to the thread (`GET /api/threads/:id/desktop-grants`).
    pub(crate) async fn granted_slugs(&self, thread: &str) -> Result<Vec<String>, BrokerError> {
        let (status, body) = self
            .send(
                "GET",
                &format!("/api/threads/{thread}/desktop-grants"),
                None,
            )
            .await?;
        match status {
            200 => {}
            403 | 404 => return Err(BrokerError::Denied),
            _ => return Err(BrokerError::Unavailable),
        }
        let grants = body
            .get("grants")
            .and_then(Value::as_array)
            .ok_or(BrokerError::Unavailable)?;
        Ok(grants
            .iter()
            .filter(|g| {
                g.get("permissions")
                    .and_then(Value::as_array)
                    .is_none_or(|p| p.iter().any(|p| p == "acquire"))
            })
            .filter_map(|g| {
                g.get("desktopSlug")
                    .or_else(|| g.get("resourceKey"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect())
    }

    pub(crate) async fn acquire(
        &self,
        thread: &str,
        slug: &str,
        ttl_ms: u64,
        purpose: Option<&str>,
        conversation: &str,
    ) -> Result<V1LeaseGrant, BrokerError> {
        let body = json!({
            "threadId": thread, "mode": "exclusive", "ttlMs": ttl_ms,
            "purpose": purpose.unwrap_or("orkestr-v2"),
            "metadata": {"orkestrV2ConversationId": conversation},
        });
        let (status, value) = tokio::time::timeout(
            ACQUIRE_TIMEOUT,
            self.exchange(
                "POST",
                &format!("/api/desktops/{slug}/acquire"),
                Some(body),
                RESPONSE_MAX,
            ),
        )
        .await
        .map_err(|_| BrokerError::Unavailable)??;
        match status {
            200 | 201 => {}
            409 => return Err(BrokerError::Leased),
            400 | 403 | 404 => return Err(BrokerError::Denied),
            _ => return Err(BrokerError::Unavailable),
        }
        let lease = value.get("lease").ok_or(BrokerError::Unavailable)?;
        if lease.get("threadId").and_then(Value::as_str) != Some(thread)
            || lease.get("desktopSlug").and_then(Value::as_str) != Some(slug)
        {
            return Err(BrokerError::Unavailable);
        }
        Ok(V1LeaseGrant {
            lease_id: lease
                .get("id")
                .and_then(Value::as_str)
                .ok_or(BrokerError::Unavailable)?
                .to_owned(),
            fencing_token: lease
                .get("fencingToken")
                .and_then(Value::as_str)
                .ok_or(BrokerError::Unavailable)?
                .to_owned(),
            fencing_version: lease
                .get("fencingVersion")
                .and_then(Value::as_i64)
                .ok_or(BrokerError::Unavailable)?,
            expires_at: lease
                .get("expiresAt")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }

    pub(crate) async fn heartbeat(
        &self,
        thread: &str,
        slug: &str,
        token: &str,
    ) -> Result<(), BrokerError> {
        let body = json!({"threadId": thread, "fencingToken": token});
        self.fenced(&format!("/api/desktops/{slug}/heartbeat"), body)
            .await
    }

    pub(crate) async fn release(
        &self,
        thread: &str,
        slug: &str,
        token: &str,
        reason: &str,
    ) -> Result<(), BrokerError> {
        let body = json!({"threadId": thread, "fencingToken": token, "reason": reason});
        self.fenced(&format!("/api/desktops/{slug}/release"), body)
            .await
    }

    /// V1 maps a stale token and a missing lease to 404 and another thread's
    /// lease to 409; both mean this holder lost the lease.
    async fn fenced(&self, path: &str, body: Value) -> Result<(), BrokerError> {
        match self.send("POST", path, Some(body)).await?.0 {
            200 | 201 => Ok(()),
            404 | 409 => Err(BrokerError::Lost),
            403 => Err(BrokerError::Denied),
            _ => Err(BrokerError::Unavailable),
        }
    }

    /// Read-only V1 GET for the sidebar (thread registry, recent messages).
    /// Larger responses than the lease routes; same loopback credential.
    pub(crate) async fn read(&self, path: &str, cap: usize) -> Result<(u16, Value), BrokerError> {
        tokio::time::timeout(READ_TIMEOUT, self.exchange("GET", path, None, cap))
            .await
            .map_err(|_| BrokerError::Unavailable)?
    }

    /// Owner write forwarded to V1 (thread input). The caller supplies the
    /// idempotency key in the body, so a timeout is retried, never guessed.
    pub(crate) async fn write(
        &self,
        method: &str,
        path: &str,
        body: Value,
        cap: usize,
    ) -> Result<(u16, Value), BrokerError> {
        self.write_within(WRITE_TIMEOUT, method, path, body, cap)
            .await
    }

    /// [`Self::write`] with an explicit deadline, for V1 operations that wait
    /// on WhatsApp (group creation takes well over the default).
    pub(crate) async fn write_within(
        &self,
        deadline: Duration,
        method: &str,
        path: &str,
        body: Value,
        cap: usize,
    ) -> Result<(u16, Value), BrokerError> {
        tokio::time::timeout(deadline, self.exchange(method, path, Some(body), cap))
            .await
            .map_err(|_| BrokerError::Unavailable)?
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), BrokerError> {
        tokio::time::timeout(TIMEOUT, self.exchange(method, path, body, RESPONSE_MAX))
            .await
            .map_err(|_| BrokerError::Unavailable)?
    }

    async fn exchange(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        cap: usize,
    ) -> Result<(u16, Value), BrokerError> {
        let started = std::time::Instant::now();
        let result = self.exchange_once(method, path, body, cap).await;
        let status = result.as_ref().map_or(0, |(status, _)| *status);
        crate::observability::upstream("v1", route_template(method, path), status, started);
        result
    }

    async fn exchange_once(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        cap: usize,
    ) -> Result<(u16, Value), BrokerError> {
        let payload = body.map(|b| b.to_string()).unwrap_or_default();
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: {}\r\n",
            self.host, self.token, payload.len()
        );
        // Correlates V1's logs with this request; ids are plain [A-Za-z0-9._-].
        if let Some(id) = crate::observability::request_id() {
            request.push_str(&format!("X-Request-Id: {id}\r\n"));
        }
        if !payload.is_empty() {
            request.push_str("Content-Type: application/json\r\n");
        }
        request.push_str("\r\n");
        request.push_str(&payload);
        let mut socket = tokio::net::TcpStream::connect(self.address)
            .await
            .map_err(|_| BrokerError::Unavailable)?;
        socket
            .write_all(request.as_bytes())
            .await
            .map_err(|_| BrokerError::Unavailable)?;
        let mut raw = Vec::new();
        socket
            .take(cap as u64 + 1)
            .read_to_end(&mut raw)
            .await
            .map_err(|_| BrokerError::Unavailable)?;
        if raw.len() > cap {
            return Err(BrokerError::Unavailable);
        }
        // The thread registry is megabytes of JSON: parse it off the async workers.
        if raw.len() > PARSE_INLINE_MAX {
            return tokio::task::spawn_blocking(move || parse_response(&raw))
                .await
                .ok()
                .flatten()
                .ok_or(BrokerError::Unavailable);
        }
        parse_response(&raw).ok_or(BrokerError::Unavailable)
    }
}

const PARSE_INLINE_MAX: usize = 256 * 1024;

/// `METHOD /path/{id}/…` without query or identifiers, for logs and metrics.
pub(crate) fn route_template(method: &str, path: &str) -> String {
    let path = path.split('?').next().unwrap_or("");
    let mut previous = "";
    let segments: Vec<&str> = path
        .split('/')
        .map(|segment| {
            let keep = !matches!(previous, "threads" | "desktops") || segment == "summary";
            previous = segment;
            if keep {
                segment
            } else {
                "{id}"
            }
        })
        .collect();
    format!("{method} {}", segments.join("/"))
}

fn current_uid() -> u32 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata("/proc/self")
        .map(|m| m.uid())
        .unwrap_or(u32::MAX)
}

/// HTTP/1.1 response with Content-Length, chunked or close-delimited body.
pub(crate) fn parse_response(raw: &[u8]) -> Option<(u16, Value)> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let mut body = raw[split + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next()?.split(' ').nth(1)?.parse().ok()?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let header = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    if header("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) {
        let mut out = Vec::new();
        let mut rest = body.as_slice();
        loop {
            let end = rest.windows(2).position(|w| w == b"\r\n")?;
            let size = usize::from_str_radix(
                std::str::from_utf8(&rest[..end])
                    .ok()?
                    .split(';')
                    .next()?
                    .trim(),
                16,
            )
            .ok()?;
            rest = &rest[end + 2..];
            if size == 0 {
                break;
            }
            out.extend_from_slice(rest.get(..size)?);
            rest = rest.get(size + 2..)?;
        }
        body = out;
    } else if let Some(length) = header("content-length") {
        body.truncate(length.parse().ok()?);
    }
    let value = if body.iter().all(u8::is_ascii_whitespace) {
        Value::Null
    } else {
        serde_json::from_slice(&body).ok()?
    };
    Some((status, value))
}

#[cfg(test)]
mod acquire_timeout_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A V1 that answers acquire only after `delay` (like a slow `pa` desk).
    async fn slow_v1(delay: Duration) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0u8; 8192];
            let _ = socket.read(&mut buffer).await.unwrap();
            tokio::time::sleep(delay).await;
            let body = serde_json::json!({"lease": {"id": "lease-1", "threadId": "thread-1",
                "desktopSlug": "pa", "fencingToken": "fence-1", "fencingVersion": 3,
                "expiresAt": "2026-10-21T15:00:00Z"}})
            .to_string();
            let response = format!(
                "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        address
    }

    #[tokio::test]
    async fn slow_v1_acquire_is_awaited_past_the_ordinary_request_timeout() {
        // Longer than the 3 s ordinary request bound, well inside 45 s.
        let address = slow_v1(TIMEOUT + Duration::from_secs(2)).await;
        let broker = Broker::new(&format!("http://{address}"), "t".repeat(32)).unwrap();
        let grant = broker
            .acquire("thread-1", "pa", 600_000, Some("test"), "conversation")
            .await
            .unwrap();
        assert_eq!(
            (grant.lease_id.as_str(), grant.fencing_version),
            ("lease-1", 3)
        );
    }
}
