//! A minimal HTTP/1.1 client for a credential store on a loopback address.
//!
//! One request per connection (`Connection: close`), plain HTTP only. That is
//! why the address must be loopback: a token never crosses a network in the
//! clear. Bodies end at `Content-Length`, at the last chunk of a chunked
//! response, or when the store closes the connection. Answers are capped in
//! size and time; nothing here logs a header or a body.
use std::net::SocketAddr;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The largest answer read from the store.
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
const MAX_HEAD: usize = 16 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HttpError {
    Unreachable,
    Timeout,
    Malformed,
    TooLarge,
}

/// `http://127.0.0.1:8200` (or `[::1]`, `localhost`) to a socket address.
/// Anything else, including `https://` or a non-loopback host, is refused.
pub(crate) fn loopback_address(url: &str) -> Option<SocketAddr> {
    let rest = url.strip_prefix("http://")?.trim_end_matches('/');
    if rest.is_empty() || rest.contains(['/', '?', '#', '@']) {
        return None;
    }
    let rest = match rest.strip_prefix("localhost:") {
        Some(port) => format!("127.0.0.1:{port}"),
        None => rest.to_owned(),
    };
    let address: SocketAddr = rest.parse().ok()?;
    (address.ip().is_loopback() && address.port() != 0).then_some(address)
}

pub(crate) struct Answer {
    pub(crate) status: u16,
    pub(crate) body: Vec<u8>,
}

pub(crate) async fn request(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<(&str, &[u8])>,
    timeout: Duration,
) -> Result<Answer, HttpError> {
    tokio::time::timeout(timeout, exchange(address, method, path, headers, body))
        .await
        .map_err(|_| HttpError::Timeout)?
}

async fn exchange(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<(&str, &[u8])>,
) -> Result<Answer, HttpError> {
    if !path.starts_with('/') || path.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return Err(HttpError::Malformed);
    }
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\nAccept: application/json\r\n");
    for (name, value) in headers {
        if value.bytes().any(|b| b == b'\r' || b == b'\n') {
            return Err(HttpError::Malformed);
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    match body {
        Some((kind, bytes)) => head.push_str(&format!(
            "Content-Type: {kind}\r\nContent-Length: {}\r\n\r\n",
            bytes.len()
        )),
        None => head.push_str("Content-Length: 0\r\n\r\n"),
    }
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .map_err(|_| HttpError::Unreachable)?;
    let mut out = head.into_bytes();
    if let Some((_, bytes)) = body {
        out.extend_from_slice(bytes);
    }
    let written = stream.write_all(&out).await;
    out.fill(0);
    written.map_err(|_| HttpError::Unreachable)?;
    let mut raw = Vec::new();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let read = stream
            .read(&mut buffer)
            .await
            .map_err(|_| HttpError::Unreachable)?;
        if read == 0 {
            break;
        }
        if raw.len() + read > MAX_RESPONSE + MAX_HEAD {
            return Err(HttpError::TooLarge);
        }
        raw.extend_from_slice(&buffer[..read]);
        if let Some(done) = complete(&raw)? {
            return Ok(done);
        }
    }
    parse(&raw, true)
}

/// A whole answer once its body is complete; `None` while more is expected.
fn complete(raw: &[u8]) -> Result<Option<Answer>, HttpError> {
    match parse(raw, false) {
        Ok(answer) => Ok(Some(answer)),
        Err(HttpError::Malformed) if !has_head(raw) && raw.len() <= MAX_HEAD => Ok(None),
        Err(HttpError::Malformed) if has_head(raw) && !framing_broken(raw) => Ok(None),
        Err(error) => Err(error),
    }
}

fn has_head(raw: &[u8]) -> bool {
    raw.windows(4).any(|w| w == b"\r\n\r\n")
}

/// The head itself is invalid, as opposed to a body that has not arrived yet.
fn framing_broken(raw: &[u8]) -> bool {
    let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else {
        return false;
    };
    head(&raw[..end]).is_none()
}

struct Head {
    status: u16,
    length: Option<usize>,
    chunked: bool,
}

fn head(bytes: &[u8]) -> Option<Head> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.split("\r\n");
    let status_line = lines.next()?;
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next()?;
    if !version.starts_with("HTTP/1.") {
        return None;
    }
    let status: u16 = parts.next()?.parse().ok()?;
    if !(100..=599).contains(&status) {
        return None;
    }
    let (mut length, mut chunked) = (None, false);
    for line in lines {
        let (name, value) = line.split_once(':')?;
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            let parsed: usize = value.parse().ok()?;
            if length.is_some_and(|l| l != parsed) {
                return None;
            }
            length = Some(parsed);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value.eq_ignore_ascii_case("chunked");
            if !chunked {
                return None;
            }
        }
    }
    if chunked && length.is_some() {
        return None;
    }
    Some(Head {
        status,
        length,
        chunked,
    })
}

