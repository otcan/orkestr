//! Desk reservations over HTTP (`orkestr_v2_contracts::desk_verdict` and the
//! rules beside it). A chat's desktop grant, or the owner, reads a desk's
//! reservation with the verdict for the chat's next acquire, changes the
//! chat's own claim (`reserve`, `handoff`, `handback`, `unreserve`) and lists
//! every reservation by chat name. The owner frees a desk from Virtual Desks.
//! An acquire a reservation refuses answers `409 desk_busy` or
//! `desk_handed_to_owner` with the holder and up to three free desks.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::{conversation, failure, invalid};
use crate::desktop_http::caller;
use axum::extract::{
    rejection::{JsonRejection, QueryRejection},
    Path, Query,
};
use orkestr_v2_store_sqlite::{DesktopCaller, ResourceError};
use serde_json::{json, Value};
use std::collections::HashMap;

const V1_BODY_CAP: usize = 1024 * 1024;

pub(crate) fn router() -> Router<AppState> {
    let base = "/api/v2/conversations/{id}";
    Router::new()
        .route(
            &format!("{base}/desktops/{{slug}}/reservation"),
            get(read).post(change),
        )
        .route(&format!("{base}/desktop-reservations"), get(list))
        .route("/api/v2/desktops/{slug}/reservation", delete(clear))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadQuery {
    /// Preferred free desks, comma-separated, best first.
    #[serde(default)]
    candidates: Option<String>,
}

fn candidates(list: Option<&str>) -> Result<Vec<String>, Error> {
    let desks: Vec<String> = list
        .unwrap_or("")
        .split(',')
        .filter(|desk| !desk.is_empty())
        .map(str::to_owned)
        .collect();
    if desks.len() > DESK_CANDIDATES_MAX || desks.iter().any(|desk| !desktop_slug_valid(desk)) {
        return Err(invalid());
    }
    Ok(desks)
}

/// The desks V1 serves and the V1 thread holding each one's lease (expired
/// leases too: V1 refuses another thread then). `None` when V1 cannot be read.
async fn v1_holders(state: &AppState) -> Option<HashMap<String, Option<String>>> {
    let broker = state.desktop_broker.as_deref()?;
    let (status, value) = broker
        .read("/api/browser-sessions?inventory=owner", V1_BODY_CAP)
        .await
        .ok()?;
    if status != 200 || value.get("ok") != Some(&Value::Bool(true)) {
        return None;
    }
    let sessions = value.get("sessions")?.as_array()?;
    Some(
        sessions
            .iter()
            .filter_map(|session| {
                let slug = session.get("slug")?.as_str()?.to_owned();
                let holder = session.get("lease").filter(|l| !l.is_null()).map(|lease| {
                    lease
                        .get("threadId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned()
                });
                Some((slug, holder))
            })
            .collect(),
    )
}

/// Up to three desks `conversation` may use instead of `slug`: free in Core
/// (no other chat's claim, no handoff or owner viewing, no running step) and,
/// when V1 can be read, served by V1 with no lease of another V1 thread.
pub(crate) async fn free_desks(
    state: &AppState,
    caller: DesktopCaller<'_>,
    conversation: &ConversationId,
    slug: &str,
    preferred: &[String],
) -> Vec<String> {
    let Ok((thread, desks)) = state
        .store
        .desktop_free_candidates(caller, conversation, slug, preferred)
        .await
    else {
        return Vec::new();
    };
    let v1 = v1_holders(state).await;
    desks
        .into_iter()
        .filter(|desk| match &v1 {
            Some(view) => match view.get(desk) {
                Some(None) => true,
                Some(Some(holder)) => *holder == thread,
                None => false,
            },
            None => true,
        })
        .take(DESK_FREE_DESKS_MAX)
        .collect()
}

/// `409` for a step a reservation refuses: the holder (never another chat's
/// id), up to three free desks for `desk_busy` (none for a chat's own
/// handoff: it continues there after its handback), and a text that says
/// nothing was done.
pub(crate) async fn refusal(
    state: &AppState,
    caller: DesktopCaller<'_>,
    conversation: &ConversationId,
    mut reservation: DesktopReservationState,
    preferred: &[String],
) -> Response {
    let desk = reservation.desk.clone();
    if reservation.verdict == DeskVerdict::DeskBusy {
        reservation.free_desks = free_desks(state, caller, conversation, &desk, preferred).await;
    }
    let message = reservation
        .holder
        .as_ref()
        .map(|holder| desk_refusal_hint(reservation.verdict, holder, &reservation.free_desks))
        .unwrap_or_default();
    (
        StatusCode::CONFLICT,
        Json(json!({
            "code": reservation.verdict.code(),
            "message": message,
            "request_id": crate::observability::request_id()
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            "retryable": false,
            "desk": desk,
            "holder": reservation.holder,
            "free_desks": reservation.free_desks,
        })),
    )
        .into_response()
}

async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, slug)): Path<(String, String)>,
    query: Result<Query<ReadQuery>, QueryRejection>,
) -> Result<Response, Error> {
    let caller = caller(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let Query(query) = query.map_err(|_| invalid())?;
    let preferred = candidates(query.candidates.as_deref())?;
    let mut reservation = state
        .store
        .desktop_reservation(caller.store(), &conversation, &slug)
        .await
        .map_err(failure)?;
    if reservation.verdict == DeskVerdict::DeskBusy || query.candidates.is_some() {
        reservation.free_desks =
            free_desks(&state, caller.store(), &conversation, &slug, &preferred).await;
    }
    Ok(Json(reservation).into_response())
}

async fn change(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, slug)): Path<(String, String)>,
    request: Result<Json<DesktopReservationRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let caller = caller(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let Json(request) = request.map_err(|_| invalid())?;
    match state
        .store
        .change_desktop_reservation(caller.store(), &conversation, &slug, &request)
        .await
    {
        Ok(after) => Ok(Json(after).into_response()),
        Err(error @ ResourceError::Conflict("desk_busy" | "desk_handed_to_owner")) => {
            // Refused like a step: name the holder and the free desks.
            let current = state
                .store
                .desktop_reservation(caller.store(), &conversation, &slug)
                .await
                .map_err(failure)?;
            if current.verdict == DeskVerdict::Allowed {
                return Err(failure(error));
            }
            Ok(refusal(&state, caller.store(), &conversation, current, &[]).await)
        }
        Err(error) => Err(failure(error)),
    }
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let caller = caller(&state, &headers).await?;
    let value = state
        .store
        .desktop_reservations(caller.store(), &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

/// The owner frees a desk: its claim and viewing window end now. Lease rows
/// and V1 are untouched.
async fn clear(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    if !desktop_slug_valid(&slug) {
        return Err(invalid());
    }
    let ended = state
        .store
        .clear_desktop_reservations(&credential, &owner, &slug)
        .await
        .map_err(failure)?;
    Ok(Json(json!({"desk": slug, "ended": ended})).into_response())
}

/// The owner opened a viewing link: until it expires only the chat holding
/// the desk's task keeps working there (opened from a chat, `watching`, that
/// chat unless another one holds the desk). The link has been minted already,
/// so a failure here never withholds it; the answer says whether it was kept.
pub(crate) async fn record_owner_viewer(
    state: &AppState,
    owner: &OwnerId,
    credential: &str,
    slug: &str,
    link: &Value,
    watching: Option<&ConversationId>,
) -> Option<i64> {
    let expires = link
        .get("share")
        .and_then(|share| share.get("expiresAt"))
        .or_else(|| link.get("expiresAt"))
        .and_then(Value::as_str)
        .and_then(crate::live_map::timestamp_ms);
    state
        .store
        .record_owner_viewer(credential, owner, slug, expires, watching)
        .await
        .ok()
        .map(|window| window.until_ms)
}

#[cfg(test)]
#[path = "desktop_reservation_http_tests.rs"]
mod tests;
