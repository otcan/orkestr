//! `GET /api/v2/conversations/{id}/message-times`: durable event times of
//! owner inputs and accepted replies, plus delivery receipts V1 recorded for
//! replies exported to it (WhatsApp-delegated conversations). Observation only.
use super::*;
use crate::archived_history_http::owner_credential;
use axum::extract::{rejection::QueryRejection, Path, Query};
use orkestr_v2_store_sqlite::ResourceError;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/v2/conversations/{id}/message-times", get(read))
}

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Page {
    after: Option<i64>,
    limit: Option<u32>,
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_input",
        "Invalid message times request",
    )
}

/// The V1 thread this conversation came from or is delegated by.
async fn v1_thread(
    state: &AppState,
    owner: &OwnerId,
    credential: &str,
    id: &ConversationId,
) -> Result<Option<String>, Error> {
    Ok(state
        .store
        .conversation_v1_link(credential, owner, id)
        .await
        .map_err(failure)?
        .filter(|thread| valid_v1_thread_id(thread)))
}

fn failure(error: ResourceError) -> Error {
    match error {
        ResourceError::Unauthorized => unauthorized(),
        ResourceError::NotFound => {
            Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
        }
        ResourceError::Invalid => invalid(),
        _ => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Message times unavailable",
        ),
    }
}

pub(crate) async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<Page>, QueryRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = Uuid::parse_str(&id)
        .ok()
        .filter(|id| !id.is_nil())
        .map(ConversationId)
        .ok_or_else(invalid)?;
    let Query(page) = query.map_err(|_| invalid())?;
    let after = page.after.unwrap_or(0);
    let limit = page
        .limit
        .unwrap_or(MESSAGE_TIMES_PAGE_MAX)
        .min(MESSAGE_TIMES_PAGE_MAX);
    let (rows, more) = state
        .store
        .message_times(&credential, &owner, &conversation, after, limit)
        .await
        .map_err(failure)?;
    // Receipts exist only where V1 recorded them for an exported reply.
    let mut receipts = std::collections::HashMap::new();
    if rows.iter().any(|r| r.reply) {
        if let Some(broker) = state.desktop_broker.clone() {
            if let Some(thread) = v1_thread(&state, &owner, &credential, &conversation).await? {
                let observed = state
                    .message_receipts
                    .observe(&owner, &conversation, &thread, broker.clone())
                    .await;
                // Cached data and in-flight responses never replace current
                // owner, conversation, link, or broker authority.
                let current = v1_thread(&state, &owner, &credential, &conversation).await?;
                if current.as_deref() == Some(thread.as_str())
                    && state
                        .desktop_broker
                        .as_ref()
                        .is_some_and(|b| std::sync::Arc::ptr_eq(b, &broker))
                {
                    receipts = observed;
                }
            }
        }
    }
    let times: Vec<MessageTime> = rows
        .into_iter()
        .filter_map(|r| {
            Some(MessageTime {
                sequence: r.sequence,
                kind: if r.reply {
                    MessageTimeKind::Reply
                } else {
                    MessageTimeKind::Input
                },
                at_ms: crate::live_map::timestamp_ms(&r.occurred_at).filter(|t| *t > 0)?,
                receipts: if r.reply {
                    receipts.remove(&r.event_id).unwrap_or_default()
                } else {
                    Vec::new()
                },
            })
        })
        .collect();
    let next_after = more.then(|| times.last().map(|t| t.sequence)).flatten();
    let page = MessageTimesPage {
        conversation_id: conversation,
        times,
        next_after,
    };
    if !page.is_valid() {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Message times unavailable",
        ));
    }
    Ok(Json(page).into_response())
}

#[cfg(test)]
#[path = "message_times_http_tests.rs"]
mod tests;
