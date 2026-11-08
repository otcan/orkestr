//! Global owner inventory. The configured V1 bridge is the singleton owner's
//! resource authority; discovery never acquires a lease or forwards raw JSON.
use super::*;
use crate::archived_history_http::owner_credential;
use crate::conversation_resources_http::{conversation, failure, invalid};
use axum::extract::{rejection::JsonRejection, Path};
use orkestr_v2_contracts::{DesktopInventory, DesktopResource};
use orkestr_v2_store_sqlite::DesktopCaller;
use serde_json::{json, Value};

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/v2/desktops", get(list)).route(
        "/api/v2/conversations/{id}/desktops/{slug}/reset",
        post(reset),
    )
}
fn unavailable() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "desktop_inventory_unavailable",
        "Desk inventory is unavailable; reservation state is unknown",
    )
}
fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
        .map(str::to_owned)
}
fn project(value: &Value) -> Result<Vec<DesktopResource>, Error> {
    if value.get("ok") != Some(&Value::Bool(true)) {
        return Err(unavailable());
    }
    let sessions = value
        .get("sessions")
        .and_then(Value::as_array)
        .filter(|s| s.len() <= 1000)
        .ok_or_else(unavailable)?;
    let mut seen = std::collections::BTreeSet::new();
    sessions
        .iter()
        .map(|s| {
            let slug = text(s, "slug")
                .filter(|s| desktop_slug_valid(s))
                .ok_or_else(unavailable)?;
            if !seen.insert(slug.clone()) {
                return Err(unavailable());
            }
            let lease = s.get("lease");
            let lease_state = match lease {
                Some(Value::Null) => "unreserved",
                Some(v) if v.is_object() && v.get("expired") == Some(&Value::Bool(true)) => {
                    "expired"
                }
                Some(v) if v.is_object() && v.get("stale") == Some(&Value::Bool(true)) => "stale",
                Some(v)
                    if v.is_object()
                        && v.get("threadId")
                            .and_then(Value::as_str)
                            .is_some_and(|s| !s.is_empty()) =>
                {
                    "reserved"
                }
                _ => "unknown",
            };
            Ok(DesktopResource {
                label: text(s, "label").unwrap_or_else(|| slug.clone()),
                slug,
                state: text(s, "status")
                    .or_else(|| text(s, "state"))
                    .unwrap_or_else(|| "unknown".into()),
                lease_state: lease_state.into(),
                holder: lease
                    .and_then(|v| text(v, "ownerThreadLabel").or_else(|| text(v, "threadId"))),
                expires_at: lease.and_then(|v| text(v, "expiresAt")),
            })
        })
        .collect()
}
async fn list(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let broker = state.desktop_broker.as_ref().ok_or_else(unavailable)?;
    let (status, value) = broker
        .read("/api/browser-sessions?inventory=owner", 1024 * 1024)
        .await
        .map_err(|_| unavailable())?;
    if status != 200 {
        return Err(unavailable());
    }
    let resources = project(&value)?;
    // Revalidate the original credential after the remote observation.
    let bindings = state
        .store
        .desktop_resource_bindings(&credential, &owner)
        .await
        .map_err(failure)?;
    let observed_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| unavailable())?
        .as_millis() as i64;
    let mut response = Json(DesktopInventory {
        schema_version: 1,
        resources,
        bindings,
        observed_at_ms,
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok(response)
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ResetRequest {
    fencing_token: String,
    confirm: bool,
}
async fn reset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, slug)): Path<(String, String)>,
    request: Result<Json<ResetRequest>, JsonRejection>,
) -> Result<Response, Error> {
    let (owner, credential) = owner_credential(&state, &headers).await?;
    let Json(request) = request.map_err(|_| invalid())?;
    if !request.confirm
        || !desktop_slug_valid(&slug)
        || !fencing_token_valid(&request.fencing_token)
    {
        return Err(invalid());
    }
    let conversation = conversation(&id)?;
    let fence = state
        .store
        .desktop_fence(
            DesktopCaller::Owner {
                credential: &credential,
                owner: &owner,
            },
            &conversation,
            &slug,
            &request.fencing_token,
        )
        .await
        .map_err(failure)?;
    let broker = state.desktop_broker.as_ref().ok_or_else(unavailable)?;
    if !broker
        .granted_slugs(&fence.v1_thread_id)
        .await
        .map_err(|_| unavailable())?
        .contains(&slug)
    {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "desktop_not_granted",
            "Desk access has changed",
        ));
    }
    // Fixed restart only. V1 rechecks the current lease/token and lifecycle
    // policy; no force, cleanup, arbitrary URL, or client-selected thread.
    let (status, _) = broker
        .write_within(
            std::time::Duration::from_secs(45),
            "POST",
            &format!("/api/browsers/{slug}/restart"),
            json!({"threadId":fence.v1_thread_id,"fencingToken":request.fencing_token}),
            1024 * 1024,
        )
        .await
        .map_err(|_| {
            Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "desktop_reset_unknown",
                "Reset outcome is unknown; refresh before taking another action",
            )
        })?;
    if !matches!(status, 200 | 201) {
        return Err(Error(
            if matches!(status, 403 | 404 | 409) {
                StatusCode::CONFLICT
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            "desktop_reset_refused",
            "Reset did not return success; refresh the current reservation",
        ));
    }
    owner_credential(&state, &headers).await?;
    Ok(Json(json!({"reset":true})).into_response())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inventory_is_closed_and_missing_lease_is_unknown() {
        let result = project(&json!({"ok":true,"sessions":[{"slug":"desk-a","status":"running","lease":{"threadId":"holder","fencingToken":"secret","expiresAt":"later"},"profilePath":"private","cdpUrl":"secret"},{"slug":"desk-b"},{"slug":"desk-c","lease":null}]})).unwrap_or_else(|_| panic!("valid inventory fixture rejected"));
        assert_eq!(result[0].lease_state, "reserved");
        assert_eq!(result[1].lease_state, "unknown");
        assert_eq!(result[2].lease_state, "unreserved");
        let text = serde_json::to_string(&result).unwrap();
        for forbidden in ["secret", "private", "fencingToken", "cdpUrl", "profilePath"] {
            assert!(!text.contains(forbidden));
        }
        assert!(project(&json!({"ok":false,"sessions":[]})).is_err());
        assert!(project(&json!({"ok":true,"sessions":[{"slug":"../bad"}]})).is_err());
        assert!(project(&json!({"ok":true,"sessions":[{"slug":"desk"},{"slug":"desk"}]})).is_err());
    }
}

