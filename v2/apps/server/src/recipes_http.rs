//! Recipe gallery and one-click install.
//!
//! - `GET /api/v2/recipes`: the shipped recipes (owner).
//! - `POST /api/v2/recipes/{id}/install {request_key, timezone, mail_profile?}`
//!   (browser owner with CSRF): creates the recipe's conversation, turns on
//!   its tracker and mail source, creates and enables its calendar timers
//!   (silent unless changed) and issues the tracker grant (returned once).
//!   Replaying the same `request_key` returns the same conversation and
//!   changes nothing.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::failure;
use crate::recipes;
use crate::timer_http::dto;
use crate::tracker_mail::{resolve, MailSource};
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_store_sqlite::history_import::{
    timers::{
        calendar_timer::CalendarTimerCreate,
        policy::{PolicyUpdate, SilentMode},
        TimerSchedule, TimerState,
    },
    HistoryError,
};
use orkestr_v2_store_sqlite::TrackerCaller;
use sha2::{Digest, Sha256};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v2/recipes", get(list))
        .route("/api/v2/recipes/{id}/install", post(install))
}

fn invalid() -> Error {
    Error(StatusCode::BAD_REQUEST, "invalid_recipe_install", "Invalid recipe install request")
}
fn timer_failure(error: HistoryError) -> Error {
    match error {
        HistoryError::Invalid => Error(StatusCode::BAD_REQUEST, "invalid_timer", "The recipe timer was refused (check the time zone)"),
        HistoryError::Unauthorized => unauthorized(),
        HistoryError::NotFound => Error(StatusCode::NOT_FOUND, "not_found", "Not found"),
        _ => Error(StatusCode::CONFLICT, "recipe_timer_conflict", "The recipe timer could not be created"),
    }
}

/// Stable timer namespace per (conversation, recipe timer): replays reuse it.
fn namespace(conversation: &ConversationId, timer: &str) -> Uuid {
    let digest = Sha256::digest(format!("orkestr-v2-recipe-timer:{conversation}:{timer}").as_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Builder::from_random_bytes(bytes).into_uuid()
}

async fn list(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    owner_credential(&state, &headers).await?;
    let recipes = recipes::catalog().iter().map(|r| r.summary()).collect();
    Ok(Json(RecipeCatalog { recipes }).into_response())
}

async fn install(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<RecipeInstall>, JsonRejection>,
) -> Result<Response, Error> {
    // Creating a conversation is a browser-owner action (CSRF-guarded).
    let owner = browser::owner(&state, &headers).await?;
    browser::guard(&state, &axum::http::Method::POST, "recipe_install", &headers).await?;
    let credential = browser::credential(&headers)?;
    let Json(request) = request.map_err(|_| invalid())?;
    let recipe = recipes::find(&id).ok_or(Error(StatusCode::NOT_FOUND, "recipe_not_found", "No such recipe"))?;
    if !request.is_valid() {
        return Err(invalid());
    }
    let manifest = &recipe.manifest;
    // Validate every timer rule in this zone before creating anything.
    let rules = manifest
        .timers
        .iter()
        .map(|t| t.schedule.rule(&request.timezone))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Error(StatusCode::BAD_REQUEST, "invalid_timezone", "Unknown time zone"))?;
    let (summary, replay) = state
        .store
        .create_conversation_authenticated(
            &credential,
            &ConversationInput {
                client_request_id: format!("recipe:{id}:{}", request.request_key),
                name: manifest.conversation.name.clone(),
            },
        )
        .await
        .map_err(|e| match e {
            orkestr_v2_application::runtime::RuntimeStoreError::Unauthorized => unauthorized(),
            orkestr_v2_application::runtime::RuntimeStoreError::Conflict => Error(StatusCode::CONFLICT, "recipe_install_conflict", "This request_key was used for another install"),
            _ => Error(StatusCode::SERVICE_UNAVAILABLE, "store_unavailable", "Storage unavailable"),
        })?;
    let conversation = summary.conversation_id.clone();
    let tracker = manifest.tracker.as_ref();
    let mut grant = None;
    if let Some(tracker) = tracker {
        let config = state
            .store
            .enable_tracker(&credential, &owner, &conversation, &TrackerEnable { recipe: id.clone(), notify_on: tracker.notify_on.clone() })
            .await
            .map_err(failure)?;
        if let Some(mail) = &manifest.mail {
            if config.source_json.is_none() {
                let source = MailSource { mail: mail.clone(), profile: request.mail_profile.clone() };
                let json = serde_json::to_string(&source).map_err(|_| invalid())?;
                state.store.set_tracker_source(&credential, &owner, &conversation, Some(&json)).await.map_err(failure)?;
            }
        }
        if !config.grant_issued && !replay {
            grant = Some(state.store.issue_tracker_grant(&credential, &owner, &conversation).await.map_err(failure)?.grant);
        }
    }
    let mut timers = Vec::new();
    for (timer, rule) in manifest.timers.iter().zip(rules) {
        let ns = namespace(&conversation, &timer.id);
        let receipt = state
            .store
            .create_calendar_timer(
                &credential,
                &owner,
                &CalendarTimerCreate {
                    namespace: ns,
                    conversation_id: conversation.clone(),
                    label: timer.label.clone(),
                    schedule: TimerSchedule::Calendar(rule),
                    policy: PolicyUpdate {
                        silent_mode: if timer.silent_mode.as_deref() == Some("unless_changed") { SilentMode::UnlessChanged } else { SilentMode::Off },
                        pause_until_ms: None,
                        skip_dates: Vec::new(),
                        skip_timezone: None,
                        digest: None,
                        trigger: None,
                    },
                },
            )
            .await
            .map_err(timer_failure)?;
        if receipt.state == TimerState::Paused {
            let text = recipe
                .instructions(timer, &conversation.to_string(), &state.origin)
                .ok_or_else(invalid)?;
            state
                .timers
                .enable(
                    credential.clone(),
                    owner.clone(),
                    ns,
                    dto::Enable {
                        expected_revision: receipt.revision,
                        request_key: format!("recipe-enable:{ns}"),
                        conversation_id: conversation.clone(),
                        text,
                    },
                )
                .await
                .map_err(timer_failure)?;
        }
        timers.push(ns);
    }
    let tracker_page = state
        .store
        .tracker_page(TrackerCaller::Owner { credential: &credential, owner: &owner }, &conversation)
        .await
        .map_err(failure)?;
    let config = state
        .store
        .tracker_config(TrackerCaller::Owner { credential: &credential, owner: &owner }, &conversation)
        .await
        .map_err(failure)?;
    let source: Option<MailSource> = config.source_json.as_deref().and_then(|s| serde_json::from_str(s).ok());
    let mail = tokio::task::spawn_blocking(move || resolve(source.as_ref()).0)
        .await
        .map_err(|_| invalid())?;
    let installed = RecipeInstalled {
        recipe: id,
        conversation_id: conversation,
        conversation_name: summary.name,
        timers,
        tracker_grant: grant,
        tracker: tracker_page,
        mail,
    };
    Ok((if replay { StatusCode::OK } else { StatusCode::CREATED }, Json(installed)).into_response())
}

#[cfg(test)]
#[path = "recipes_http_tests.rs"]
mod tests;
