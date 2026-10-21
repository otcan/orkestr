//! Owner management of linked V1 chats through V1's API (V1 web UI parity):
//! model and effort, timers (list, create, edit, pause, resume, delete),
//! WhatsApp binding options and desktop grants/leases (read-only). Only
//! threads the sidebar lists are reachable. Writes to a thread whose runtime
//! is delegated to V2 are refused: it is managed through its V2 conversation.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::desktop_broker::Broker;
use crate::sidebar_http::listed_thread;
use crate::sidebar_v1::V1Thread;
use axum::extract::{rejection::JsonRejection, Path};
use serde_json::{json, Value};
use std::collections::HashMap;

const CAP: usize = 2 * 1024 * 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v2/v1-threads/{thread}/settings",
            get(settings).put(update_settings),
        )
        .route(
            "/api/v2/v1-threads/{thread}/timers",
            get(timers).post(create_timer),
        )
        .route(
            "/api/v2/v1-threads/{thread}/timers/{timer}",
            axum::routing::patch(edit_timer).delete(delete_timer),
        )
        .route(
            "/api/v2/v1-threads/{thread}/timers/{timer}/{action}",
            post(timer_action),
        )
        .route(
            "/api/v2/v1-threads/{thread}/whatsapp",
            get(whatsapp).put(update_whatsapp),
        )
        .route("/api/v2/v1-threads/{thread}/desktops", get(desktops))
}

fn invalid() -> Error {
    Error(
        StatusCode::BAD_REQUEST,
        "invalid_v1_request",
        "Invalid V1 management request",
    )
}
fn unavailable() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "v1_unavailable",
        "V1 did not answer; nothing is assumed",
    )
}
fn delegated() -> Error {
    Error(
        StatusCode::CONFLICT,
        "v1_thread_delegated",
        "This chat runs on V2; manage it in its V2 conversation",
    )
}
fn refused(status: u16, value: &Value) -> Error {
    match status {
        404 => crate::sidebar_http::not_listed(),
        409 if text(value, "error").as_deref() == Some("timer_owned_by_v2") => Error(
            StatusCode::CONFLICT,
            "timer_owned_by_v2",
            "This timer is run by V2; manage it in the V2 conversation",
        ),
        400..=499 => Error(StatusCode::CONFLICT, "v1_refused", "V1 refused the change"),
        _ => unavailable(),
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.chars().take(4096).collect())
}
fn short(value: &Value, key: &str, max: usize) -> Option<String> {
    text(value, key).filter(|v| v.chars().count() <= max && !v.chars().any(char::is_control))
}

async fn thread_for(
    state: &AppState,
    headers: &HeaderMap,
    thread: &str,
) -> Result<(std::sync::Arc<Broker>, V1Thread), Error> {
    let (owner, credential) = owner_credential(state, headers).await?;
    if !valid_v1_thread_id(thread) {
        return Err(invalid());
    }
    listed_thread(state, &owner, &credential, thread).await
}

async fn call(
    broker: &Broker,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, Error> {
    let result = match body {
        None if method == "GET" => broker.read(path, CAP).await,
        body => {
            broker
                .write(method, path, body.unwrap_or(json!({})), CAP)
                .await
        }
    };
    match result {
        Ok((200..=299, value)) => Ok(value),
        Ok((status, value)) => Err(refused(status, &value)),
        Err(_) => Err(unavailable()),
    }
}

// ---- model and effort

pub(crate) fn settings_view(thread: &str, value: &Value) -> V1ThreadSettings {
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|m| {
                    let id = short(m, "id", 120).or_else(|| short(m, "model", 120))?;
                    let efforts = m
                        .get("supportedReasoningEfforts")
                        .and_then(Value::as_array)
                        .map(|e| {
                            e.iter()
                                .filter_map(|x| {
                                    x.as_str()
                                        .map(str::to_owned)
                                        .or_else(|| short(x, "reasoningEffort", 32))
                                })
                                .take(16)
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(V1Model {
                        id,
                        efforts,
                        default_effort: short(m, "defaultReasoningEffort", 32),
                    })
                })
                .take(64)
                .collect()
        })
        .unwrap_or_default();
    V1ThreadSettings {
        thread_id: thread.to_owned(),
        model: short(value, "model", 120),
        effort: short(value, "effort", 32),
        models,
        read_only: value.get("readOnly").and_then(Value::as_bool) == Some(true),
        read_only_reason: short(value, "readOnlyReason", 200),
    }
}

