//! Conversation desktop leases brokered by V1. The owner binds a
//! conversation to one V1 thread and slugs and issues a conversation desktop
//! grant for that conversation's Workers. Lease routes accept the owner or
//! the grant (header `x-orkestr-desktop-grant`, machine requests only).
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::{conversation, failure, invalid};
use crate::desktop_broker::BrokerError;
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_store_sqlite::DesktopCaller;

pub(crate) fn router() -> Router<AppState> {
    let base = "/api/v2/conversations/{id}";
    Router::new()
        .route(&format!("{base}/desktop-binding"), get(binding).put(bind))
        .route(
            &format!("{base}/desktop-binding/grant"),
            post(issue).delete(revoke),
        )
        .route(&format!("{base}/desktops"), get(list))
        .route(&format!("{base}/desktops/{{slug}}/acquire"), post(acquire))
        .route(
            &format!("{base}/desktops/{{slug}}/heartbeat"),
            post(heartbeat),
        )
        .route(&format!("{base}/desktops/{{slug}}/release"), post(release))
}

enum Caller {
    Owner(OwnerId, String),
    Grant(String),
}
impl Caller {
    fn store(&self) -> DesktopCaller<'_> {
        match self {
            Self::Owner(owner, credential) => DesktopCaller::Owner { credential, owner },
            Self::Grant(grant) => DesktopCaller::Grant(grant),
        }
    }
}
async fn caller(state: &AppState, headers: &HeaderMap) -> Result<Caller, Error> {
    let mut grants = headers.get_all(DESKTOP_GRANT_HEADER).iter();
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
fn broker(state: &AppState) -> Result<&desktop_broker::Broker, Error> {
    state.desktop_broker.as_deref().ok_or(Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "desktop_broker_unconfigured",
        "Desktop broker is not configured",
    ))
}
fn broker_failure(error: BrokerError) -> Error {
    match error {
        BrokerError::Leased => Error(
            StatusCode::CONFLICT,
            "desktop_leased",
            "Desktop is leased by another holder",
        ),
        BrokerError::Lost => Error(
            StatusCode::CONFLICT,
            "desktop_lease_lost",
            "Desktop lease is no longer held",
        ),
        BrokerError::Denied => Error(
            StatusCode::FORBIDDEN,
            "desktop_denied_by_v1",
            "V1 denied the desktop",
        ),
        BrokerError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "desktop_broker_unavailable",
            "Desktop broker unavailable",
        ),
    }
}
fn not_granted() -> Error {
    Error(
        StatusCode::FORBIDDEN,
        "desktop_not_granted_by_v1",
        "V1 does not grant this desktop to the bound thread",
    )
}
fn json<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    body.map(|Json(v)| v).map_err(|_| invalid())
}

