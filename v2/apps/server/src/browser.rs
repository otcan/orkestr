//! Browser-only sessions. Cookie token values never authenticate as machine Bearer tokens.
use super::*;
use axum::{extract::rejection::JsonRejection, http::Method};
use sha2::{Digest, Sha256};

const COOKIE: &str = "orkestr_v2_session";
const SESSION_PATH: &str = "/api/v2/browser/session";
const TTL: u32 = 43200;

fn forbidden(code: &'static str) -> Error {
    Error(StatusCode::FORBIDDEN, code, "Browser request rejected")
}
fn token(headers: &HeaderMap) -> Result<String, Error> {
    let mut found = None;
    for value in headers.get_all(header::COOKIE) {
        for part in value.to_str().map_err(|_| unauthorized())?.split(';') {
            if let Some((name, value)) = part.trim().split_once('=') {
                if name == COOKIE {
                    if found.is_some()
                        || value.len() != 64
                        || !value.bytes().all(|b| b.is_ascii_hexdigit())
                    {
                        return Err(unauthorized());
                    }
                    found = Some(value.to_owned());
                }
            }
        }
    }
    found.ok_or_else(unauthorized)
}
fn stored(token: &str) -> String {
    format!("browser:{token}")
}
fn csrf(token: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{token}").as_bytes())
    )
}
fn equal(a: &str, b: &str) -> bool {
    let a = Sha256::digest(a.as_bytes());
    let b = Sha256::digest(b.as_bytes());
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}
fn single<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        None
    } else {
        Some(value)
    }
}
fn same_origin(state: &AppState, headers: &HeaderMap) -> Result<(), Error> {
    if single(headers, "origin") != Some(state.origin.as_str()) {
        return Err(forbidden("origin_rejected"));
    }
    if single(headers, "host") != Some(state.authority.as_str()) {
        return Err(forbidden("host_rejected"));
    }
    Ok(())
}
pub(crate) async fn owner(state: &AppState, headers: &HeaderMap) -> Result<OwnerId, Error> {
    if headers.contains_key(header::AUTHORIZATION) {
        return Err(unauthorized());
    }
    state
        .store
        .authenticate(&stored(&token(headers)?))
        .await?
        .ok_or_else(unauthorized)
}
pub(crate) async fn guard(
    state: &AppState,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
) -> Result<(), Error> {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return Ok(());
    }
    if path == SESSION_PATH && *method == Method::POST {
        // Credentials bootstrap browser authority; there is no CSRF token before login.
        same_origin(state, headers)?;
        if headers.contains_key(header::AUTHORIZATION) {
            return Err(unauthorized());
        }
    } else if headers.contains_key(header::COOKIE) {
        same_origin(state, headers)?;
        owner(state, headers).await?;
        let supplied =
            single(headers, "x-orkestr-csrf").ok_or_else(|| forbidden("csrf_rejected"))?;
        if !equal(supplied, &csrf(&token(headers)?)) {
            return Err(forbidden("csrf_rejected"));
        }
    }
    Ok(())
}
fn cookie(state: &AppState, token: &str, ttl: u32) -> String {
    let secure = if state.origin.starts_with("https://") {
        "; Secure"
    } else {
        ""
    };
    format!("{COOKIE}={token}; Path=/api/v2; HttpOnly; SameSite=Strict; Max-Age={ttl}{secure}")
}
async fn body(
    state: &AppState,
    owner: &OwnerId,
    token: &str,
) -> Result<Json<serde_json::Value>, Error> {
    Ok(Json(serde_json::json!({
        "csrf_token": csrf(token),
        "global_conversation_id": state.store.global(owner).await?,
    })))
}
pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    credentials: Result<Json<Credentials>, JsonRejection>,
) -> Result<Response, Error> {
    let owner = auth::verify_credentials(&state, credentials).await?;
    let value = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    state.store.save_session(&stored(&value), &owner).await?;
    // Rotate an existing cookie only after successful credential verification.
    if let Ok(old) = token(&headers) {
        state.store.revoke_session(&stored(&old)).await?;
    }
    Ok((
        [(header::SET_COOKIE, cookie(&state, &value, TTL))],
        body(&state, &owner, &value).await?,
    )
        .into_response())
}
pub async fn session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, Error> {
    let owner = owner(&state, &headers).await?;
    body(&state, &owner, &token(&headers)?).await
}
pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    owner(&state, &headers).await?;
    state
        .store
        .revoke_session(&stored(&token(&headers)?))
        .await?;
    Ok((
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, cookie(&state, "", 0))],
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn https_cookie_is_secure_and_http_cookie_is_host_only() {
        let home = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
        std::fs::create_dir_all(&home).unwrap();
        let path = home.join(format!("cookie-test-{}.sqlite3", Uuid::new_v4()));
        let store = Store::open(&path).await.unwrap();
        for origin in ["https://example.test", "http://127.0.0.1:47110"] {
            let state = AppState::new(
                store.clone(),
                "synthetic-bootstrap-cookie-test-only".into(),
                origin.into(),
            )
            .unwrap();
            let header = cookie(&state, "synthetic", TTL);
            assert!(header.contains("HttpOnly; SameSite=Strict"));
            assert!(!header.contains("Domain="));
            assert_eq!(header.contains("; Secure"), origin.starts_with("https:"));
        }
        store.close().await;
        std::fs::remove_file(path).unwrap();
    }
}