async fn settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
) -> Result<Response, Error> {
    let (broker, record) = thread_for(&state, &headers, &thread).await?;
    let value = call(
        &broker,
        "GET",
        &format!("/api/threads/{}/model-settings", record.id),
        None,
    )
    .await?;
    Ok(Json(settings_view(&record.id, &value)).into_response())
}

async fn update_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
    body: Result<Json<V1ThreadSettingsUpdate>, JsonRejection>,
) -> Result<Response, Error> {
    let (broker, record) = thread_for(&state, &headers, &thread).await?;
    let Json(update) = body.map_err(|_| invalid())?;
    if !update.is_valid() {
        return Err(invalid());
    }
    if record.delegated {
        return Err(delegated());
    }
    let path = format!("/api/threads/{}/model-settings", record.id);
    call(
        &broker,
        "POST",
        &path,
        Some(json!({"model": update.model, "effort": update.effort})),
    )
    .await?;
    let value = call(&broker, "GET", &path, None).await?;
    Ok(Json(settings_view(&record.id, &value)).into_response())
}

// ---- timers

pub(crate) fn timer_view(value: &Value) -> Option<V1Timer> {
    Some(V1Timer {
        id: short(value, "id", 200)?,
        label: short(value, "label", 200),
        cadence: short(value, "cadence", 32),
        time: short(value, "time", 32),
        every: short(value, "every", 32),
        timezone: short(value, "timezone", 64),
        run_at: short(value, "runAt", 64),
        prompt: text(value, "prompt"),
        enabled: value.get("enabled").and_then(Value::as_bool) == Some(true),
        owned_by_v2: text(value, "ownedBy").as_deref() == Some("v2"),
        next_run_at: short(value, "nextRunAt", 64),
        last_run_at: short(value, "lastRunAt", 64),
        last_error: short(value, "lastError", 300),
    })
}

async fn timer_list(broker: &Broker, thread: &str) -> Result<Vec<V1Timer>, Error> {
    let value = call(
        broker,
        "GET",
        &format!("/api/threads/{thread}/timers"),
        None,
    )
    .await?;
    Ok(value
        .get("timers")
        .and_then(Value::as_array)
        .map(|t| t.iter().filter_map(timer_view).take(200).collect())
        .unwrap_or_default())
}

async fn timers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
) -> Result<Response, Error> {
    let (broker, record) = thread_for(&state, &headers, &thread).await?;
    let timers = timer_list(&broker, &record.id).await?;
    Ok(Json(V1TimerList {
        thread_id: record.id,
        timers,
    })
    .into_response())
}

fn timer_body(input: &V1TimerInput) -> Value {
    let mut body = json!({"label": input.label, "cadence": input.cadence, "prompt": input.prompt});
    for (key, value) in [
        ("time", &input.time),
        ("every", &input.every),
        ("runAt", &input.run_at),
        ("timezone", &input.timezone),
    ] {
        if let Some(value) = value {
            body[key] = json!(value);
        }
    }
    body
}

/// Request id → created V1 timer id, so a retried create never adds a second
/// timer while this process runs. Across restarts the client sees the timer
/// in the list before retrying.
#[derive(Default, Clone)]
pub(crate) struct CreatedTimers(std::sync::Arc<tokio::sync::Mutex<HashMap<String, String>>>);

async fn create_timer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
    body: Result<Json<V1TimerInput>, JsonRejection>,
) -> Result<Response, Error> {
    let (broker, record) = thread_for(&state, &headers, &thread).await?;
    let Json(input) = body.map_err(|_| invalid())?;
    if !input.is_valid() {
        return Err(invalid());
    }
    if record.delegated {
        return Err(delegated());
    }
    let mut created = state.v1_timers.0.lock().await;
    let key = format!("{}:{}", record.id, input.client_request_id);
    if let Some(id) = created.get(&key) {
        let found = timer_list(&broker, &record.id)
            .await?
            .into_iter()
            .find(|t| &t.id == id);
        return found
            .map(|t| (StatusCode::OK, Json(t)).into_response())
            .ok_or_else(unavailable);
    }
    let value = call(
        &broker,
        "POST",
        &format!("/api/threads/{}/timers", record.id),
        Some(timer_body(&input)),
    )
    .await?;
    let timer = value
        .get("timer")
        .and_then(timer_view)
        .ok_or_else(unavailable)?;
    created.insert(key, timer.id.clone());
    Ok((StatusCode::CREATED, Json(timer)).into_response())
}

