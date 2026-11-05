use super::*;
use axum::extract::Path;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    username: String,
    current_password: String,
    label: String,
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Create>,
) -> Result<impl IntoResponse, Error> {
    let owner = browser::owner(&state, &headers).await?;
    let (verified, hash) = auth::verify_credentials(
        &state,
        Ok(Json(Credentials {
            username: input.username,
            password: input.current_password,
        })),
    )
    .await?;
    if verified != owner {
        return Err(unauthorized());
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let id = state
        .store
        .create_service_credential(&browser::credential(&headers)?, &hash, &input.label, &token)
        .await?
        .ok_or_else(unauthorized)?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"id":id,"service_token":token,"expires_in":2592000})),
    ))
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, Error> {
    browser::owner(&state, &headers).await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(
            state
                .store
                .service_credentials(&browser::credential(&headers)?)
                .await?,
        ),
    ))
}

pub async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, Error> {
    browser::owner(&state, &headers).await?;
    if !state
        .store
        .revoke_service_credential(&browser::credential(&headers)?, &id)
        .await?
    {
        return Err(unauthorized());
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exchange {
    service_token: String,
}

pub async fn exchange(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Exchange>,
) -> Result<Response, Error> {
    machine_request(&headers)?;
    auth::rate_limit(&state).await?;
    if input.service_token.len() != 64
        || !input.service_token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(unauthorized());
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let owner = state
        .store
        .exchange_service_session(&input.service_token, &browser::stored(&token))
        .await?
        .ok_or_else(unauthorized)?;
    Ok((
        [
            (header::CACHE_CONTROL, "no-store"),
            (
                header::SET_COOKIE,
                browser::cookie(&state, &token, 43200).as_str(),
            ),
        ],
        browser::body(&state, &owner, &token).await?,
    )
        .into_response())
}
