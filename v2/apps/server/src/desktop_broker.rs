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
        let (status, value) = self
            .send("POST", &format!("/api/desktops/{slug}/acquire"), Some(body))
            .await?;
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

    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), BrokerError> {
        tokio::time::timeout(TIMEOUT, self.exchange(method, path, body))
            .await
            .map_err(|_| BrokerError::Unavailable)?
    }

    async fn exchange(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), BrokerError> {
        let payload = body.map(|b| b.to_string()).unwrap_or_default();
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: {}\r\n",
            self.host, self.token, payload.len()
        );
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
            .take(RESPONSE_MAX as u64 + 1)
            .read_to_end(&mut raw)
            .await
            .map_err(|_| BrokerError::Unavailable)?;
        if raw.len() > RESPONSE_MAX {
            return Err(BrokerError::Unavailable);
        }
        parse_response(&raw).ok_or(BrokerError::Unavailable)
    }
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
