//! Owner viewing through V1's atomic non-superseding share endpoint. No desktop
//! creation, profile change, lease renewal, or browser lifecycle operation.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::{conversation, failure, invalid};
use axum::extract::Path;
use axum::http::HeaderValue;
use orkestr_v2_store_sqlite::DesktopCaller;
use serde_json::json;
use std::time::Duration;

pub(crate) async fn authenticated_slow_path(
    state: &AppState,
    method: &axum::http::Method,
    path: &str,
    headers: &HeaderMap,
) -> Result<bool, Error> {
    let parts: Vec<_> = path.split('/').collect();
    if method != axum::http::Method::POST
        || parts.len() != 8
        || parts[1..4] != ["api", "v2", "conversations"]
        || parts[5] != "desktops"
        || parts[7] != "open"
    {
        return Ok(false);
    }
    let (owner, credential) = owner_credential(state, headers).await?;
    if !desktop_slug_valid(parts[6]) {
        return Err(invalid());
    }
    state
        .store
        .prepare_desktop_acquire(
            DesktopCaller::Owner {
                credential: &credential,
                owner: &owner,
            },
            &conversation(parts[4])?,
            parts[6],
        )
        .await
        .map_err(failure)?;
    Ok(true)
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/api/v2/conversations/{id}/desktops/{slug}/open",
        post(open),
    )
}

pub(crate) fn safe_share_url(value: &str) -> bool {
    let Ok(uri) = value.parse::<axum::http::Uri>() else {
        return false;
    };
    let Some(authority) = uri.authority() else {
        return false;
    };
    !authority.as_str().contains('@')
        && !value.contains(['\\', '#'])
        && value.len() <= 8192
        && value.is_ascii()
        && uri.path().starts_with("/desktop-share/")
        && (uri.scheme_str() == Some("https")
            || (uri.scheme_str() == Some("http")
                && uri.host().is_some_and(|host| {
                    host == "localhost"
                        || host
                            .parse::<std::net::IpAddr>()
                            .is_ok_and(|ip| ip.is_loopback())
                })))
}

async fn open(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, slug)): Path<(String, String)>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    if !desktop_slug_valid(&slug) {
        return Err(invalid());
    }
    let binding_before = state
        .store
        .desktop_binding(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    let prepared = state
        .store
        .prepare_desktop_acquire(
            DesktopCaller::Owner {
                credential: &credential,
                owner: &owner,
            },
            &conversation(&id)?,
            &slug,
        )
        .await
        .map_err(failure)?;
    let broker = state.desktop_broker.as_ref().ok_or(Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "desktop_broker_unconfigured",
        "Desktop broker is not configured",
    ))?;
    let result = broker
        .write_within(
            Duration::from_secs(45),
            "POST",
            &format!("/api/desktops/{slug}/share-if-absent"),
            json!({"threadId":prepared.v1_thread_id}),
            1024 * 1024,
        )
        .await;
    let unavailable = || {
        Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "desktop_open_unavailable",
            "Desktop access did not complete; keep any existing desktop window",
        )
    };
    let (status, value) = result.map_err(|_| unavailable())?;
    match status {
        404 | 405 => {
            return Err(Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "desktop_owner_open_unsupported",
                "Desktop viewing requires an updated V1 bridge",
            ))
        }
        409 => {
            return Err(Error(
                StatusCode::CONFLICT,
                "desktop_open_conflict",
                "A desktop lease or viewing link is already active; keep its existing window",
            ))
        }
        401 | 403 => {
            return Err(Error(
                StatusCode::FORBIDDEN,
                "desktop_open_denied",
                "V1 denied desktop access",
            ))
        }
        200 | 201 => {}
        _ => return Err(unavailable()),
    }
    let url = value
        .get("url")
        .and_then(serde_json::Value::as_str)
        .filter(|url| safe_share_url(url))
        .ok_or_else(unavailable)?;
    // The remote action may have outlived a password/session or binding change.
    // Never publish a newly minted link using stale Core authorization.
    let binding_after = state
        .store
        .desktop_binding(&credential, &owner, &conversation(&id)?)
        .await
        .map_err(failure)?;
    if binding_after != binding_before {
        return Err(Error(
            StatusCode::CONFLICT,
            "desktop_binding_changed",
            "Desktop access changed while preparing its link; do not retry automatically",
        ));
    }
    let mut response = Json(json!({"url":url,"challenge_required":true})).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn share_urls_refuse_credentials_active_schemes_and_foreign_cleartext() {
        for url in [
            "https://desk.example.test/desktop-share/test?key=opaque",
            "http://127.0.0.1:1234/desktop-share/test?key=opaque",
        ] {
            assert!(safe_share_url(url));
        }
        for url in [
            "javascript:alert(1)",
            "https://user:password@desk.example.test/desktop-share/test",
            "http://desk.example.test/desktop-share/test",
            "//desk.example.test/desktop-share/test",
            "https://desk.example.test/elsewhere",
            "https://desk.example.test/desktop-share/test#fragment",
        ] {
            assert!(!safe_share_url(url));
        }
    }
}
