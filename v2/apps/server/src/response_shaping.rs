//! API response shaping: a weak `ETag` on successful JSON reads with
//! `304 Not Modified` for a matching `If-None-Match` (poll loops re-read the
//! same page every few seconds), and gzip for JSON bodies when the client
//! accepts it. Server-sent event streams and other bodies pass untouched.
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::Request,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use sha2::{Digest, Sha256};
use std::io::Write;

/// Bodies below this are sent as they are; gzip would not pay off.
const COMPRESS_MIN: usize = 1024;
/// API JSON is bounded well below this; anything larger passes untouched.
const BUFFER_MAX: usize = 16 * 1024 * 1024;
/// Compress large bodies off the async worker threads.
const INLINE_MAX: usize = 256 * 1024;

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"application/json"))
}

/// `Accept-Encoding` lists gzip with a non-zero quality.
pub(crate) fn accepts_gzip(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|item| {
            let mut parts = item.split(';').map(str::trim);
            let coding = parts.next().unwrap_or("");
            let zero = parts.any(|p| {
                p.strip_prefix("q=")
                    .and_then(|q| q.parse::<f32>().ok())
                    .is_some_and(|q| q <= 0.0)
            });
            (coding.eq_ignore_ascii_case("gzip") || coding == "*") && !zero
        })
}

pub(crate) fn etag(body: &[u8]) -> HeaderValue {
    let digest = Sha256::digest(body);
    let hex: String = digest[..12].iter().map(|b| format!("{b:02x}")).collect();
    HeaderValue::from_str(&format!("W/\"{hex}\"")).expect("hex etag")
}

/// Weak comparison (RFC 9110 §13.1.2) against a comma-separated list.
pub(crate) fn none_match(headers: &HeaderMap, tag: &HeaderValue) -> bool {
    let opaque = |v: &str| v.trim().trim_start_matches("W/").to_owned();
    let ours = opaque(tag.to_str().unwrap_or(""));
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|candidate| candidate.trim() == "*" || opaque(candidate) == ours)
}

pub(crate) fn gzip(body: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = flate2::write::GzEncoder::new(
        Vec::with_capacity(body.len() / 4),
        flate2::Compression::new(5),
    );
    encoder.write_all(body).ok()?;
    encoder.finish().ok()
}

pub(crate) async fn shape(request: Request, next: Next) -> Response {
    let read = matches!(*request.method(), Method::GET | Method::HEAD);
    let gzip_ok = accepts_gzip(request.headers());
    let conditions = read.then(|| request.headers().clone());
    let response = next.run(request).await;
    if !is_json(response.headers()) || response.headers().contains_key(header::CONTENT_ENCODING) {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = to_bytes(body, BUFFER_MAX).await else {
        return super::Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "response_unavailable",
            "Response could not be prepared",
        )
        .into_response();
    };
    if parts.status == StatusCode::OK {
        if let Some(conditions) = &conditions {
            let tag = etag(&bytes);
            if none_match(conditions, &tag) {
                let mut headers = parts.headers.clone();
                headers.remove(header::CONTENT_TYPE);
                headers.remove(header::CONTENT_LENGTH);
                headers.insert(header::ETAG, tag);
                let mut not_modified = Response::new(Body::empty());
                *not_modified.status_mut() = StatusCode::NOT_MODIFIED;
                *not_modified.headers_mut() = headers;
                return not_modified;
            }
            parts.headers.insert(header::ETAG, tag);
        }
    }
    parts
        .headers
        .append(header::VARY, HeaderValue::from_static("accept-encoding"));
    let body = if gzip_ok && bytes.len() >= COMPRESS_MIN {
        let compressed = if bytes.len() > INLINE_MAX {
            let raw = bytes.clone();
            tokio::task::spawn_blocking(move || gzip(&raw))
                .await
                .ok()
                .flatten()
        } else {
            gzip(&bytes)
        };
        match compressed {
            Some(compressed) if compressed.len() < bytes.len() => {
                parts
                    .headers
                    .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
                Bytes::from(compressed)
            }
            _ => bytes,
        }
    } else {
        bytes
    };
    parts.headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&body.len().to_string()).expect("length"),
    );
    Response::from_parts(parts, Body::from(body))
}

#[cfg(test)]
#[path = "response_shaping_tests.rs"]
mod tests;
