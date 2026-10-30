//! Owner routes of "New WhatsApp chat" (see `whatsapp_chats`).
//!
//! - `GET /api/v2/whatsapp-chats`: availability, providers, how many owner
//!   numbers a group gets, and the owner's provisions.
//! - `POST /api/v2/whatsapp-chats`: create, or continue the same request
//!   (with `agent_timers` configured it also issues the chat's agent-timer
//!   grant, see `whatsapp_chats`).
//! - `POST /api/v2/whatsapp-chats/{request}/relay-registered`: the operator
//!   registered the group with the scoped relay; the chat is ready.
//! - `POST /api/v2/whatsapp-chats/{request}/archive`: mark a provision
//!   archived (the V1 and adapter sides are retired by the operator).
use super::*;
use crate::archived_history_http::owner_credential;
use crate::whatsapp_chats::{self as chats, StageError};
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_store_sqlite::{ResourceError, WhatsAppChatIdentity};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v2/whatsapp-chats", get(directory).post(create))
        .route(
            "/api/v2/whatsapp-chats/{request}/relay-registered",
            post(relay_registered),
        )
        .route("/api/v2/whatsapp-chats/{request}/archive", post(archive))
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_whatsapp_chat",
        "Invalid WhatsApp chat request",
    )
}
fn unconfigured() -> Error {
    Error(
        StatusCode::NOT_FOUND,
        "whatsapp_chats_unconfigured",
        "New WhatsApp chats are not configured on this server",
    )
}
fn failure(error: ResourceError) -> Error {
    match error {
        ResourceError::Invalid => invalid(),
        ResourceError::Unauthorized => unauthorized(),
        ResourceError::NotFound => Error(StatusCode::NOT_FOUND, "not_found", "Not found"),
        ResourceError::Conflict("whatsapp_chat_conflict") => Error(
            StatusCode::CONFLICT,
            "whatsapp_chat_conflict",
            "This request id is already used for another chat",
        ),
        ResourceError::Conflict(code) => Error(StatusCode::CONFLICT, code, "Precondition refused"),
        ResourceError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Storage unavailable",
        ),
    }
}
fn request_key(value: &str) -> Result<String, Error> {
    Uuid::parse_str(value)
        .ok()
        .filter(|id| !id.is_nil() && id.hyphenated().to_string() == value)
        .map(|_| value.to_owned())
        .ok_or_else(invalid)
}

async fn directory(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let provisions = state
        .store
        .whatsapp_chats(&credential, &owner)
        .await
        .map_err(failure)?;
    let mut providers = vec![ConversationProvider::Codex];
    if state.claude_turns {
        providers.push(ConversationProvider::Claude);
    }
    let available = state.whatsapp_chats.is_some() && state.desktop_broker.is_some();
    Ok(Json(WhatsAppChatDirectory {
        available,
        providers,
        participants: state
            .whatsapp_chats
            .as_ref()
            .map_or(0, |c| c.participant_count()),
        provisions,
    })
    .into_response())
}