async fn binding(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .desktop_binding(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

/// When V1 is reachable, every bound slug must be granted to the V1 thread.
async fn bind(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<DesktopBindingRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let request = json(request)?;
    if !request.is_valid() {
        return Err(invalid());
    }
    if let Some(broker) = state.desktop_broker.as_deref() {
        let granted = broker
            .granted_slugs(&request.v1_thread_id)
            .await
            .map_err(broker_failure)?;
        if request.desktop_slugs.iter().any(|s| !granted.contains(s)) {
            return Err(not_granted());
        }
    }
    let value = state
        .store
        .bind_desktops(&credential, &owner, &conversation, &request)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn issue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let value = state
        .store
        .issue_desktop_grant(&credential, &owner, &conversation(&id)?)
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
    let value = state
        .store
        .revoke_desktop_grant(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let caller = caller(&state, &headers).await?;
    let value = state
        .store
        .desktop_leases(caller.store(), &conversation(&id)?)
        .await
        .map_err(failure)?;
    Ok(Json(value).into_response())
}

async fn acquire(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, slug)): Path<(String, String)>,
    request: Result<Json<DesktopAcquireRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let caller = caller(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let request = json(request)?;
    if !request.is_valid() || !desktop_slug_valid(&slug) {
        return Err(invalid());
    }
    let broker = broker(&state)?;
    let store = &state.store;
    let prepared = store
        .prepare_desktop_acquire(caller.store(), &conversation, &slug)
        .await
        .map_err(failure)?;
    let thread = prepared.v1_thread_id.clone();
    if !broker
        .granted_slugs(&thread)
        .await
        .map_err(broker_failure)?
        .contains(&slug)
    {
        return Err(not_granted());
    }
    let id = conversation.to_string();
    let grant = broker
        .acquire(
            &thread,
            &slug,
            request.ttl_ms,
            request.purpose.as_deref(),
            &id,
        )
        .await
        .map_err(broker_failure)?;
    match store
        .record_desktop_acquired(
            caller.store(),
            &conversation,
            &prepared,
            &slug,
            &grant,
            request.ttl_ms,
        )
        .await
    {
        Ok(granted) => Ok((StatusCode::CREATED, Json(granted)).into_response()),
        Err(error) => {
            // Never keep a V1 lease V2 did not record.
            let _ = broker
                .release(
                    &thread,
                    &slug,
                    &grant.fencing_token,
                    "orkestr_v2_unrecorded",
                )
                .await;
            Err(failure(error))
        }
    }
}

async fn heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, slug)): Path<(String, String)>,
    request: Result<Json<DesktopHeartbeatRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let caller = caller(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let request = json(request)?;
    if !request.is_valid() {
        return Err(invalid());
    }
    let broker = broker(&state)?;
    let store = &state.store;
    let token = request.fencing_token.as_str();
    let fence = store
        .desktop_fence(caller.store(), &conversation, &slug, token)
        .await
        .map_err(failure)?;
    if let Err(error) = broker.heartbeat(&fence.v1_thread_id, &slug, token).await {
        return Err(lost(store, &caller, &conversation, &fence, error).await);
    }
    let mut extended = None;
    if let Some(ttl) = request.extend_ttl_ms {
        // V1 heartbeat does not extend expiry; a same-thread acquire renews it
        // and must keep the exact fencing token and version.
        let id = conversation.to_string();
        match broker
            .acquire(&fence.v1_thread_id, &slug, ttl, None, &id)
            .await
        {
            Ok(renewed)
                if renewed.fencing_token == token
                    && renewed.fencing_version == fence.fencing_version =>
            {
                extended = Some((renewed.expires_at, ttl));
            }
            Ok(other) => {
                let _ = broker
                    .release(
                        &fence.v1_thread_id,
                        &slug,
                        &other.fencing_token,
                        "orkestr_v2_unrecorded",
                    )
                    .await;
                return Err(lost(store, &caller, &conversation, &fence, BrokerError::Lost).await);
            }
            Err(BrokerError::Leased) => {
                return Err(lost(store, &caller, &conversation, &fence, BrokerError::Lost).await)
            }
            Err(error) => return Err(broker_failure(error)),
        }
    }
    let view = store
        .record_desktop_heartbeat(caller.store(), &conversation, &fence, extended)
        .await
        .map_err(failure)?;
    Ok(Json(view).into_response())
}

/// V1 no longer recognises the token: end the V2 row so the slug is free.
async fn lost(
    store: &Store,
    caller: &Caller,
    conversation: &ConversationId,
    fence: &orkestr_v2_store_sqlite::DesktopFence,
    error: BrokerError,
) -> Error {
    if error == BrokerError::Lost {
        let _ = store
            .end_desktop_lease(
                caller.store(),
                conversation,
                fence,
                DesktopLeaseState::Lost,
                "v1_lease_lost",
            )
            .await;
    }
    broker_failure(error)
}

async fn release(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, slug)): Path<(String, String)>,
    request: Result<Json<DesktopReleaseRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let caller = caller(&state, &headers).await?;
    let conversation = conversation(&id)?;
    let request = json(request)?;
    if !request.is_valid() {
        return Err(invalid());
    }
    let broker = broker(&state)?;
    let store = &state.store;
    let token = request.fencing_token.as_str();
    let fence = store
        .desktop_fence(caller.store(), &conversation, &slug, token)
        .await
        .map_err(failure)?;
    let reason = request.reason.as_deref().unwrap_or("released");
    let (state_after, reason) = match broker
        .release(&fence.v1_thread_id, &slug, token, reason)
        .await
    {
        Ok(()) => (DesktopLeaseState::Released, reason),
        Err(BrokerError::Lost) => (DesktopLeaseState::Lost, "v1_lease_lost"),
        // V2 keeps the lease active so the holder can retry the release.
        Err(error) => return Err(broker_failure(error)),
    };
    let view = store
        .end_desktop_lease(caller.store(), &conversation, &fence, state_after, reason)
        .await
        .map_err(failure)?;
    Ok(Json(view).into_response())
}

#[cfg(test)]
#[path = "desktop_http_tests.rs"]
mod tests;
