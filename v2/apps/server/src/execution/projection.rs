//! Current execution rendering shared by single and batched owner reads.
use super::*;
use crate::execution_registry::ExecutionScope;

pub(crate) fn current_status(
    owner: &OwnerId,
    conversation: &ConversationId,
    scope: Option<&ExecutionScope>,
    status: Option<ExecutionStatus>,
) -> Result<Response, Error> {
    match status {
        None => Ok(StatusCode::NO_CONTENT.into_response()),
        Some(mut status) if status.conversation_id == *conversation && status.is_valid() => {
            apply_controls(owner, conversation, scope, &mut status);
            Ok(Json(status).into_response())
        }
        Some(_) => Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_projection",
            "Execution status unavailable",
        )),
    }
}

pub(super) fn apply_controls(
    owner: &OwnerId,
    conversation: &ConversationId,
    scope: Option<&ExecutionScope>,
    status: &mut ExecutionStatus,
) {
    status.capabilities.stop = status.phase == ExecutionPhase::Running
        && scope
            .and_then(|scope| scope.control.as_ref())
            .is_some_and(|control| {
                status
                    .run_id
                    .as_ref()
                    .is_some_and(|run| control.available(owner, conversation, run))
            });
    status.capabilities.steer = status.phase == ExecutionPhase::Running
        && status.queue_age_ms.is_none()
        && scope
            .and_then(|scope| scope.control.as_ref())
            .is_some_and(|control| {
                status
                    .run_id
                    .as_ref()
                    .is_some_and(|run| control.steering_available(owner, conversation, run))
            });
}