/// V1's per-thread timer routes do not check that the timer belongs to the
/// thread; this does, and refuses timers V2 runs.
async fn owned_timer(broker: &Broker, thread: &str, timer: &str) -> Result<V1Timer, Error> {
    let found = timer_list(broker, thread)
        .await?
        .into_iter()
        .find(|t| t.id == timer)
        .ok_or_else(crate::sidebar_http::not_listed)?;
    if found.owned_by_v2 {
        return Err(refused(409, &json!({"error": "timer_owned_by_v2"})));
    }
    Ok(found)
}

async fn edit_timer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((thread, timer)): Path<(String, String)>,
    body: Result<Json<V1TimerInput>, JsonRejection>,
) -> Result<Response, Error> {
    let (broker, record) = thread_for(&state, &headers, &thread).await?;
    let Json(input) = body.map_err(|_| invalid())?;
    if !input.is_valid() {
        return Err(invalid());
    }
    if record.delegated {
        return Err(delegated());
    }
    owned_timer(&broker, &record.id, &timer).await?;
    let value = call(
        &broker,
        "PATCH",
        &format!("/api/threads/{}/timers/{timer}", record.id),
        Some(timer_body(&input)),
    )
    .await?;
    let timer = value
        .get("timer")
        .and_then(timer_view)
        .ok_or_else(unavailable)?;
    Ok(Json(timer).into_response())
}

async fn timer_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((thread, timer, action)): Path<(String, String, String)>,
) -> Result<Response, Error> {
    if !matches!(action.as_str(), "pause" | "resume") {
        return Err(invalid());
    }
    let (broker, record) = thread_for(&state, &headers, &thread).await?;
    if record.delegated {
        return Err(delegated());
    }
    owned_timer(&broker, &record.id, &timer).await?;
    let value = call(
        &broker,
        "POST",
        &format!("/api/threads/{}/timers/{timer}/{action}", record.id),
        Some(json!({})),
    )
    .await?;
    let timer = value
        .get("timer")
        .and_then(timer_view)
        .ok_or_else(unavailable)?;
    Ok(Json(timer).into_response())
}

