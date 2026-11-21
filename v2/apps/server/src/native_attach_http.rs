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
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::{ConversationId, ExecutionWindowState, ExecutionWindowStatus};
use uuid::Uuid;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/v2/conversations/{id}/native-attach", get(status))
}

impl AppState {
    /// The owner's terminal holds this conversation's native session now.
    pub(crate) fn native_attach_held(&self, conversation: &ConversationId) -> bool {
        self.native_attach
            .as_ref()
            .is_some_and(|holds| holds.held(conversation, crate::deploy_drain::now_ms()))
    }
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
    /// When the hold lapses unless renewed (never after the age deadline).
    expires_at_ms: Option<i64>,
    /// When the hold stops holding however renewed (`acquired_at_ms + 8 h`).
    max_age_deadline_ms: Option<i64>,
    /// `true`: Core shows no unfinished execution window, so V2 holds no
    /// native process of this conversation, and none can still be created
    /// from a check made before the hold (read under the window controller's
    /// `opening`). `false`: Core shows an unfinished window. `null`: unknown
    /// (Core unavailable, or an open still in flight). A terminal attaches
    /// only on `true` while held.
    native_idle: Option<bool>,
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
    // The CLI polls this while attached: a valid live hold answers 200
    // `held: true` even when the window read below is unavailable, which then
    // reports `native_idle: null` (unknown), never `false`.
    let hold = holds.active(&conversation, crate::deploy_drain::now_ms());
    let native_idle = match &state.window_controller {
        Some(controller) => controller.native_idle(&credential, &conversation).await,
        None => {
            let window = state
                .store
                .execution_window_status_authenticated(&credential, &conversation)
                .await;
            window_idle(window)
        }
    };
    // Never answer for an unknown or another owner's conversation.
    let native_idle = native_idle.map_err(crate::window_http::store_error)?;
    Ok(Json(NativeAttachStatus {
        conversation_id: conversation,
        held: hold.is_some(),
        provider: hold.as_ref().map(|hold| hold.provider),
        native_session_id: hold.as_ref().map(|hold| hold.native_session_id),
        session_id: hold.as_ref().map(|hold| hold.session_id),
        acquired_at_ms: hold.as_ref().map(|hold| hold.acquired_at_ms),
        expires_at_ms: hold.as_ref().map(|hold| hold.expires_at_ms),
        max_age_deadline_ms: hold.as_ref().map(|hold| hold.max_age_deadline_ms),
        native_idle,
    })
    .into_response())
}

/// `Some(true)` without an unfinished window, `Some(false)` with one, `None`
/// when Core is unavailable. A foreign or unknown conversation is an error.
pub(crate) fn window_idle(
    status: Result<Option<ExecutionWindowStatus>, RuntimeStoreError>,
) -> Result<Option<bool>, RuntimeStoreError> {
    match status {
        Ok(window) => {
            let closed = window.is_none_or(|window| window.state == ExecutionWindowState::Closed);
            Ok(Some(closed))
        }
        Err(RuntimeStoreError::Unavailable | RuntimeStoreError::Busy) => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "native_attach_http_tests.rs"]
mod tests;
