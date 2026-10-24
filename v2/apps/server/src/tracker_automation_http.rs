//! Explicit recurring opt-in, separate from selecting mail or checking once.
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::conversation;
use crate::tracker_actions_http::{body, history, unavailable};
use crate::*;
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_contracts::tracker_automation::*;
use orkestr_v2_store_sqlite::history_import::HistoryError;

pub(crate) fn router() -> Router<AppState> {
    let base = "/api/v2/conversations/{id}/tracker/automation";
    Router::new()
        .route(base, get(status).post(enable).delete(disable))
        .route(&format!("{base}/decisions/{{key}}"), get(receipt))
        .layer(DefaultBodyLimit::max(32 * 1024))
}
async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let result = state
        .store
        .tracker_automation_status(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(history)?;
    Ok(Json(result).into_response())
}
async fn enable(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<TrackerAutomationEnable>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let request = body(request)?;
    let prior = state
        .store
        .tracker_automation_receipt(&credential, &owner, &conversation, &request.request_key)
        .await;
    // Historical receipt recovery precedes scheduler/readiness/package checks.
    let completed = match prior {
        Ok(_) => None,
        Err(HistoryError::NotFound) => {
            if !state
                .timers
                .ready
                .load(std::sync::atomic::Ordering::Acquire)
            {
                return Err(unavailable());
            }
            let (selected, backing) = state
                .store
                .tracker_selected_source_backing(
                    &credential,
                    &owner,
                    &conversation,
                    request.expected_source_revision,
                )
                .await
                .map_err(history)?;
            let slot = state
                .tracker_mail
                .pool
                .reserve(&owner, &conversation)
                .map_err(|_| unavailable())?;
            let ticket = state
                .tracker_mail
                .pool
                .enqueue(slot, move || {
                    crate::tracker_mail_sources::resolve(&backing, &selected).map(|_| ())
                })
                .map_err(|_| unavailable())?;
            let completed = ticket
                .wait(tokio::time::Instant::now() + Duration::from_secs(5))
                .await
                .map_err(|_| unavailable())?;
            completed.result().map_err(|_| unavailable())?;
            Some(completed)
        }
        Err(error) => return Err(history(error)),
    };
    let result = state
        .store
        .enable_tracker_automation(
            &credential,
            &owner,
            &conversation,
            &request,
            (
                &state.tracker_mail.rules.version,
                &state.tracker_mail.digest,
            ),
        )
        .await
        .map_err(history)?;
    drop(completed);
    Ok(Json(result).into_response())
}
async fn disable(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<TrackerAutomationDisable>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let request = body(request)?;
    let result = state
        .store
        .disable_tracker_automation(&credential, &owner, &conversation, &request)
        .await
        .map_err(history)?;
    if let Some(authority) = &result.authority {
        state
            .tracker_mail
            .pool
            .cancel_action(&owner, &conversation, authority.namespace);
    }
    Ok(Json(result).into_response())
}
async fn receipt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, key)): Path<(String, String)>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let result = state
        .store
        .tracker_automation_receipt(&credential, &owner, &conversation(&id)?, &key)
        .await
        .map_err(history)?;
    Ok(Json(result).into_response())
}
