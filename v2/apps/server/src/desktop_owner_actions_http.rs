//! Owner Start, Stop and Link for the global Virtual Desks page, where a desk
//! need not be connected to any chat. Browser session only, so Bearer service
//! credentials and chat agents cannot reach these V1 lifecycle actions.
//!
//! V1 is called with no thread scope and applies its own policy: desks under
//! enforcement refuse outright, and on every other desk V1 performs no lease
//! check at all, so Stop cannot rely on it. Stop re-reads the reservation
//! itself just before acting and requires a confirmation that matches what it
//! finds. Lease state is never written from here: no force, no break-glass.
use super::*;
use crate::conversation_resources_http::invalid;
use crate::desktop_broker::Broker;
use crate::desktop_inventory_http::{lease_view, project, text, unavailable, LeaseView};
use crate::desktop_open_http::safe_share_url;
use axum::extract::{rejection::JsonRejection, Path};
use axum::http::HeaderValue;
use orkestr_v2_contracts::{stop_needs_confirmation, DesktopResource, DesktopRuntime};
use serde_json::{json, Value};
use std::time::Duration;

/// Below the route's 60 s allowance even with the surrounding V1 reads.
const ACTION_DEADLINE: Duration = Duration::from_secs(40);
const V1_BODY_CAP: usize = 1024 * 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v2/desktops/{slug}/start", post(start))
        .route("/api/v2/desktops/{slug}/stop", post(stop))
        .route("/api/v2/desktops/{slug}/link", post(link))
}

fn conflict(code: &'static str, message: &'static str) -> Error {
    Error(StatusCode::CONFLICT, code, message)
}
fn not_found() -> Error {
    Error(
        StatusCode::NOT_FOUND,
        "desktop_not_found",
        "This desk is no longer listed; refresh the list",
    )
}
fn denied() -> Error {
    Error(
        StatusCode::FORBIDDEN,
        "desktop_action_denied",
        "V1 only allows this from a chat that has reserved this desk; nothing was changed",
    )
}
fn outcome_unknown() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "desktop_action_unknown",
        "The outcome is unknown; refresh before taking another action",
    )
}
fn failed() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "desktop_action_failed",
        "V1 did not complete this action; refresh before trying again",
    )
}
fn broker(state: &AppState) -> Result<&Broker, Error> {
    state.desktop_broker.as_deref().ok_or_else(unavailable)
}

async fn inventory_row(broker: &Broker, slug: &str) -> Result<DesktopResource, Error> {
    let (status, value) = broker
        .read("/api/browser-sessions?inventory=owner", V1_BODY_CAP)
        .await
        .map_err(|_| unavailable())?;
    if status != 200 {
        return Err(unavailable());
    }
    project(&value)?
        .into_iter()
        .find(|desk| desk.slug == slug)
        .ok_or_else(not_found)
}

/// V1's per-desk lease read. Unlike the inventory, whose lease join reports a
/// store error as "no lease", any failure here surfaces as `unknown`.
async fn read_lease(broker: &Broker, slug: &str) -> LeaseView {
    match broker
        .read(&format!("/api/desktops/{slug}/lease"), V1_BODY_CAP)
        .await
    {
        Ok((200, body)) if body.get("ok") == Some(&Value::Bool(true)) => {
            lease_view(body.get("lease"))
        }
        _ => lease_view(None),
    }
}

