//! Authenticated, scoped removable output. Journal references are immutable.
use super::*;
use axum::extract::{rejection::QueryRejection, Path, Query};
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::PayloadId;

/// Payload JSON one batch answer carries at most; the rest are read alone.
const BATCH_BYTES: usize = 1024 * 1024;

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

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Batch {
    ids: String,
}

/// The texts of several answers in one read (ORK-797), so a chat does not
/// send one request per answer. The same owner, scope and projection checks
/// as `read`. A payload that is unknown or does not fit is left out; the
/// reader then asks for it alone.
pub(crate) async fn read_many(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation): Path<String>,
    query: Result<Query<Batch>, QueryRejection>,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    let invalid = || {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_id",
            "Invalid payload identity",
        )
    };
    let Query(batch) = query.map_err(|_| invalid())?;
    let conversation = ConversationId(Uuid::parse_str(&conversation).map_err(|_| invalid())?);
    let mut ids = Vec::new();
    for id in batch.ids.split(',') {
        let id = PayloadId(Uuid::parse_str(id).map_err(|_| invalid())?);
        if ids.contains(&id) || ids.len() == PROVIDER_PAYLOAD_BATCH {
            return Err(invalid());
        }
        ids.push(id);
    }
    let found = state
        .store
        .provider_payloads(&owner, &conversation, &ids)
        .await
        .map_err(failure)?;
    let mut payloads: Vec<ProviderPayload> = Vec::with_capacity(found.len());
    let mut bytes = 0;
    for payload in found {
        if payload.conversation_id != conversation
            || !ids.contains(&payload.payload_id)
            || payloads.iter().any(|p| p.payload_id == payload.payload_id)
        {
            return Err(Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "invalid_projection",
                "Payload unavailable",
            ));
        }
        let size = serde_json::to_vec(&payload).map_or(usize::MAX, |json| json.len());
        if size <= BATCH_BYTES - bytes {
            bytes += size;
            payloads.push(payload);
        }
    }
    Ok(Json(ProviderPayloads {
        conversation_id: conversation,
        payloads,
    })
    .into_response())
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
