//! Authenticated, scoped removable output. Journal references are immutable.
use super::*;
use axum::extract::Path;
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::PayloadId;

fn ids(conversation: String, payload: String) -> Result<(ConversationId, PayloadId), Error> {
    let invalid = || {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_id",
            "Invalid payload identity",
        )
    };
    Ok((
        ConversationId(Uuid::parse_str(&conversation).map_err(|_| invalid())?),
        PayloadId(Uuid::parse_str(&payload).map_err(|_| invalid())?),
    ))
}
fn failure(error: RuntimeStoreError) -> Error {
    match error {
        RuntimeStoreError::NotFound | RuntimeStoreError::Unauthorized => {
            Error(StatusCode::NOT_FOUND, "not_found", "Payload not found")
        }
        _ => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Payload unavailable",
        ),
    }
}
pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((conversation, payload)): Path<(String, String)>,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    let (conversation, payload) = ids(conversation, payload)?;
    let result = state
        .store
        .provider_payload(&owner, &conversation, &payload)
        .await
        .map_err(failure)?;
    if result.conversation_id != conversation || result.payload_id != payload {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_projection",
            "Payload unavailable",
        ));
    }
    Ok(Json(result).into_response())
}
pub(crate) async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((conversation, payload)): Path<(String, String)>,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    browser::guard(
        &state,
        &axum::http::Method::DELETE,
        "provider_payload_remove",
        &headers,
    )
    .await?;
    let (conversation, payload) = ids(conversation, payload)?;
    state
        .store
        .remove_provider_payload(&owner, &conversation, &payload)
        .await
        .map_err(failure)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
