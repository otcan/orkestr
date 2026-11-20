//! Owner read of a conversation's native-attach hold (`orkestr attach`).
//! Holds are Root-recorded files (`native_attach`); this route never writes.
use crate::{browser, native_attach::Provider, AppState, Error};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use orkestr_v2_contracts::{ConversationId, ExecutionWindowState};
use uuid::Uuid;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/v2/conversations/{id}/native-attach", get(status))
}

/// The health features, with `native_attach_hold_v1` when this server
/// honours native-attach holds (the sealed configuration names their
/// directory).
pub(crate) fn features(state: &AppState, base: &[&'static str]) -> Vec<&'static str> {
    let mut features = base.to_vec();
    if state.native_attach.is_some() {
        features.push("native_attach_hold_v1");
    }
    features
}

#[derive(serde::Serialize)]
struct NativeAttachStatus {
    conversation_id: ConversationId,
    held: bool,
    provider: Option<Provider>,
    native_session_id: Option<Uuid>,
    session_id: Option<Uuid>,
    acquired_at_ms: Option<i64>,
    /// When the hold lapses unless renewed.
    expires_at_ms: Option<i64>,
    /// Core shows no unfinished execution window: V2 holds no native process
    /// of this conversation (its last window closed after its native tree
    /// was reaped). A terminal attaches only once this is true while held.
    native_idle: bool,
}

async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    let credential = browser::credential(&headers)?;
    let conversation = Uuid::parse_str(&id)
        .ok()
        .filter(|id| !id.is_nil())
        .map(ConversationId)
        .ok_or(Error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Invalid conversation",
        ))?;
    let holds = state.native_attach.as_ref().ok_or(Error(
        StatusCode::NOT_FOUND,
        "native_attach_unconfigured",
        "Native attach holds are not configured on this server",
    ))?;
    // Authenticates this conversation for the owner before reading its hold.
    let window = state
        .store
        .execution_window_status_authenticated(&credential, &conversation)
        .await
        .map_err(crate::window_http::store_error)?;
    let native_idle = window.is_none_or(|window| window.state == ExecutionWindowState::Closed);
    let hold = holds.active(&conversation, crate::deploy_drain::now_ms());
    Ok(Json(NativeAttachStatus {
        conversation_id: conversation,
        held: hold.is_some(),
        provider: hold.as_ref().map(|hold| hold.provider),
        native_session_id: hold.as_ref().map(|hold| hold.native_session_id),
        session_id: hold.as_ref().map(|hold| hold.session_id),
        acquired_at_ms: hold.as_ref().map(|hold| hold.acquired_at_ms),
        expires_at_ms: hold.as_ref().map(|hold| hold.expires_at_ms),
        native_idle,
    })
    .into_response())
}

#[cfg(all(test, target_os = "linux"))]
#[path = "native_attach_http_tests.rs"]
mod tests;
