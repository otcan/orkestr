//! Browser-only, current-password-confirmed owner credential rotation.
use super::*;
use argon2::{
    password_hash::{rand_core::OsRng, SaltString},
    Argon2, PasswordHasher,
};
use orkestr_v2_store_sqlite::owner_password::PasswordChange;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangePassword {
    username: String,
    current_password: String,
    new_password: String,
}

pub async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, Error> {
    browser::owner(&state, &headers).await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"password_rotation_ready":state.password_rotation_ready})),
    ))
}

pub async fn change(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ChangePassword>,
) -> Result<impl IntoResponse, Error> {
    browser::guard(
        &state,
        &axum::http::Method::POST,
        "/api/v2/browser/password",
        &headers,
    )
    .await?;
    let authenticated = browser::owner(&state, &headers).await?;
    if !state.password_rotation_ready {
        return Err(Error(
            StatusCode::CONFLICT,
            "automation_credential_migration_required",
            "Automation credentials must be migrated before changing the password",
        ));
    }
    let credential = browser::credential(&headers)?;
    if !(12..=1024).contains(&body.new_password.len()) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Password must be 12 to 1024 bytes",
        ));
    }
    let (verified, old_hash) = auth::verify_credentials(
        &state,
        Ok(Json(Credentials {
            username: body.username,
            password: body.current_password,
        })),
    )
    .await?;
    if verified != authenticated {
        return Err(unauthorized());
    }
    let hash = tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(
                body.new_password.as_bytes(),
                &SaltString::generate(&mut OsRng),
            )
            .map(|h| h.to_string())
    })
    .await
    .map_err(|_| Error::from(StoreError::Unavailable))?
    .map_err(|_| Error::from(StoreError::Unavailable))?;
    match state
        .store
        .change_owner_password(&credential, &old_hash, &hash)
        .await?
    {
        PasswordChange::Changed => Ok((
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({"changed":true,"sign_in_required":true})),
        )),
        PasswordChange::Unauthorized | PasswordChange::CredentialsChanged => Err(unauthorized()),
        PasswordChange::LegacySessions => Err(Error(
            StatusCode::CONFLICT,
            "legacy_sessions_require_migration",
            "Older sessions must expire and reconnect before changing the password",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn owner_password_requires_browser_csrf_and_current_password() {
        let home = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap());
        std::fs::create_dir_all(&home).unwrap();
        let path = home.join(format!("password-http-{}.sqlite3", Uuid::new_v4()));
        let store = Store::open(&path).await.unwrap();
        let old = "synthetic-old-password";
        let hash = Argon2::default()
            .hash_password(old.as_bytes(), &SaltString::generate(&mut OsRng))
            .unwrap()
            .to_string();
        store.setup("synthetic-owner", &hash).await.unwrap();
        let state = AppState::new(
            store.clone(),
            "synthetic-bootstrap-password-only".into(),
            "http://example.test".into(),
        )
        .unwrap();
        let login = browser::login(
            State(state.clone()),
            HeaderMap::new(),
            Ok(Json(Credentials {
                username: "synthetic-owner".into(),
                password: old.into(),
            })),
        )
        .await
        .ok()
        .unwrap();
        let cookie = login.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        let bytes = axum::body::to_bytes(login.into_body(), 4096).await.unwrap();
        let projection: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, cookie.parse().unwrap());
        headers.insert(header::HOST, "example.test".parse().unwrap());
        headers.insert(header::ORIGIN, "http://example.test".parse().unwrap());
        let body = |password: &str| {
            Json(ChangePassword {
                username: "synthetic-owner".into(),
                current_password: password.into(),
                new_password: "synthetic-new-password".into(),
            })
        };
        let missing_csrf = change(State(state.clone()), headers.clone(), body(old))
            .await
            .err()
            .unwrap();
        assert_eq!(missing_csrf.0, StatusCode::FORBIDDEN);
        headers.insert(
            "x-orkestr-csrf",
            projection["csrf_token"].as_str().unwrap().parse().unwrap(),
        );
        let migration = change(State(state.clone()), headers.clone(), body(old))
            .await
            .err()
            .unwrap();
        assert_eq!(migration.1, "automation_credential_migration_required");
        let state = state.with_password_rotation_ready();
        let wrong = change(
            State(state.clone()),
            headers.clone(),
            body("synthetic-wrong-password"),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(wrong.0, StatusCode::UNAUTHORIZED);
        let mut bearer = HeaderMap::new();
        bearer.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", "a".repeat(64)).parse().unwrap(),
        );
        assert!(change(State(state.clone()), bearer, body(old))
            .await
            .is_err());
        assert!(change(State(state.clone()), headers.clone(), body(old))
            .await
            .is_ok());
        assert!(browser::owner(&state, &headers).await.is_err());
        assert!(auth::verify_credentials(
            &state,
            Ok(Json(Credentials {
                username: "synthetic-owner".into(),
                password: old.into()
            }))
        )
        .await
        .is_err());
        assert!(auth::verify_credentials(
            &state,
            Ok(Json(Credentials {
                username: "synthetic-owner".into(),
                password: "synthetic-new-password".into()
            }))
        )
        .await
        .is_ok());
        store.close().await;
        std::fs::remove_file(path).unwrap();
    }
}
