//! Read-only, authenticated execution projection. No dispatch/control authority.
use super::*;
use axum::extract::Path;
use orkestr_v2_application::runtime::RuntimeStoreError;

pub(crate) async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let owner = owner(&state, &headers).await?;
    let conversation = ConversationId(Uuid::parse_str(&id).map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_id",
            "Invalid conversation ID",
        )
    })?);
    let status = state
        .store
        .execution_status(&owner, &conversation)
        .await
        .map_err(|error| match error {
            RuntimeStoreError::NotFound | RuntimeStoreError::Unauthorized => {
                Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
            }
            _ => Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "store_unavailable",
                "Execution status unavailable",
            ),
        })?;
    match status {
        None => Ok(StatusCode::NO_CONTENT.into_response()),
        Some(status) if status.conversation_id == conversation && status.is_valid() => {
            Ok(Json(status).into_response())
        }
        Some(_) => Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_projection",
            "Execution status unavailable",
        )),
    }
}
