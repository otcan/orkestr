//! What a live channel may watch and how a watched path is fingerprinted.
//!
//! A browser names the exact GET paths it would otherwise poll. Only the
//! read-only routes below are accepted. The server reads a path the way the
//! browser would (same router, same cookie and Host, so the same owner and
//! session checks) and keeps a fingerprint of the answer; the browser
//! refetches only when the fingerprint changes. Read-time samples
//! (`observed_at_ms`, `queue_age_ms`, `generated_at_ms`) do not count as a
//! change except on the host metrics routes, which are samples themselves.
use axum::{
    body::{to_bytes, Body},
    http::{header, HeaderMap, Method, Request, StatusCode},
    Router,
};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tower::ServiceExt;

/// Watched paths per channel.
pub(crate) const MAX_PATHS: usize = 32;
/// Longest accepted path (a 50-id conversation-status read is about 1.9 KB).
pub(crate) const MAX_PATH_LEN: usize = 2048;
/// Largest answer that is fingerprinted; larger ones count as unreadable.
const BODY_MAX: usize = 4 * 1024 * 1024;
const VOLATILE: [&str; 3] = ["observed_at_ms", "queue_age_ms", "generated_at_ms"];

/// Read-only routes under `/api/v2/conversations/{id}` a channel may watch.
const CONVERSATION_ROUTES: [&str; 14] = [
    "",
    "/execution",
    "/fast/execution",
    "/intelligence",
    "/worker-tasks",
    "/workers",
    "/held-inputs",
    "/posts",
    "/message-times",
    "/window",
    "/window/queue",
    "/v1-workers",
    "/updates",
    "/accepted-results",
];

/// Owner-wide read-only routes a channel may watch, with how often the
/// server re-reads them without any committed change (their answer also
/// depends on V1, host samples or files outside the store).
const GLOBAL_ROUTES: [(&str, Duration); 10] = [
    ("/api/v2/sidebar", Duration::from_secs(10)),
    ("/api/v2/conversation-status", Duration::from_secs(30)),
    ("/api/v2/host-metrics", Duration::from_secs(15)),
    ("/api/v2/host-metrics/consumers", Duration::from_secs(15)),
    ("/api/v2/host-metrics/disks", Duration::from_secs(60)),
    ("/api/v2/host-metrics/history", Duration::from_secs(30)),
    ("/api/v2/provider-quotas", Duration::from_secs(60)),
    ("/api/v2/sites", Duration::from_secs(60)),
    ("/api/v2/live-map", Duration::from_secs(10)),
    ("/api/v2/resources", Duration::from_secs(15)),
];
/// Re-read period of every other watchable route.
const DEFAULT_FLOOR: Duration = Duration::from_secs(30);
/// Conversation routes that read V1 state.
const V1_FLOOR: Duration = Duration::from_secs(10);

fn uuid(segment: &str) -> bool {
    segment.len() == 36 && uuid::Uuid::parse_str(segment).is_ok_and(|id| !id.is_nil())
}

/// Whether `path` (path and query, as the browser fetches it) may be
/// watched, and if so how often it is re-read without a committed change.
pub(crate) fn floor(path: &str) -> Option<Duration> {
    if path.len() > MAX_PATH_LEN
        || !path.starts_with("/api/v2/")
        || path
            .bytes()
            .any(|b| b.is_ascii_control() || b == b' ' || b == b'#')
    {
        return None;
    }
    let route = path.split_once('?').map_or(path, |(route, _)| route);
    if route.contains("//") || route.contains("/.") {
        return None;
    }
    if let Some((_, floor)) = GLOBAL_ROUTES.iter().find(|(r, _)| *r == route) {
        return Some(*floor);
    }
    if let Some(rest) = route.strip_prefix("/api/v2/timers/") {
        return uuid(rest).then_some(DEFAULT_FLOOR);
    }
    let rest = route.strip_prefix("/api/v2/conversations/")?;
    let (id, suffix) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    if !uuid(id) || !CONVERSATION_ROUTES.contains(&suffix) {
        return None;
    }
    Some(if suffix == "/v1-workers" {
        V1_FLOOR
    } else {
        DEFAULT_FLOOR
    })
}

/// What one read answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Answer {
    pub fp: String,
    /// `fp` is exactly the weak `ETag` the browser receives for the same read.
    pub exact: bool,
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)[..12]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn strip(value: &mut serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            let mut removed = false;
            for key in VOLATILE {
                removed |= map.remove(key).is_some();
            }
            for child in map.values_mut() {
                removed |= strip(child);
            }
            removed
        }
        serde_json::Value::Array(items) => items.iter_mut().fold(false, |r, v| strip(v) | r),
        _ => false,
    }
}

