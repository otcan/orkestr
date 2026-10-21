//! Optional immutable static snapshot; never reads request-selected filesystem paths.
mod cache;
#[cfg(test)]
mod cache_http_tests;
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    Router,
};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read},
    path::Path,
    sync::Arc,
};

const MAX_FILE: usize = 8 * 1024 * 1024;
const MAX_TOTAL: usize = 64 * 1024 * 1024;
struct Asset {
    content_type: &'static str,
    data: Bytes,
    etag: HeaderValue,
    /// gzip representation, compressed once at startup, with its own tag.
    gzip: Option<(Bytes, HeaderValue)>,
}
/// Text and WebAssembly compress well; images and fonts already are.
fn compressible(content_type: &str) -> bool {
    content_type.starts_with("text/")
        || content_type.starts_with("application/json")
        || content_type == "application/wasm"
        || content_type == "image/svg+xml"
}
impl Asset {
    fn new(content_type: &'static str, data: Bytes) -> Self {
        let etag = cache::etag(&data);
        let gzip = (compressible(content_type) && data.len() >= 1024)
            .then(|| crate::response_shaping::gzip(&data))
            .flatten()
            // Keep it only when it saves at least a tenth.
            .filter(|gz| gz.len() * 10 < data.len() * 9)
            .map(|gz| {
                let tag = cache::gzip_etag(&etag);
                (Bytes::from(gz), tag)
            });
        Self {
            content_type,
            data,
            etag,
            gzip,
        }
    }
}
type Assets = BTreeMap<String, Asset>;

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid or oversized UI distribution",
    )
}
fn mime(path: &Path) -> Option<&'static str> {
    Some(match path.extension()?.to_str()? {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => return None,
    })
}
fn load(
    root: &Path,
    directory: &Path,
    depth: usize,
    assets: &mut Assets,
    total: &mut usize,
) -> io::Result<()> {
    if depth > 16 {
        return Err(invalid());
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(invalid)?;
        if name.starts_with('.') || name.contains(['%', '\\']) {
            return Err(invalid());
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(invalid());
        }
        let path = entry.path();
        if kind.is_dir() {
            load(root, &path, depth + 1, assets, total)?;
        } else if kind.is_file() {
            let Some(content_type) = mime(&path) else {
                continue;
            };
            if assets.len() >= 4096 {
                return Err(invalid());
            }
            let mut data = Vec::new();
            fs::File::open(&path)?
                .take((MAX_FILE + 1) as u64)
                .read_to_end(&mut data)?;
            *total = total.checked_add(data.len()).ok_or_else(invalid)?;
            if data.len() > MAX_FILE || *total > MAX_TOTAL {
                return Err(invalid());
            }
            let relative = path.strip_prefix(root).map_err(|_| invalid())?;
            let key = format!("/{}", relative.to_str().ok_or_else(invalid)?);
            if key == "/api" || key.starts_with("/api/") {
                return Err(invalid());
            }
            assets.insert(key, Asset::new(content_type, Bytes::from(data)));
        } else {
            return Err(invalid());
        }
    }
    Ok(())
}
fn respond(method: Method, uri: Uri, request_headers: &HeaderMap, assets: &Assets) -> Response {
    let path = uri.path();
    if path == "/api" || path.starts_with("/api/") {
        return super::Error(StatusCode::NOT_FOUND, "not_found", "Endpoint not found")
            .into_response();
    }
    if method != Method::GET && method != Method::HEAD {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            [(header::ALLOW, "GET, HEAD")],
        )
            .into_response();
    }
    if path.contains(['%', '\\']) || path.split('/').any(|part| part == "." || part == "..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let key = if path == "/" { "/index.html" } else { path };
    let Some(asset) = assets.get(key) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let gzip = asset
        .gzip
        .as_ref()
        .filter(|_| crate::response_shaping::accepts_gzip(request_headers));
    let (data, etag) = match gzip {
        Some((data, etag)) => (data, etag),
        None => (&asset.data, &asset.etag),
    };
    let unchanged = cache::unchanged(request_headers, etag);
    let mut response = Response::new(if method == Method::HEAD || unchanged {
        Body::empty()
    } else {
        Body::from(data.clone())
    });
    if unchanged {
        *response.status_mut() = StatusCode::NOT_MODIFIED;
    }
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, asset.content_type.parse().unwrap());
    // For HEAD/304 this is the selected representation length, never a payload
    // length of zero. Setting it also prevents middleware synthesizing zero.
    headers.insert(
        header::CONTENT_LENGTH,
        data.len().to_string().parse().unwrap(),
    );
    headers.insert(header::ETAG, etag.clone());
    if asset.gzip.is_some() {
        headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    if gzip.is_some() {
        headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }
    // `?v=<first 16 hex of the content digest>` (written by the UI bundle
    // into index.html) names this exact content: it may be kept for good.
    let pinned = uri
        .query()
        .and_then(|q| q.strip_prefix("v="))
        .is_some_and(|v| {
            v.len() == 16
                && asset
                    .etag
                    .to_str()
                    .is_ok_and(|tag| tag.trim_matches('"').starts_with(v))
        });
    headers.insert(
        header::CACHE_CONTROL,
        if pinned { cache::PINNED } else { cache::POLICY }
            .parse()
            .unwrap(),
    );
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}
/// Load only an explicitly configured absolute, trusted build directory at startup.
/// The operator must prevent concurrent modification while the snapshot is loaded.
pub fn with_static_ui(router: Router, dist: &Path) -> io::Result<Router> {
    if !dist.is_absolute() {
        return Err(invalid());
    }
    let root = dist.canonicalize()?;
    if !root.is_dir() {
        return Err(invalid());
    }
    let mut assets = Assets::new();
    load(&root, &root, 0, &mut assets, &mut 0)?;
    if !assets.contains_key("/index.html") {
        return Err(invalid());
    }
    let assets = Arc::new(assets);
    Ok(
        router.fallback(move |method: Method, uri: Uri, headers: HeaderMap| {
            let assets = assets.clone();
            async move { respond(method, uri, &headers, &assets) }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn assets() -> Assets {
        BTreeMap::from([(
            "/index.html".into(),
            Asset::new("text/html; charset=utf-8", Bytes::from_static(b"UI")),
        )])
    }
    #[test]
    fn wasm_is_loaded_and_served_with_correct_content_type() {
        struct OwnedDirectory(std::path::PathBuf);
        impl Drop for OwnedDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let directory = OwnedDirectory(
            std::env::temp_dir().join(format!("orkestr-static-test-{}", uuid::Uuid::new_v4())),
        );
        fs::create_dir(&directory.0).unwrap();
        let wasm = b"\0asm\x01\0\0\0";
        fs::write(directory.0.join("app.wasm"), wasm).unwrap();
        let mut assets = Assets::new();
        let mut total = 0;
        load(&directory.0, &directory.0, 0, &mut assets, &mut total).unwrap();
        assert_eq!(total, wasm.len());
        assert_eq!(assets["/app.wasm"].data.as_ref(), wasm);
        for method in [Method::GET, Method::HEAD] {
            let response = respond(
                method,
                "/app.wasm".parse().unwrap(),
                &HeaderMap::new(),
                &assets,
            );
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/wasm");
            assert_eq!(response.headers()[header::CONTENT_LENGTH], "8");
            assert_eq!(
                response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                "nosniff"
            );
        }
    }

    #[test]
    fn api_unknown_is_json_and_never_spa() {
        for path in ["/api", "/api/v2/missing"] {
            let response = respond(
                Method::GET,
                path.parse().unwrap(),
                &HeaderMap::new(),
                &assets(),
            );
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        }
    }
    #[test]
    fn traversal_and_missing_routes_never_fall_back() {
        for path in [
            "/../index.html",
            "/%2e%2e/index.html",
            "/missing",
            "/index.html/extra",
        ] {
            assert_eq!(
                respond(
                    Method::GET,
                    path.parse().unwrap(),
                    &HeaderMap::new(),
                    &assets()
                )
                .status(),
                StatusCode::NOT_FOUND
            );
        }
    }
    #[test]
    fn explicit_index_and_head_have_correct_headers() {
        let response = respond(
            Method::HEAD,
            "/".parse().unwrap(),
            &HeaderMap::new(),
            &assets(),
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "2");
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert_eq!(
            respond(
                Method::POST,
                "/".parse().unwrap(),
                &HeaderMap::new(),
                &assets()
            )
            .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }
}
