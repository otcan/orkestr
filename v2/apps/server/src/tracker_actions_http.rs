//! Owner-only action decisions. The common router enforces browser origin/CSRF;
//! every Store call repeats exact owner authentication. No action grant accepted.
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::{conversation, failure, invalid};
use crate::*;
use axum::extract::{rejection::JsonRejection, Path};
use axum::routing::put;
use orkestr_v2_contracts::tracker_actions::*;
use orkestr_v2_store_sqlite::{history_import::HistoryError, TrackerCaller};
use std::time::Duration;

pub(crate) fn router() -> Router<AppState> {
    let base = "/api/v2/conversations/{id}/tracker";
    Router::new()
        .route(&format!("{base}/mail-status"), get(status))
        .route(&format!("{base}/mail-sources"), post(discover))
        .route(&format!("{base}/mail-source"), put(select).delete(remove))
        .route(
            &format!("{base}/mail-source/decisions/{{key}}"),
            get(source_receipt),
        )
        .route(&format!("{base}/check"), post(check))
        .route(
            &format!("{base}/checks/{{key}}"),
            get(check_receipt).delete(cancel),
        )
        .route(&format!("{base}/scan-reports"), get(reports))
        .layer(DefaultBodyLimit::max(32 * 1024))
}
pub(crate) fn body<T>(request: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    request.map(|Json(v)| v).map_err(|_| invalid())
}
pub(crate) fn history(error: HistoryError) -> Error {
    match error {
        HistoryError::Unauthorized => unauthorized(),
        HistoryError::Invalid => invalid(),
        HistoryError::NotFound => Error(
            StatusCode::NOT_FOUND,
            "tracker_action_not_found",
            "Tracker action not found",
        ),
        HistoryError::Conflict => Error(
            StatusCode::CONFLICT,
            "tracker_action_changed",
            "The source or check changed. Refresh to continue.",
        ),
        HistoryError::Unavailable => unavailable(),
    }
}
pub(crate) fn unavailable() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "tracker_reader_unavailable",
        "The mail reader is busy or unavailable. Try again shortly.",
    )
}

async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let config = state
        .store
        .tracker_config(
            TrackerCaller::Owner {
                credential: &credential,
                owner: &owner,
            },
            &conversation,
        )
        .await
        .map_err(failure)?;
    // Legacy configuration is not an opaque selection and may contain private
    // paths. Never serialize raw config or reader cursors into this endpoint.
    let selected = config
        .source_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<SelectedMailSource>(s).ok());
    let namespaces: std::collections::HashSet<_> = state
        .store
        .tracker_scan_namespaces(&credential, &owner, &conversation)
        .await
        .map_err(history)?
        .into_iter()
        .collect();
    let alerts: Vec<_> = state
        .tracker_mail
        .alerts()
        .into_iter()
        .filter(|(id, _)| namespaces.contains(id))
        .collect();
    let checks = state
        .store
        .tracker_pending_checks(&credential, &owner, &conversation)
        .await
        .map_err(history)?;
    Ok(Json(serde_json::json!({
        "recipe":config.recipe, "source_revision":config.source_revision, "source":selected, "checks":checks,
        "last_scan_ms":config.last_scan_ms, "scheduler_ready":state.timers.ready.load(std::sync::atomic::Ordering::Acquire),
        "reader":state.tracker_mail.pool.status(), "alerts":alerts, "local_mail_supported":cfg!(unix),
        "classifier_id":state.tracker_mail.rules.version, "classifier_digest":state.tracker_mail.digest,
    })).into_response())
}

async fn discover(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    state
        .store
        .tracker_config(
            TrackerCaller::Owner {
                credential: &credential,
                owner: &owner,
            },
            &conversation,
        )
        .await
        .map_err(failure)?;
    let slot = state
        .tracker_mail
        .pool
        .reserve(&owner, &conversation)
        .map_err(|_| unavailable())?;
    let env = state.tracker_mail.discovery_env.clone();
    let ticket = state
        .tracker_mail
        .pool
        .enqueue(slot, move || crate::tracker_mail_sources::discover(env))
        .map_err(|_| unavailable())?;
    let completed = ticket
        .wait(tokio::time::Instant::now() + Duration::from_secs(5))
        .await
        .map_err(|_| unavailable())?;
    let discovery = completed.result().map_err(|_| unavailable())?;
    let expires_ms = state
        .store
        .register_tracker_local_sources(&credential, &owner, &discovery.backing)
        .await
        .map_err(history)?;
    Ok(Json(
        serde_json::json!({"sources":discovery.sources,"expires_ms":expires_ms,"read_only":true}),
    )
    .into_response())
}

async fn select(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<TrackerSourceSelect>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let request = body(request)?;
    match state
        .store
        .tracker_source_receipt(&credential, &owner, &conversation, &request.request_key)
        .await
    {
        Ok(_) => {
            // Core compares the entire replay, before fresh discovery.
            let result = state
                .store
                .select_registered_tracker_scan_source(&credential, &owner, &conversation, &request)
                .await
                .map_err(history)?;
            return Ok(Json(result).into_response());
        }
        Err(HistoryError::NotFound) => {}
        Err(error) => return Err(history(error)),
    }
    if !request.source.is_valid() || !request.acknowledge_read_only_access {
        return Err(invalid());
    }
    let backing = state
        .store
        .tracker_local_source_for_selection(&credential, &owner, request.source.source_id)
        .await
        .map_err(history)?;
    let slot = state
        .tracker_mail
        .pool
        .reserve(&owner, &conversation)
        .map_err(|_| unavailable())?;
    let selected = request.source.clone();
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
    let result = state
        .store
        .select_registered_tracker_scan_source(&credential, &owner, &conversation, &request)
        .await
        .map_err(history)?;
    Ok(Json(result).into_response())
}

async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<TrackerSourceRemove>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let result = state
        .store
        .remove_tracker_scan_source(&credential, &owner, &conversation, &body(request)?)
        .await
        .map_err(history)?;
    if !result.duplicate {
        state.tracker_mail.pool.cancel_scope(&owner, &conversation);
    }
    Ok(Json(result).into_response())
}

async fn check(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<TrackerCheckRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let request = body(request)?;
    let prior = state
        .store
        .tracker_check_receipt(&credential, &owner, &conversation, &request.request_key)
        .await;
    match prior {
        Ok(_) => {} // Exact Core replay still checks the complete payload.
        Err(HistoryError::NotFound)
            if state
                .timers
                .ready
                .load(std::sync::atomic::Ordering::Acquire) => {}
        Err(HistoryError::NotFound) => return Err(unavailable()),
        Err(error) => return Err(history(error)),
    }
    let result = state
        .store
        .create_tracker_check(
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
    Ok(Json(result).into_response())
}

async fn check_receipt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, key)): Path<(String, String)>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let result = state
        .store
        .tracker_check_receipt(&credential, &owner, &conversation(&id)?, &key)
        .await
        .map_err(history)?;
    Ok(Json(result).into_response())
}
async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, key)): Path<(String, String)>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let result = state
        .store
        .cancel_tracker_check(&credential, &owner, &conversation, &key)
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
async fn reports(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let result = state
        .store
        .tracker_scan_reports(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(history)?;
    Ok(Json(result).into_response())
}

async fn source_receipt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, key)): Path<(String, String)>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let result = state
        .store
        .tracker_source_receipt(&credential, &owner, &conversation(&id)?, &key)
        .await
        .map_err(history)?;
    Ok(Json(result).into_response())
}

#[cfg(all(test, unix))]
#[path = "tracker_actions_http_tests.rs"]
mod tests;