#[cfg(test)]
mod http_tests {
    use crate::conversation_resources_http::tests::{case, send};
    #[tokio::test]
    async fn global_inventory_and_reset_require_owner_and_reset_requires_a_fence() {
        let c = case().await;
        let (status, _) = send(&c.state, "GET", "/api/v2/desktops", &[], "").await;
        assert_eq!(status, 401);
        let auth = c.auth();
        let (status, _) = send(&c.state, "GET", "/api/v2/desktops", &[&auth], "").await;
        assert_eq!(status, 503);
        let path = c.path("/desktops/desk-a/reset");
        let (status, _) = send(
            &c.state,
            "POST",
            &path,
            &[],
            r#"{"fencing_token":"synthetic-fence-token","confirm":true}"#,
        )
        .await;
        assert_eq!(status, 401);
        let (status, _) = send(
            &c.state,
            "POST",
            &path,
            &[&auth],
            r#"{"fencing_token":"synthetic-fence-token","confirm":false}"#,
        )
        .await;
        assert_eq!(status, 400);
        let (status, _) = send(
            &c.state,
            "POST",
            &path,
            &[&auth],
            r#"{"fencing_token":"synthetic-fence-token","confirm":true}"#,
        )
        .await;
        assert_ne!(status, 200);
    }
}
