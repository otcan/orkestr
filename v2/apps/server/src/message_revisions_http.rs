//! The owner edits or removes their own message. Authorship is decided by the
//! store from the message's recorded author, never from this request.
use super::*;
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_store_sqlite::MessageRevisionError;

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_message_revision",
        "Invalid message revision",
    )
}

fn ids(conversation: &str, message: &str) -> Result<(ConversationId, MessageId), Error> {
    let parse = |value: &str| {
        Uuid::parse_str(value)
            .ok()
            .filter(|id| !id.is_nil())
            .ok_or_else(invalid)
    };
    Ok((
        ConversationId(parse(conversation)?),
        MessageId(parse(message)?),
    ))
}

fn refusal(error: MessageRevisionError) -> Error {
    match error {
        MessageRevisionError::Invalid => invalid(),
        MessageRevisionError::Unauthorized => unauthorized(),
        MessageRevisionError::NotFound => {
            Error(StatusCode::NOT_FOUND, "not_found", "Message not found")
        }
        MessageRevisionError::NotOwnMessage => Error(
            StatusCode::FORBIDDEN,
            "not_owner_message",
            "Only your own messages can be edited or deleted",
        ),
        MessageRevisionError::AlreadyDeleted => Error(
            StatusCode::CONFLICT,
            "message_deleted",
            "This message was already deleted",
        ),
        MessageRevisionError::Stale => Error(
            StatusCode::CONFLICT,
            "message_revision_stale",
            "This message changed since you opened it",
        ),
        MessageRevisionError::Unchanged => Error(
            StatusCode::CONFLICT,
            "message_revision_unchanged",
            "The text is unchanged",
        ),
        MessageRevisionError::Conflict => Error(
            StatusCode::CONFLICT,
            "idempotency_conflict",
            "Request key already used with different content",
        ),
        MessageRevisionError::Restricted => Error(
            StatusCode::CONFLICT,
            "restricted_conversation",
            "Messages in a restricted thread cannot be edited or deleted",
        ),
        MessageRevisionError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "message_revision_unavailable",
            "Message revision unavailable",
        ),
    }
}

pub(crate) async fn revise(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, message)): Path<(String, String)>,
    body: Result<Json<MessageRevisionRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) =
        crate::archived_history_http::owner_credential(&state, &headers).await?;
    let (conversation, message) = ids(&id, &message)?;
    let Json(request) = body.map_err(|_| invalid())?;
    if !request.is_valid() {
        return Err(invalid());
    }
    // Own the transaction across a disconnected caller, like message admission.
    let receipt = tokio::spawn(async move {
        let receipt = state
            .store
            .revise_owner_message(&credential, &owner, &conversation, &message, &request)
            .await?;
        if receipt.agent_notified {
            if let Some(controller) = &state.window_controller {
                controller.wake_source_continuation(&credential);
            }
        }
        Ok::<_, MessageRevisionError>(receipt)
    })
    .await
    .map_err(|_| refusal(MessageRevisionError::Unavailable))?
    .map_err(refusal)?;
    Ok((
        if receipt.duplicate {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(receipt),
    )
        .into_response())
}

pub(crate) async fn history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, message)): Path<(String, String)>,
) -> Result<Response, Error> {
    let owner = crate::owner(&state, &headers).await?;
    let (conversation, message) = ids(&id, &message)?;
    let history = state
        .store
        .message_revision_history(&owner, &conversation, &message)
        .await
        .map_err(refusal)?;
    Ok(Json(history).into_response())
}

#[cfg(test)]
#[path = "message_revisions_http_tests.rs"]
mod tests;