/// Parses a buffered answer. `closed`: the store has closed the connection,
/// so a body without framing ends here.
fn parse(raw: &[u8], closed: bool) -> Result<Answer, HttpError> {
    let end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or(HttpError::Malformed)?;
    if end > MAX_HEAD {
        return Err(HttpError::TooLarge);
    }
    let head = head(&raw[..end]).ok_or(HttpError::Malformed)?;
    let rest = &raw[end + 4..];
    let body = if head.chunked {
        dechunk(rest)?
    } else if let Some(length) = head.length {
        if length > MAX_RESPONSE {
            return Err(HttpError::TooLarge);
        }
        if rest.len() < length {
            return Err(HttpError::Malformed);
        }
        rest[..length].to_vec()
    } else if closed || [204, 304].contains(&head.status) {
        rest.to_vec()
    } else {
        return Err(HttpError::Malformed);
    };
    if body.len() > MAX_RESPONSE {
        return Err(HttpError::TooLarge);
    }
    Ok(Answer {
        status: head.status,
        body,
    })
}

fn dechunk(mut rest: &[u8]) -> Result<Vec<u8>, HttpError> {
    let mut body = Vec::new();
    loop {
        let line_end = rest
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or(HttpError::Malformed)?;
        let size_text = std::str::from_utf8(&rest[..line_end]).map_err(|_| HttpError::Malformed)?;
        let size_text = size_text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| HttpError::Malformed)?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Ok(body);
        }
        if size > MAX_RESPONSE || body.len() + size > MAX_RESPONSE {
            return Err(HttpError::TooLarge);
        }
        if rest.len() < size + 2 || &rest[size..size + 2] != b"\r\n" {
            return Err(HttpError::Malformed);
        }
        body.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_loopback_addresses_are_accepted() {
        assert_eq!(
            loopback_address("http://127.0.0.1:8200"),
            Some("127.0.0.1:8200".parse().unwrap())
        );
        assert_eq!(
            loopback_address("http://localhost:8200/"),
            Some("127.0.0.1:8200".parse().unwrap())
        );
        assert!(loopback_address("http://[::1]:8200").is_some());
        for refused in [
            "https://127.0.0.1:8200",
            "http://10.0.0.5:8200",
            "http://vault.example.invalid:8200",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://user@127.0.0.1:8200",
            "http://127.0.0.1:8200/v1",
            "127.0.0.1:8200",
        ] {
            assert_eq!(loopback_address(refused), None, "{refused}");
        }
    }

    #[test]
    fn bodies_end_at_their_length_their_last_chunk_or_the_close() {
        let fixed = parse(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}extra",
            false,
        )
        .ok()
        .unwrap();
        assert_eq!((fixed.status, fixed.body.as_slice()), (200, &b"{}"[..]));
        let chunked = parse(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{\"a\r\n4;x=1\r\n\":1}\r\n0\r\n\r\n",
            false,
        )
        .ok()
        .unwrap();
        assert_eq!(chunked.body, b"{\"a\":1}");
        let closed = parse(b"HTTP/1.0 404 Not Found\r\n\r\n{\"errors\":[]}", true)
            .ok()
            .unwrap();
        assert_eq!(closed.status, 404);
        let empty = parse(b"HTTP/1.1 204 No Content\r\n\r\n", false)
            .ok()
            .unwrap();
        assert!(empty.body.is_empty());
    }

    #[test]
    fn incomplete_answers_wait_and_broken_ones_fail() {
        assert!(complete(b"HTTP/1.1 200 OK\r\nContent-Le")
            .unwrap()
            .is_none());
        assert!(complete(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n{}")
            .unwrap()
            .is_none());
        assert!(
            complete(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{}")
                .unwrap()
                .is_none()
        );
        for broken in [
            &b"SMTP 220 hello\r\n\r\n"[..],
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n",
            b"HTTP/1.1 999 Odd\r\n\r\n",
        ] {
            assert!(
                complete(broken).is_err(),
                "{:?}",
                String::from_utf8_lossy(broken)
            );
        }
        assert_eq!(
            parse(
                b"HTTP/1.1 200 OK\r\nContent-Length: 99999999\r\n\r\n",
                false
            )
            .err(),
            Some(HttpError::TooLarge)
        );
    }

    #[tokio::test]
    async fn a_request_reaches_a_loopback_listener_and_reads_its_answer() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut seen = Vec::new();
            let mut buffer = [0u8; 1024];
            while !seen.windows(2).any(|w| w == b"{}") {
                let n = socket.read(&mut buffer).await.unwrap();
                seen.extend_from_slice(&buffer[..n]);
            }
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n",
                )
                .await
                .unwrap();
            String::from_utf8(seen).unwrap()
        });
        let answer = request(
            address,
            "POST",
            "/v1/x",
            &[("X-Test", "1")],
            Some(("application/json", b"{}")),
            Duration::from_secs(5),
        )
        .await
        .ok()
        .unwrap();
        assert_eq!((answer.status, answer.body.as_slice()), (200, &b"ok"[..]));
        let seen = server.await.unwrap();
        assert!(seen.starts_with("POST /v1/x HTTP/1.1\r\n"));
        assert!(seen.contains("X-Test: 1\r\n") && seen.contains("Content-Length: 2\r\n"));
        assert!(request(
            address,
            "GET",
            "/v1/x",
            &[("X", "a\r\nb")],
            None,
            Duration::from_secs(1)
        )
        .await
        .is_err());
    }
}
