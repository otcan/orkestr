//! Current owner capability discovery. No role, profile, path or grant is supplied.
use super::*;
use axum::extract::Path;
use orkestr_v2_contracts::{IntelligenceCapabilities, RoleCapability};

pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    let conversation = ConversationId(Uuid::parse_str(&id).map_err(|_| invalid())?);
    if conversation.0.is_nil() {
        return Err(invalid());
    }
    // This read verifies canonical owner scope even when no native role is live.
    let status = state
        .store
        .execution_status(&owner, &conversation)
        .await
        .map_err(|error| match error {
            orkestr_v2_application::runtime::RuntimeStoreError::NotFound
            | orkestr_v2_application::runtime::RuntimeStoreError::Unauthorized => {
                Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
            }
            _ => Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "intelligence_unavailable",
                "Role discovery unavailable",
            ),
        })?;
    let deep = state.execution_scope(&owner, &conversation).await?;
    let fast = state.fast_execution_scope(&owner, &conversation).await?;
    let configured = state
        .window_controller
        .as_ref()
        .is_some_and(|controller| controller.configured_scope().0 == &owner);
    let roles = state
        .window_controller
        .as_ref()
        .is_some_and(|controller| controller.roles_configured(&owner, &conversation));
    let worker_available = status
        .as_ref()
        .filter(|status| status.phase == ExecutionPhase::Running)
        .and_then(|status| status.run_id.as_ref())
        .is_some_and(|run| {
            deep.as_ref()
                .and_then(|scope| scope.tasks.as_ref())
                .is_some_and(|tasks| tasks.available(&owner, &conversation, run))
        });
    let capabilities = IntelligenceCapabilities {
        schema_version: 1,
        conversation_id: conversation,
        deep: capability(configured || deep.is_some(), deep.is_some(), true, 1),
        fast: capability(roles || fast.is_some(), fast.is_some(), false, 1),
        worker: capability(roles || worker_available, worker_available, false, 4),
    };
    Ok(Json(capabilities).into_response())
}

fn capability(configured: bool, available: bool, steer: bool, max_parallel: u32) -> RoleCapability {
    RoleCapability {
        configured,
        available: configured && available,
        stop: configured,
        steer: configured && steer,
        accept: configured,
        max_parallel: if configured { max_parallel } else { 0 },
    }
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_input",
        "Invalid conversation",
    )
}

#[cfg(test)]
#[path = "intelligence_http_tests.rs"]
mod tests;
