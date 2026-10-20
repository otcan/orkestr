//! Current-browser native thread directory. Creation is not execution admission.
use super::*;
use axum::extract::{
    rejection::{JsonRejection, QueryRejection},
    Query,
};
use orkestr_v2_application::runtime::RuntimeStoreError;

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Page {
    after: Option<i64>,
    limit: Option<u32>,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<Page>, QueryRejection>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    let Query(page) = query.map_err(|_| invalid())?;
    let credential = browser::credential(&headers)?;
    let result = state
        .store
        .conversations_authenticated(
            &credential,
            page.after.unwrap_or(0),
            page.limit.unwrap_or(50),
        )
        .await
        .map_err(store_error)?;
    Ok(Json(result).into_response())
}

pub(crate) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<ConversationInput>, JsonRejection>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    browser::guard(
        &state,
        &axum::http::Method::POST,
        "conversation_create",
        &headers,
    )
    .await?;
    let Json(input) = body.map_err(|_| invalid())?;
    let credential = browser::credential(&headers)?;
    let (conversation, duplicate) = state
        .store
        .create_conversation_authenticated(&credential, &input)
        .await
        .map_err(store_error)?;
    Ok((
        if duplicate {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(conversation),
    )
        .into_response())
}
fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_input",
        "Invalid conversation request",
    )
}
fn store_error(error: RuntimeStoreError) -> Error {
    match error {
        RuntimeStoreError::Unauthorized => unauthorized(),
        RuntimeStoreError::InvalidInput => invalid(),
        RuntimeStoreError::Conflict => Error(
            StatusCode::CONFLICT,
            "conversation_conflict",
            "Conversation request key already used",
        ),
        RuntimeStoreError::NotFound => {
            Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
        }
        _ => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "conversation_unavailable",
            "Conversation directory unavailable",
        ),
    }
}

#[cfg(test)]
#[path = "conversations_http_tests.rs"]
mod tests;
