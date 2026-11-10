//! Optional immutable static snapshot; never reads request-selected filesystem paths.
use axum::{
    body::{Body, Bytes},
    http::{header, Method, StatusCode, Uri},
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
type Assets = BTreeMap<String, (&'static str, Bytes)>;

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
            assets.insert(key, (content_type, Bytes::from(data)));
        } else {
            return Err(invalid());
        }
    }
    Ok(())
}
fn respond(method: Method, uri: Uri, assets: &Assets) -> Response {
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
    let Some((content_type, data)) = assets.get(key) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = Response::new(if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(data.clone())
    });
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
    headers.insert(
        header::CONTENT_LENGTH,
        data.len().to_string().parse().unwrap(),
    );
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
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
    Ok(router.fallback(move |method: Method, uri: Uri| {
        let assets = assets.clone();
        async move { respond(method, uri, &assets) }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn assets() -> Assets {
        BTreeMap::from([(
            "/index.html".into(),
            ("text/html; charset=utf-8", Bytes::from_static(b"UI")),
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
        assert_eq!(assets["/app.wasm"].1.as_ref(), wasm);
        for method in [Method::GET, Method::HEAD] {
            let response = respond(method, "/app.wasm".parse().unwrap(), &assets);
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
            let response = respond(Method::GET, path.parse().unwrap(), &assets());
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
                respond(Method::GET, path.parse().unwrap(), &assets()).status(),
                StatusCode::NOT_FOUND
            );
        }
    }
    #[test]
    fn explicit_index_and_head_have_correct_headers() {
        let response = respond(Method::HEAD, "/".parse().unwrap(), &assets());
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
            respond(Method::POST, "/".parse().unwrap(), &assets()).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }
}