/// The fingerprint of one answer: the weak `ETag` of a successful read unless
/// read-time samples had to be left out, otherwise `<status>:<digest>`.
pub(crate) fn fingerprint(path: &str, status: StatusCode, body: &[u8]) -> Answer {
    if status == StatusCode::OK && !path.starts_with("/api/v2/host-metrics") {
        if let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(body) {
            if strip(&mut value) {
                let canonical = serde_json::to_vec(&value).unwrap_or_default();
                return Answer {
                    fp: format!("~{}", digest(&canonical)),
                    exact: false,
                };
            }
        }
    }
    if status == StatusCode::OK {
        let tag = crate::response_shaping::etag(body);
        return Answer {
            fp: tag.to_str().unwrap_or_default().to_owned(),
            exact: true,
        };
    }
    Answer {
        fp: format!("{}:{}", status.as_u16(), digest(body)),
        exact: false,
    }
}

/// Reads `path` through `router` with only the browser's `Host` and `Cookie`.
pub(crate) async fn read(router: &Router, headers: &HeaderMap, path: &str) -> Option<Answer> {
    let mut request = Request::builder()
        .method(Method::GET)
        .uri(path)
        .body(Body::empty())
        .ok()?;
    for name in [header::HOST, header::COOKIE] {
        for value in headers.get_all(&name) {
            request.headers_mut().append(name.clone(), value.clone());
        }
    }
    let response = router.clone().oneshot(request).await.ok()?;
    let status = response.status();
    let body = to_bytes(response.into_body(), BODY_MAX).await.ok()?;
    Some(fingerprint(path, status, &body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_read_routes_are_watchable() {
        let id = "00000000-0000-4000-8000-000000000001";
        for path in [
            "/api/v2/sidebar?include_hidden=true".to_owned(),
            format!("/api/v2/conversation-status?ids={id}"),
            format!("/api/v2/conversations/{id}?after=7&limit=1"),
            format!("/api/v2/conversations/{id}/execution"),
            format!("/api/v2/conversations/{id}/execution?run_id={id}"),
            format!("/api/v2/conversations/{id}/worker-tasks?parent_run_id={id}"),
            format!("/api/v2/conversations/{id}/posts?limit=50"),
            format!("/api/v2/timers/{id}"),
            "/api/v2/host-metrics".to_owned(),
        ] {
            assert!(floor(&path).is_some(), "{path}");
        }
        for path in [
            "/api/v2/live".to_owned(),
            "/api/v2/live/events".to_owned(),
            format!("/api/v2/conversations/{id}/events"),
            format!("/api/v2/conversations/{id}/payloads/{id}"),
            format!("/api/v2/conversations/{id}/stop"),
            "/api/v2/conversations/not-a-uuid/execution".to_owned(),
            "/api/v2/conversations/00000000-0000-0000-0000-000000000000/execution".to_owned(),
            "/api/v2/sidebar/../browser/session".to_owned(),
            "/api/v2//sidebar".to_owned(),
            "/api/v2/sidebar ".to_owned(),
            "https://example.invalid/api/v2/sidebar".to_owned(),
            format!("/api/v2/sidebar?{}", "a".repeat(MAX_PATH_LEN)),
        ] {
            assert!(floor(&path).is_none(), "{path}");
        }
        assert_eq!(
            floor(&format!("/api/v2/conversations/{id}/v1-workers")),
            Some(V1_FLOOR)
        );
    }

    #[test]
    fn fingerprints_match_etags_unless_samples_are_left_out() {
        let body = br#"{"a":1}"#;
        let plain = fingerprint("/api/v2/sites", StatusCode::OK, body);
        assert!(plain.exact);
        assert_eq!(
            plain.fp,
            crate::response_shaping::etag(body).to_str().unwrap()
        );
        let first = fingerprint(
            "/api/v2/sidebar",
            StatusCode::OK,
            br#"{"observed_at_ms":1,"entries":[{"x":1,"queue_age_ms":3}]}"#,
        );
        let second = fingerprint(
            "/api/v2/sidebar",
            StatusCode::OK,
            br#"{"observed_at_ms":2,"entries":[{"x":1,"queue_age_ms":9}]}"#,
        );
        assert!(!first.exact);
        assert_eq!(first, second, "read-time samples are not changes");
        let changed = fingerprint(
            "/api/v2/sidebar",
            StatusCode::OK,
            br#"{"observed_at_ms":2,"entries":[{"x":2}]}"#,
        );
        assert_ne!(first.fp, changed.fp);
        // Host metrics are samples: a new sample time is a change.
        let a = fingerprint(
            "/api/v2/host-metrics",
            StatusCode::OK,
            br#"{"observed_at_ms":1}"#,
        );
        let b = fingerprint(
            "/api/v2/host-metrics",
            StatusCode::OK,
            br#"{"observed_at_ms":2}"#,
        );
        assert!(a.exact && b.exact);
        assert_ne!(a.fp, b.fp);
        let failed = fingerprint("/api/v2/sidebar", StatusCode::UNAUTHORIZED, b"{}");
        assert!(failed.fp.starts_with("401:") && !failed.exact);
    }
}