/// Create or continue. Answers the provision as far as it got: `201` when
/// this request reached `relay_pending` (or later), otherwise `202` with the
/// failed stage's `error`; a retry with the same id continues from there.
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<WhatsAppChatRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    let credential = browser::credential(&headers)?;
    let Json(request) = body.map_err(|_| invalid())?;
    if !request.is_valid() {
        return Err(invalid());
    }
    let (Some(config), Some(v1)) = (state.whatsapp_chats.clone(), state.desktop_broker.clone())
    else {
        return Err(unconfigured());
    };
    if request.provider == ConversationProvider::Claude && !state.claude_turns {
        return Err(Error(
            StatusCode::CONFLICT,
            "provider_unavailable",
            "Claude turns are not installed on this server",
        ));
    }
    let _running = config.lock.lock().await;
    // Stage 0: the conversation, keyed by the request id.
    let (conversation, _) = state
        .store
        .create_conversation_authenticated(
            &credential,
            &ConversationInput {
                client_request_id: request.client_request_id.clone(),
                name: request.name.clone(),
            },
        )
        .await
        .map_err(|error| match error {
            orkestr_v2_application::runtime::RuntimeStoreError::Conflict => Error(
                StatusCode::CONFLICT,
                "whatsapp_chat_conflict",
                "This request id is already used for another chat",
            ),
            orkestr_v2_application::runtime::RuntimeStoreError::Unauthorized => unauthorized(),
            _ => invalid(),
        })?;
    let mut provision = state
        .store
        .begin_whatsapp_chat(
            &credential,
            &owner,
            &WhatsAppChatIdentity {
                request_key: request.client_request_id.clone(),
                conversation_id: conversation.conversation_id.clone(),
                name: request.name.clone(),
                v1_thread_id: chats::new_thread_id(),
                remote_thread_id: Uuid::new_v4().to_string(),
                workspace: request.workspace.clone(),
            },
        )
        .await
        .map_err(failure)?;
    let key = provision.client_request_id.clone();
    let advance = |stage: WhatsAppChatStage, chat: Option<String>, error: Option<&'static str>| {
        let (store, credential, owner, key) = (
            state.store.clone(),
            credential.clone(),
            owner.clone(),
            key.clone(),
        );
        async move {
            store
                .advance_whatsapp_chat(&credential, &owner, &key, stage, chat.as_deref(), error)
                .await
                .map_err(failure)
        }
    };
    let outcome: Result<(), (WhatsAppChatStage, StageError)> = async {
        use WhatsAppChatStage as S;
        if provision.stage < S::Settings {
            let current = state
                .store
                .conversation_settings(&credential, &owner, &provision.conversation_id)
                .await
                .map_err(|_| (S::Conversation, StageError("settings_unavailable")))?;
            if current.revision == 0 {
                state
                    .store
                    .update_conversation_settings(
                        &credential,
                        &owner,
                        &provision.conversation_id,
                        &request.settings(),
                    )
                    .await
                    .map_err(|_| (S::Conversation, StageError("settings_refused")))?;
            }
            provision = advance(S::Settings, None, None)
                .await
                .map_err(|_| (S::Conversation, StageError("store_unavailable")))?;
        }
        if provision.stage < S::V1Thread {
            chats::create_thread(
                &v1,
                &provision.v1_thread_id,
                &provision.name,
                provision.workspace.as_deref(),
            )
            .await
            .map_err(|e| (S::Settings, e))?;
            provision = advance(S::V1Thread, None, None)
                .await
                .map_err(|_| (S::Settings, StageError("store_unavailable")))?;
        }
        let group = if provision.stage < S::AdapterBinding {
            // Reused by V1 when the thread is already bound to its group.
            let group = chats::create_group(&v1, &config, &provision.v1_thread_id, &provision.name)
                .await
                .map_err(|e| (S::V1Thread, e))?;
            provision = advance(S::Group, Some(group.chat_id.clone()), None)
                .await
                .map_err(|_| (S::V1Thread, StageError("whatsapp_group_not_recorded")))?;
            Some(group)
        } else {
            None
        };
        if provision.stage < S::AdapterBinding {
            let group = group.expect("group read above");
            let excluded = chats::existing_inputs(&v1, &provision.v1_thread_id)
                .await
                .map_err(|e| (S::Group, e))?;
            let conversation = provision.conversation_id.to_string();
            // The agent timer grant before the rules that name it. Issued
            // once: a retry keeps an issued grant whose file is installed.
            if let Some(path) = chats::timer_grant_path(&config, &conversation) {
                let refused = |_| (S::Group, StageError("agent_timer_grant_failed"));
                let issued = state
                    .store
                    .agent_timer_grant(&credential, &owner, &provision.conversation_id)
                    .await
                    .map_err(refused)?
                    .issued;
                if !(issued && chats::timer_grant_installed(&path)) {
                    let grant = state
                        .store
                        .issue_agent_timer_grant(&credential, &owner, &provision.conversation_id)
                        .await
                        .map_err(refused)?;
                    chats::install_timer_grant(&path, &grant.grant).map_err(|e| (S::Group, e))?;
                }
            }
            let rules = chats::write_rules(
                &config,
                &conversation,
                &provision.v1_thread_id,
                &group.chat_id,
                &provision.name,
            )
            .map_err(|e| (S::Group, e))?;
            let document = chats::binding_document(
                &config,
                &conversation,
                &provision.v1_thread_id,
                &group.chat_id,
                &group.account_id,
                &provision.remote_thread_id,
                excluded,
                rules.as_deref(),
            );
            chats::bind_adapter(&config, &provision.remote_thread_id, document)
                .await
                .map_err(|e| (S::Group, e))?;
            provision = advance(S::AdapterBinding, None, None)
                .await
                .map_err(|_| (S::Group, StageError("store_unavailable")))?;
        }
        if provision.stage < S::RelayPending {
            chats::delegate(
                &v1,
                &config,
                &provision.v1_thread_id,
                &provision.remote_thread_id,
            )
            .await
            .map_err(|e| (S::AdapterBinding, e))?;
            provision = advance(S::RelayPending, None, None)
                .await
                .map_err(|_| (S::AdapterBinding, StageError("store_unavailable")))?;
        }
        Ok(())
    }
    .await;
    let status = match outcome {
        Ok(()) => StatusCode::CREATED,
        Err((stage, StageError(code))) => {
            if let Ok(value) = advance(stage, None, Some(code)).await {
                provision = value;
            }
            StatusCode::ACCEPTED
        }
    };
    if !provision.is_valid() {
        return Err(failure(ResourceError::Unavailable));
    }
    Ok((status, Json(provision)).into_response())
}

async fn relay_registered(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(request): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let key = request_key(&request)?;
    let current = state
        .store
        .whatsapp_chats(&credential, &owner)
        .await
        .map_err(failure)?
        .into_iter()
        .find(|p| p.client_request_id == key)
        .ok_or_else(|| failure(ResourceError::NotFound))?;
    if current.stage < WhatsAppChatStage::RelayPending {
        return Err(Error(
            StatusCode::CONFLICT,
            "whatsapp_chat_not_delegated",
            "The chat is not delegated to V2 yet",
        ));
    }
    let value = state
        .store
        .advance_whatsapp_chat(
            &credential,
            &owner,
            &key,
            WhatsAppChatStage::Ready,
            None,
            None,
        )
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn archive(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(request): Path<String>,
    _body: Result<Json<serde_json::Value>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let key = request_key(&request)?;
    let value = state
        .store
        .archive_whatsapp_chat(&credential, &owner, &key)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

#[cfg(test)]
#[path = "whatsapp_chats_http_tests.rs"]
mod tests;
