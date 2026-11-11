//! Owner-only Claude and Codex sign-in. Cookie session only: a Bearer service or
//! chat credential is refused before any control request is made. The closed
//! projection re-checks every free-form field, so a provider link reaches the
//! browser only for the provider's own https sign-in page.
use super::*;
use axum::extract::{rejection::JsonRejection, DefaultBodyLimit, Path};
use orkestr_v2_contracts::{pasted_code_allowed, SignInOverview, SignInProvider, SignInResult};
use serde_json::Value;
use std::{future::Future, pin::Pin, time::Duration};

pub(crate) use crate::window_runtime::manager_client::SignInCommand;

const CONTROL_DEADLINE: Duration = Duration::from_secs(4);

pub(crate) type PortReply = Pin<Box<dyn Future<Output = Result<Value, ()>> + Send>>;

/// The Root control boundary; tests substitute a fake with no privilege.
pub(crate) trait Port: Send + Sync {
    fn call(&self, command: SignInCommand) -> PortReply;
}
pub(crate) struct ManagerPort(pub crate::window_runtime::manager_client::ManagerClient);
impl Port for ManagerPort {
    fn call(&self, command: SignInCommand) -> PortReply {
        let manager = self.0.clone();
        Box::pin(async move {
            manager
                .provider_sign_in(command, Instant::now() + CONTROL_DEADLINE)
                .await
                .map_err(|_| ())
        })
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v2/provider-sign-in", get(overview))
        .route("/api/v2/provider-sign-in/{provider}/start", post(start))
        .route("/api/v2/provider-sign-in/{provider}/code", post(code))
        .route("/api/v2/provider-sign-in/{provider}/cancel", post(cancel))
        .route(
            "/api/v2/provider-sign-in/{provider}/sign-out",
            post(sign_out),
        )
        .layer(DefaultBodyLimit::max(4096))
}

fn unavailable() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "provider_sign_in_unavailable",
        "Provider sign-in is unavailable",
    )
}
fn provider(value: &str) -> Result<SignInProvider, Error> {
    SignInProvider::parse(value).ok_or(Error(
        StatusCode::NOT_FOUND,
        "provider_sign_in_unknown_provider",
        "Unknown provider",
    ))
}
fn no_store(status: StatusCode, value: SignInOverview) -> Response {
    let mut response = (status, Json(value)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
async fn call(state: &AppState, command: SignInCommand) -> Result<SignInOverview, Error> {
    let port = state.provider_sign_in.as_ref().ok_or_else(unavailable)?;
    let value = port.call(command).await.map_err(|_| unavailable())?;
    let overview: SignInOverview = serde_json::from_value(value).map_err(|_| unavailable())?;
    if !overview.valid() {
        return Err(unavailable());
    }
    Ok(overview)
}

async fn overview(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    if state.provider_sign_in.is_none() {
        return Ok(no_store(StatusCode::OK, SignInOverview::unavailable()));
    }
    Ok(no_store(
        StatusCode::OK,
        call(&state, SignInCommand::Status).await?,
    ))
}

async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    let selected = provider(&name)?;
    let overview = call(&state, SignInCommand::Start(selected)).await?;
    match overview.result {
        SignInResult::Started => Ok(no_store(StatusCode::ACCEPTED, overview)),
        result => Err(refused(result)),
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PastedCode {
    code: String,
}

async fn code(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    body: Result<Json<PastedCode>, JsonRejection>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    let selected = provider(&name)?;
    let Json(body) = body.map_err(|_| code_refused())?;
    let code = body.code.trim().to_owned();
    if !pasted_code_allowed(&code) {
        return Err(code_refused());
    }
    let overview = call(&state, SignInCommand::Code(selected, code)).await?;
    match overview.result {
        SignInResult::Accepted => Ok(no_store(StatusCode::ACCEPTED, overview)),
        _ => Err(code_refused()),
    }
}

async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    let selected = provider(&name)?;
    let overview = call(&state, SignInCommand::Cancel(selected)).await?;
    Ok(no_store(StatusCode::OK, overview))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Confirmation {
    confirm: bool,
}

async fn sign_out(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    body: Result<Json<Confirmation>, JsonRejection>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    let selected = provider(&name)?;
    if !matches!(body, Ok(Json(Confirmation { confirm: true }))) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "provider_sign_out_confirmation_required",
            "Confirm before signing out",
        ));
    }
    let overview = call(&state, SignInCommand::SignOut(selected)).await?;
    match overview.result {
        SignInResult::Started => Ok(no_store(StatusCode::ACCEPTED, overview)),
        result => Err(refused(result)),
    }
}

fn code_refused() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "provider_sign_in_code_refused",
        "That code was not accepted",
    )
}
fn refused(result: SignInResult) -> Error {
    match result {
        SignInResult::InProgress => Error(
            StatusCode::CONFLICT,
            "provider_sign_in_in_progress",
            "A sign-in is already in progress for this provider",
        ),
        SignInResult::RateLimited => Error(
            StatusCode::TOO_MANY_REQUESTS,
            "provider_sign_in_rate_limited",
            "Too many sign-in attempts. Try again in a few minutes",
        ),
        _ => unavailable(),
    }
}

#[cfg(test)]
#[path = "provider_sign_in_http_tests.rs"]
mod tests;
