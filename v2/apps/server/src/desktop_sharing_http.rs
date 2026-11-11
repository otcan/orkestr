//! The owner's switch "share all desks with all chats" (ORK-773). On, any chat
//! with a desktop binding may reserve any desk; off, each chat reaches exactly
//! the desks its binding lists. Owner credential only: a conversation desktop
//! grant cannot read or change it.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::{failure, invalid};
use axum::extract::rejection::JsonRejection;
use orkestr_v2_contracts::DesktopSharingRequest;
use orkestr_v2_store_sqlite::ResourceError;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/v2/desktop-sharing", get(read).put(update))
}

async fn read(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .desktop_sharing(&credential, &owner)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Result<Json<DesktopSharingRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Json(request) = request.map_err(|_| invalid())?;
    if !request.is_valid() {
        return Err(invalid());
    }
    match state
        .store
        .set_desktop_sharing(&credential, &owner, &request)
        .await
    {
        Ok(value) => Ok(Json(value).into_response()),
        Err(ResourceError::Conflict(code @ "desktop_shared_lease_active")) => Err(Error(
            StatusCode::CONFLICT,
            code,
            "A chat still has a desk reserved that is not one of its own desks. Release that reservation, then turn sharing off.",
        )),
        Err(ResourceError::Conflict(code @ "desktop_sharing_revision_mismatch")) => Err(Error(
            StatusCode::CONFLICT,
            code,
            "Desk sharing was changed elsewhere. Reload and try again.",
        )),
        Err(error) => Err(failure(error)),
    }
}