/// Only a desk both reads report as free counts as free.
fn merged_reservation(fresh: LeaseView, row: &DesktopResource) -> LeaseView {
    if fresh.state == "unreserved" && row.lease_state != "unreserved" {
        return LeaseView {
            state: row.lease_state.clone(),
            holder: row.holder.clone(),
            expires_at: row.expires_at.clone(),
        };
    }
    fresh
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyRequest {}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct StopRequest {
    expected_lease_state: String,
    #[serde(default)]
    expected_holder: Option<String>,
    #[serde(default)]
    confirm_interruption: bool,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum StopCheck {
    Proceed,
    AlreadyStopped,
    ReservationChanged,
    ConfirmationRequired,
}

fn check_stop(runtime: DesktopRuntime, lease: &LeaseView, request: &StopRequest) -> StopCheck {
    if !runtime.can_stop() {
        return StopCheck::AlreadyStopped;
    }
    // The confirmation covers what the owner was shown, and nothing newer.
    if lease.state != request.expected_lease_state || lease.holder != request.expected_holder {
        return StopCheck::ReservationChanged;
    }
    if stop_needs_confirmation(&lease.state, runtime) && !request.confirm_interruption {
        return StopCheck::ConfirmationRequired;
    }
    StopCheck::Proceed
}

/// V1 lifecycle verb with an empty body: never a thread, token or force flag.
async fn act(broker: &Broker, slug: &str, action: &'static str) -> Result<Value, Error> {
    let (status, value) = broker
        .write_within(
            ACTION_DEADLINE,
            "POST",
            &format!("/api/browsers/{slug}/{action}"),
            json!({}),
            V1_BODY_CAP,
        )
        .await
        .map_err(|_| outcome_unknown())?;
    match status {
        200 | 201 => {}
        401 | 403 => return Err(denied()),
        404 => return Err(not_found()),
        409 => {
            return Err(conflict(
                "desktop_action_conflict",
                "V1 refused because this desk changed; refresh before trying again",
            ))
        }
        _ => return Err(failed()),
    }
    let browser = value.get("browser").cloned().unwrap_or(Value::Null);
    if browser.get("ok") == Some(&Value::Bool(false))
        || text(&browser, "stopError").is_some()
        || text(&browser, "launchError").is_some()
    {
        return Err(failed());
    }
    Ok(browser)
}

fn runtime_after(browser: &Value) -> String {
    text(browser, "status")
        .or_else(|| text(browser, "state"))
        .unwrap_or_else(|| "unknown".into())
}

/// V1 has no compare-and-stop, so a chat can still reserve the desk between
/// the last read and the stop. That window cannot be closed from here; report
/// it rather than let it pass silently.
fn interrupted_holder(before: &LeaseView, after: &LeaseView) -> Option<String> {
    if after.state != "reserved" || (before.state == "reserved" && before.holder == after.holder) {
        return None;
    }
    Some(
        after
            .holder
            .clone()
            .unwrap_or_else(|| "another chat".into()),
    )
}

async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    request: Result<Json<EmptyRequest>, JsonRejection>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    let Json(_) = request.map_err(|_| invalid())?;
    if !desktop_slug_valid(&slug) {
        return Err(invalid());
    }
    let broker = broker(&state)?;
    let row = inventory_row(broker, &slug).await?;
    if !DesktopRuntime::from_state(&row.state).can_start() {
        return Err(conflict(
            "desktop_start_not_applicable",
            "This desk is not stopped; refresh the list",
        ));
    }
    let browser = act(broker, &slug, "start").await?;
    browser::owner(&state, &headers).await?;
    Ok(Json(json!({"started":true,"state":runtime_after(&browser)})).into_response())
}

async fn stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    request: Result<Json<StopRequest>, JsonRejection>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    let Json(request) = request.map_err(|_| invalid())?;
    if !desktop_slug_valid(&slug) {
        return Err(invalid());
    }
    let broker = broker(&state)?;
    let row = inventory_row(broker, &slug).await?;
    // Last read before acting, so the unguarded window is as short as possible.
    let lease = merged_reservation(read_lease(broker, &slug).await, &row);
    match check_stop(DesktopRuntime::from_state(&row.state), &lease, &request) {
        StopCheck::Proceed => {}
        StopCheck::AlreadyStopped => {
            return Err(conflict(
                "desktop_stop_not_applicable",
                "This desk is already stopped; refresh the list",
            ))
        }
        StopCheck::ReservationChanged => {
            return Err(conflict(
                "desktop_reservation_changed",
                "This desk's reservation changed since the list was loaded; review it and confirm again",
            ))
        }
        StopCheck::ConfirmationRequired => {
            return Err(conflict(
                "desktop_stop_confirmation_required",
                "This desk is reserved or unverified; confirm the interruption to stop it",
            ))
        }
    }
    let browser = act(broker, &slug, "stop").await?;
    browser::owner(&state, &headers).await?;
    let after = read_lease(broker, &slug).await;
    Ok(Json(json!({
        "stopped": true,
        "state": runtime_after(&browser),
        "reservation_after_verified": after.state != "unknown",
        "interrupted_holder": interrupted_holder(&lease, &after),
    }))
    .into_response())
}

async fn link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    request: Result<Json<EmptyRequest>, JsonRejection>,
) -> Result<Response, Error> {
    browser::owner(&state, &headers).await?;
    let Json(_) = request.map_err(|_| invalid())?;
    if !desktop_slug_valid(&slug) {
        return Err(invalid());
    }
    // `start:false` keeps this from starting or repairing the desk. `ifAbsent`
    // keeps it from cancelling a link that someone is already using.
    let (status, value) = broker(&state)?
        .write_within(
            ACTION_DEADLINE,
            "POST",
            &format!("/api/desktops/{slug}/share"),
            json!({"start":false,"ifAbsent":true}),
            V1_BODY_CAP,
        )
        .await
        .map_err(|_| outcome_unknown())?;
    match status {
        200 | 201 => {}
        401 | 403 => return Err(denied()),
        404 | 405 => return Err(not_found()),
        409 => {
            return Err(conflict(
                "desktop_link_exists",
                "A link for this desk is still active. Use it, or wait for it to expire",
            ))
        }
        503 => {
            return Err(Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "desktop_link_not_ready",
                "This desk is not ready to share; refresh the list",
            ))
        }
        _ => return Err(failed()),
    }
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| safe_share_url(url))
        .ok_or_else(failed)?;
    // Never publish a newly minted link on authorization that has since lapsed.
    browser::owner(&state, &headers).await?;
    let expires_at = value
        .get("share")
        .and_then(|share| text(share, "expiresAt"));
    let mut response =
        Json(json!({"url":url,"challenge_required":true,"expires_at":expires_at})).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

#[cfg(test)]
#[path = "desktop_owner_actions_http_tests.rs"]
mod tests;
