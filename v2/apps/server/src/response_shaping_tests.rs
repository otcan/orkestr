use super::*;
use crate::observability::tests::raw;
use axum::{middleware, routing::get, Json, Router};
use std::io::Read;

fn app() -> Router {
    let big = serde_json::json!({"entries": vec!["synthetic sidebar row"; 400]});
    Router::new()
        .route("/big", get(move || async move { Json(big.clone()) }))
        .route(
            "/small",
            get(|| async { Json(serde_json::json!({"ok": true})) }),
        )
        .route("/text", get(|| async { "x".repeat(4096) }))
        .route(
            "/missing",
            get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"code": "not_found"})),
                )
            }),
        )
        .layer(middleware::from_fn(shape))
}

fn gunzip(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(body)
        .read_to_end(&mut out)
        .unwrap();
    out
}

#[tokio::test]
async fn json_reads_get_a_validator_and_unchanged_polls_get_304() {
    let first = raw(app(), "GET", "/big", &[]).await;
    assert_eq!(first.status, 200);
    let tag = first.headers["etag"].clone();
    assert!(tag.starts_with("W/\""));
    assert!(!first.headers.contains_key("content-encoding"));
    let again = raw(app(), "GET", "/big", &[&format!("If-None-Match: {tag}")]).await;
    assert_eq!(again.status, 304);
    assert!(again.body.is_empty());
    assert_eq!(again.headers["etag"], tag);
    let listed = raw(
        app(),
        "GET",
        "/big",
        &[&format!("If-None-Match: \"other\", {tag}")],
    )
    .await;
    assert_eq!(listed.status, 304);
    let changed = raw(app(), "GET", "/big", &["If-None-Match: W/\"stale\""]).await;
    assert_eq!(changed.status, 200);
    assert_eq!(changed.body, first.body);
    // Errors are never validated or turned into 304.
    let missing = raw(app(), "GET", "/missing", &["If-None-Match: *"]).await;
    assert_eq!(missing.status, 404);
    assert!(!missing.headers.contains_key("etag"));
}

#[tokio::test]
async fn json_is_gzipped_only_when_accepted_and_worth_it() {
    let plain = raw(app(), "GET", "/big", &[]).await;
    let zipped = raw(app(), "GET", "/big", &["Accept-Encoding: br, gzip;q=0.8"]).await;
    assert_eq!(zipped.headers["content-encoding"], "gzip");
    assert_eq!(zipped.headers["vary"], "accept-encoding");
    assert!(zipped.body.len() * 5 < plain.body.len());
    assert_eq!(gunzip(&zipped.body), plain.body);
    // Same validator for both codings: it names the JSON, weakly.
    assert_eq!(zipped.headers["etag"], plain.headers["etag"]);
    let refused = raw(
        app(),
        "GET",
        "/big",
        &["Accept-Encoding: gzip;q=0, identity"],
    )
    .await;
    assert!(!refused.headers.contains_key("content-encoding"));
    let small = raw(app(), "GET", "/small", &["Accept-Encoding: gzip"]).await;
    assert!(!small.headers.contains_key("content-encoding"));
    // Non-JSON bodies (and so event streams) pass untouched.
    let text = raw(app(), "GET", "/text", &["Accept-Encoding: gzip"]).await;
    assert!(!text.headers.contains_key("content-encoding") && !text.headers.contains_key("etag"));
}