async fn delete_timer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((thread, timer)): Path<(String, String)>,
) -> Result<Response, Error> {
    let (broker, record) = thread_for(&state, &headers, &thread).await?;
    if record.delegated {
        return Err(delegated());
    }
    owned_timer(&broker, &record.id, &timer).await?;
    call(
        &broker,
        "DELETE",
        &format!("/api/threads/{}/timers/{timer}", record.id),
        Some(json!({})),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---- WhatsApp binding options

pub(crate) fn whatsapp_view(record: &V1Thread, thread: &Value) -> V1WhatsAppOptions {
    let empty = json!({});
    let binding = thread
        .get("binding")
        .filter(|b| b.is_object())
        .unwrap_or(&empty);
    let flag = |key: &str| binding.get(key).and_then(Value::as_bool) == Some(true);
    V1WhatsAppOptions {
        thread_id: record.id.clone(),
        chat_id: short(binding, "chatId", 256),
        display_name: short(binding, "displayName", 300),
        enabled: binding.get("enabled").and_then(Value::as_bool) != Some(false)
            && binding.get("chatId").is_some(),
        reply_prefix: short(binding, "replyPrefix", 64),
        suppress_updates: flag("suppressWhatsAppUpdates"),
        suppress_debug_footer: flag("suppressWhatsAppDebugFooter"),
        additional_participants_enabled: flag("additionalParticipantsEnabled"),
        additional_participant_ids: binding
            .get("additionalParticipantIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .filter(|id| whatsapp_participant_id(id))
                    .map(str::to_owned)
                    .take(V1_PARTICIPANTS_MAX)
                    .collect()
            })
            .unwrap_or_default(),
        delegated: record.delegated,
    }
}

async fn read_thread(broker: &Broker, thread: &str) -> Result<Value, Error> {
    let value = call(broker, "GET", &format!("/api/threads/{thread}"), None).await?;
    value.get("thread").cloned().ok_or_else(unavailable)
}

async fn whatsapp(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
) -> Result<Response, Error> {
    let (broker, record) = thread_for(&state, &headers, &thread).await?;
    let value = read_thread(&broker, &record.id).await?;
    Ok(Json(whatsapp_view(&record, &value)).into_response())
}

async fn update_whatsapp(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
    body: Result<Json<V1WhatsAppOptionsUpdate>, JsonRejection>,
) -> Result<Response, Error> {
    let (broker, record) = thread_for(&state, &headers, &thread).await?;
    let Json(update) = body.map_err(|_| invalid())?;
    if !update.is_valid() {
        return Err(invalid());
    }
    if record.delegated {
        return Err(delegated());
    }
    let current = read_thread(&broker, &record.id).await?;
    if current
        .get("binding")
        .and_then(|b| b.get("chatId"))
        .is_none()
    {
        return Err(Error(
            StatusCode::CONFLICT,
            "v1_thread_unbound",
            "This V1 thread has no WhatsApp chat",
        ));
    }
    // Only the owner-managed options; V1 keeps every other binding field.
    let body = json!({
        "replyPrefix": update.reply_prefix.clone().unwrap_or_default(),
        "suppressWhatsAppUpdates": update.suppress_updates,
        "suppressWhatsAppDebugFooter": update.suppress_debug_footer,
        "additionalParticipantsEnabled": update.additional_participants_enabled,
        "additionalParticipantIds": update.additional_participant_ids,
    });
    call(
        &broker,
        "PUT",
        &format!("/api/threads/{}/binding", record.id),
        Some(body),
    )
    .await?;
    let value = read_thread(&broker, &record.id).await?;
    Ok(Json(whatsapp_view(&record, &value)).into_response())
}

// ---- desktops (read-only)

pub(crate) fn desktops_view(thread: &str, grants: &Value, leases: &Value) -> V1Desktops {
    V1Desktops {
        thread_id: thread.to_owned(),
        grants: grants
            .get("grants")
            .and_then(Value::as_array)
            .map(|g| {
                g.iter()
                    .filter_map(|g| {
                        Some(V1DesktopGrant {
                            slug: short(g, "desktopSlug", 128)
                                .or_else(|| short(g, "resourceKey", 128))?,
                            permissions: g
                                .get("permissions")
                                .and_then(Value::as_array)
                                .map(|p| {
                                    p.iter()
                                        .filter_map(Value::as_str)
                                        .filter(|p| p.len() <= 32)
                                        .map(str::to_owned)
                                        .take(8)
                                        .collect()
                                })
                                .unwrap_or_default(),
                            expires_at: short(g, "expiresAt", 64),
                        })
                    })
                    .take(64)
                    .collect()
            })
            .unwrap_or_default(),
        // Mapped field by field: V1 lease rows also carry fencing tokens.
        leases: leases
            .get("desktopLeases")
            .and_then(Value::as_array)
            .map(|l| {
                l.iter()
                    .filter(|l| text(l, "threadId").as_deref() == Some(thread))
                    .filter_map(|l| {
                        Some(V1DesktopLease {
                            slug: short(l, "desktopSlug", 128)?,
                            state: if l.get("active").and_then(Value::as_bool) == Some(true) {
                                "active".into()
                            } else {
                                "released".into()
                            },
                            expires_at: short(l, "expiresAt", 64),
                            purpose: short(l, "purpose", 200),
                        })
                    })
                    .take(64)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

async fn desktops(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
) -> Result<Response, Error> {
    let (broker, record) = thread_for(&state, &headers, &thread).await?;
    let grants = call(
        &broker,
        "GET",
        &format!("/api/threads/{}/desktop-grants", record.id),
        None,
    )
    .await?;
    let leases = call(
        &broker,
        "GET",
        &format!("/api/desktops/leases?threadId={}", record.id),
        None,
    )
    .await?;
    Ok(Json(desktops_view(&record.id, &grants, &leases)).into_response())
}

#[cfg(test)]
#[path = "v1_manage_http_tests.rs"]
mod tests;
