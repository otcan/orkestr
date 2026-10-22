use super::*;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, SaltString},
    Argon2, PasswordHasher, PasswordVerifier,
};
use axum::extract::rejection::JsonRejection;
use sha2::{Digest, Sha256};

async fn rate_limit(state: &AppState) -> Result<(), Error> {
    let mut window = state.auth_window.lock().await;
    if window.0.elapsed() >= Duration::from_secs(60) {
        *window = (Instant::now(), 0);
    }
    window.1 += 1;
    if window.1 > 10 {
        return Err(Error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Authentication rate limit exceeded",
        ));
    }
    Ok(())
}
fn credentials(body: Result<Json<Credentials>, JsonRejection>) -> Result<Credentials, Error> {
    let Json(c) = body.map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Invalid credentials body",
        )
    })?;
    if c.username.is_empty()
        || c.username.len() > 128
        || c.password.len() < 12
        || c.password.len() > 1024
    {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Username required; password must be 12 to 1024 bytes",
        ));
    }
    Ok(c)
}
fn bootstrap(state: &AppState, headers: &HeaderMap) -> Result<(), Error> {
    let supplied = headers
        .get("x-orkestr-bootstrap")
        .and_then(|s| s.to_str().ok())
        .unwrap_or("");
    // Hash equal-length values before comparison; no raw secret in persistence or errors.
    let a = Sha256::digest(supplied.as_bytes());
    let b = Sha256::digest(state.bootstrap_token.as_bytes());
    let differs = a
        .iter()
        .zip(b.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    if differs != 0 {
        return Err(unauthorized());
    }
    Ok(())
}
/// First-run state for the holder of the bootstrap token (the desktop app),
/// so it hands the token to its UI only while no owner exists. Without the
/// token nothing is disclosed.
pub async fn setup_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, Error> {
    rate_limit(&state).await?;
    bootstrap(&state, &headers)?;
    let configured = state.store.owner_configured().await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({ "setup_required": !configured })),
    ))
}
pub async fn setup(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Credentials>, JsonRejection>,
) -> Result<impl IntoResponse, Error> {
    rate_limit(&state).await?;
    bootstrap(&state, &headers)?;
    let c = credentials(body)?;
    let hash = tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(c.password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| (c.username, h.to_string()))
    })
    .await
    .map_err(|_| Error::from(StoreError::Unavailable))?
    .map_err(|_| Error::from(StoreError::Unavailable))?;
    let conversation = state.store.setup(&hash.0, &hash.1).await?;
    Ok((
        StatusCode::CREATED,
        Json(SetupResponse {
            global_conversation_id: conversation,
        }),
    ))
}
pub async fn session(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Credentials>, JsonRejection>,
) -> Result<Json<SessionResponse>, Error> {
    machine_request(&headers)?;
    let owner = verify_credentials(&state, body).await?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    state.store.save_session(&token, &owner).await?;
    Ok(Json(SessionResponse {
        token,
        token_type: "Bearer".into(),
        expires_in: 43200,
        global_conversation_id: state.store.global(&owner).await?,
    }))
}

pub(crate) async fn verify_credentials(
    state: &AppState,
    body: Result<Json<Credentials>, JsonRejection>,
) -> Result<OwnerId, Error> {
    rate_limit(state).await?;
    let c = credentials(body)?;
    let record = state.store.credentials(&c.username).await?;
    // Unknown usernames still pay a password verification cost.
    let fallback = "$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGljLXNhbHQ$39k+yFfupMCp3G7EwU7iCnDF+J9AR+esb2azcD3zSxI";
    let hash = record
        .as_ref()
        .map(|r| r.1.clone())
        .unwrap_or_else(|| fallback.into());
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).ok().is_some_and(|h| {
            Argon2::default()
                .verify_password(c.password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .map_err(|_| Error::from(StoreError::Unavailable))?;
    if !valid {
        return Err(unauthorized());
    }
    let (owner, _) = record.ok_or_else(unauthorized)?;
    Ok(owner)
}

#[cfg(test)]
mod setup_status_tests {
    use super::*;

    #[tokio::test]
    async fn setup_status_needs_the_token_and_flips_after_setup() {
        let home = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
        std::fs::create_dir_all(&home).unwrap();
        let path = home.join(format!("setup-status-{}.sqlite3", Uuid::new_v4()));
        let store = Store::open(&path).await.unwrap();
        let token = "synthetic-bootstrap-setup-status-test-only";
        let state =
            AppState::new(store.clone(), token.into(), "http://127.0.0.1:47110".into()).unwrap();
        let status = |value: &str| {
            let mut headers = HeaderMap::new();
            if !value.is_empty() {
                headers.insert("x-orkestr-bootstrap", value.parse().unwrap());
            }
            setup_status(State(state.clone()), headers)
        };
        assert!(status("").await.is_err());
        assert!(status("synthetic-wrong-token-of-sufficient-length")
            .await
            .is_err());
        let body = |response: axum::response::Response| async move {
            let bytes = axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        };
        let before = status(token).await.ok().unwrap().into_response();
        assert_eq!(body(before).await["setup_required"], true);
        store.setup("owner", "synthetic-hash").await.unwrap();
        let after = status(token).await.ok().unwrap().into_response();
        assert_eq!(body(after).await["setup_required"], false);
        store.close().await;
        std::fs::remove_file(path).unwrap();
    }
}
