//! Per-conversation tracker (the job-tracking recipe's table).
//!
//! - `GET /api/v2/conversations/{id}/tracker`: rows, newest contact first.
//! - `PUT .../tracker {recipe, notify_on?}`: turn it on (owner).
//! - `POST .../tracker/events {request_key, events}`: record events
//!   (dedupe, merge, monotonic status); returns the changeset.
//! - `GET .../tracker/rows/{row}/events`: one row's timeline.
//! - `POST .../tracker/rows/{row}`: inline edit (owner, `expected_revision`).
//! - `POST .../tracker/merge {keep, absorb}`: merge two rows (owner).
//! - `GET .../tracker/export.csv?delimiter=comma|semicolon`: CSV download.
//! - `POST|DELETE .../tracker/grant`: issue (shown once) or revoke the
//!   conversation tracker annotation grant for the assistant (owner).
//!
//! Reads and the export accept the owner or the grant; grant events are annotations (header
//! `x-orkestr-tracker-grant`, machine requests only). Nothing here admits
//! input, wakes or steers a provider, or sends anything.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::{conversation, failure, invalid};
use axum::extract::{
    rejection::{JsonRejection, QueryRejection},
    Path, Query,
};
use orkestr_v2_store_sqlite::TrackerCaller;

pub(crate) fn router() -> Router<AppState> {
    let base = "/api/v2/conversations/{id}/tracker";
    Router::new()
        .route(base, get(page).put(enable))
        .route(&format!("{base}/events"), post(events))
        .route(&format!("{base}/rows/{{row}}/events"), get(timeline))
        .route(&format!("{base}/rows/{{row}}"), post(edit))
        .route(&format!("{base}/merge"), post(merge))
        .route(&format!("{base}/export.csv"), get(export))
        .route(&format!("{base}/grant"), post(issue).delete(revoke))
        .layer(DefaultBodyLimit::max(256 * 1024))
}

pub(crate) enum Caller {
    Owner(OwnerId, String),
    Grant(String),
}
impl Caller {
    pub(crate) fn store(&self) -> TrackerCaller<'_> {
        match self {
            Self::Owner(owner, credential) => TrackerCaller::Owner { credential, owner },
            Self::Grant(grant) => TrackerCaller::Grant(grant),
        }
    }
}
pub(crate) async fn caller(state: &AppState, headers: &HeaderMap) -> Result<Caller, Error> {
    let mut grants = headers.get_all(TRACKER_GRANT_HEADER).iter();
    let Some(grant) = grants.next() else {
        let (owner, credential) = owner_credential(state, headers).await?;
        return Ok(Caller::Owner(owner, credential));
    };
    if grants.next().is_some()
        || [header::COOKIE, header::AUTHORIZATION, header::ORIGIN]
            .iter()
            .any(|h| headers.contains_key(h))
    {
        return Err(unauthorized());
    }
    let grant = grant.to_str().map_err(|_| unauthorized())?;
    Ok(Caller::Grant(grant.to_owned()))
}
fn body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    body.map(|Json(v)| v).map_err(|_| invalid())
}
fn row_id(value: &str) -> Result<Uuid, Error> {
    Uuid::parse_str(value)
        .ok()
        .filter(|v| !v.is_nil() && v.hyphenated().to_string() == value)
        .ok_or_else(invalid)
}

async fn page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let caller = caller(&state, &headers).await?;
    let value = state
        .store
        .tracker_page(caller.store(), &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn enable(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<TrackerEnable>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let request = body(request)?;
    state
        .store
        .enable_tracker(&credential, &owner, &conversation, &request)
        .await
        .map_err(failure)?;
    let value = state
        .store
        .tracker_page(
            TrackerCaller::Owner {
                credential: &credential,
                owner: &owner,
            },
            &conversation,
        )
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<TrackerEventsRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let caller = caller(&state, &headers).await?;
    let request = body(request)?;
    let value = state
        .store
        .apply_tracker_events(caller.store(), &conversation(&id)?, &request)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn timeline(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, row)): Path<(String, String)>,
) -> Result<Response, Error> {
    let caller = caller(&state, &headers).await?;
    let value = state
        .store
        .tracker_row_events(caller.store(), &conversation(&id)?, row_id(&row)?)
        .await
        .map_err(failure)?;
    Ok(Json(serde_json::json!({ "events": value })).into_response())
}

async fn edit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, row)): Path<(String, String)>,
    request: Result<Json<TrackerRowEdit>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let request = body(request)?;
    let value = state
        .store
        .edit_tracker_row(
            &credential,
            &owner,
            &conversation(&id)?,
            row_id(&row)?,
            &request,
        )
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn merge(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<TrackerMerge>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let request = body(request)?;
    let value = state
        .store
        .merge_tracker_rows(&credential, &owner, &conversation(&id)?, &request)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExportQuery {
    delimiter: Option<String>,
}

async fn export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<ExportQuery>, QueryRejection>,
) -> Result<Response, Error> {
    let caller = caller(&state, &headers).await?;
    let Query(query) = query.map_err(|_| invalid())?;
    let delimiter = match query.delimiter.as_deref() {
        None | Some("comma") => ',',
        Some("semicolon") => ';',
        Some(_) => return Err(invalid()),
    };
    let page = state
        .store
        .tracker_page(caller.store(), &conversation(&id)?)
        .await
        .map_err(failure)?;
    let csv = tracker_csv(&page.rows, delimiter);
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"job-tracker.csv\"",
            ),
        ],
        csv,
    )
        .into_response())
}

async fn issue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .issue_tracker_grant(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok((StatusCode::CREATED, Json(value)).into_response())
}

async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    state
        .store
        .revoke_tracker_grant(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
#[path = "tracker_http_tests.rs"]
mod tests;
