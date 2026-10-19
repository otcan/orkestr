//! Owner task data routes; no route accepts native sessions or provider grants.
mod access;
use super::*;
pub(crate) use access::Registration;
pub use access::WorkerTaskAccess;
use axum::extract::{
    rejection::{JsonRejection, QueryRejection},
    Path, Query,
};
use orkestr_v2_application::runtime::RuntimeStoreError;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListQuery {
    parent_run_id: RunId,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EmptyRequest {}

fn conversation(id: &str) -> Result<ConversationId, Error> {
    let id = Uuid::parse_str(id).map_err(|_| invalid())?;
    if id.is_nil() {
        return Err(invalid());
    }
    Ok(ConversationId(id))
}
fn task(id: &str) -> Result<TaskId, Error> {
    let id = Uuid::parse_str(id).map_err(|_| invalid())?;
    if id.is_nil() {
        return Err(invalid());
    }
    Ok(TaskId(id))
}
fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_input",
        "Invalid Worker task request",
    )
}
async fn scope<'a>(
    state: &'a AppState,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<&'a crate::execution_registry::ExecutionScope, Error> {
    state
        .execution_scope(owner, conversation)
        .await?
        .ok_or(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "worker_tasks_unavailable",
            "Worker task service unavailable",
        ))
}
fn error(error: RuntimeStoreError) -> Error {
    match error {
        RuntimeStoreError::Unauthorized => unauthorized(),
        RuntimeStoreError::InvalidInput => invalid(),
        RuntimeStoreError::NotFound => Error(
            StatusCode::NOT_FOUND,
            "not_found",
            "Worker task scope not found",
        ),
        RuntimeStoreError::Conflict => Error(
            StatusCode::CONFLICT,
            "task_conflict",
            "Worker task input or parent control revision changed",
        ),
        RuntimeStoreError::Busy => Error(
            StatusCode::CONFLICT,
            "task_busy",
            "Worker task limit reached or delegated work requires Stop",
        ),
        RuntimeStoreError::Fenced | RuntimeStoreError::Expired | RuntimeStoreError::StaleLease => {
            Error(
                StatusCode::CONFLICT,
                "parent_fenced",
                "Parent execution authority changed",
            )
        }
        RuntimeStoreError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "worker_tasks_unavailable",
            "Worker task service unavailable",
        ),
    }
}
pub(crate) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<WorkerTaskCreateRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    browser::guard(
        &state,
        &axum::http::Method::POST,
        "worker_task_create",
        &headers,
    )
    .await?;
    let conversation = conversation(&id)?;
    let Json(input) = body.map_err(|_| invalid())?;
    if !input.is_valid() {
        return Err(invalid());
    }
    let scope = scope(&state, &owner, &conversation).await?;
    let available = scope
        .tasks
        .as_ref()
        .is_some_and(|access| access.available(&owner, &conversation, &input.parent_run_id));
    let receipt = scope
        .store
        .create_worker_task_if_available_authenticated(
            &browser::credential(&headers)?,
            &conversation,
            &input,
            available,
        )
        .await
        .map_err(error)?;
    if !receipt.is_valid()
        || receipt.conversation_id != conversation
        || receipt.parent_run_id != input.parent_run_id
    {
        return Err(error(RuntimeStoreError::Unavailable));
    }
    Ok(Json(receipt).into_response())
}
pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let Query(query) = query.map_err(|_| invalid())?;
    if query.parent_run_id.0.is_nil() {
        return Err(invalid());
    }
    let scope = scope(&state, &owner, &conversation).await?;
    let mut list = scope
        .store
        .worker_tasks_authenticated(
            &browser::credential(&headers)?,
            &conversation,
            &query.parent_run_id,
        )
        .await
        .map_err(error)?;
    list.can_create &= scope
        .tasks
        .as_ref()
        .is_some_and(|access| access.available(&owner, &conversation, &query.parent_run_id));
    if !list.is_valid()
        || list.conversation_id != conversation
        || list.parent_run_id != query.parent_run_id
    {
        return Err(error(RuntimeStoreError::Unavailable));
    }
    Ok(Json(list).into_response())
}
pub(crate) async fn hold(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, task_id)): Path<(String, String)>,
    body: Result<Json<EmptyRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    browser::guard(
        &state,
        &axum::http::Method::POST,
        "worker_task_hold",
        &headers,
    )
    .await?;
    let Json(EmptyRequest {}) = body.map_err(|_| invalid())?;
    let conversation = conversation(&id)?;
    scope(&state, &owner, &conversation)
        .await?
        .store
        .hold_worker_task_authenticated(
            &browser::credential(&headers)?,
            &conversation,
            &task(&task_id)?,
        )
        .await
        .map_err(error)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
pub(crate) async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, task_id)): Path<(String, String)>,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    browser::guard(
        &state,
        &axum::http::Method::DELETE,
        "worker_task_delete",
        &headers,
    )
    .await?;
    let conversation = conversation(&id)?;
    scope(&state, &owner, &conversation)
        .await?
        .store
        .delete_worker_task_payload_authenticated(
            &browser::credential(&headers)?,
            &conversation,
            &task(&task_id)?,
        )
        .await
        .map_err(error)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
