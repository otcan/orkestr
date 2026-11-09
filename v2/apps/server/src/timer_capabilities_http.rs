//! Owner-authenticated advisory Core timer observations. No grant issuance,
//! provider dispatch, or replacement authority for any agent operation.
use super::*;
use axum::extract::Path;
use std::sync::atomic::Ordering;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/api/v2/conversations/{id}/native-timer-capability",
        get(read),
    )
}

fn projection(facts: AgentTimerDiscovery, scheduler: bool) -> serde_json::Value {
    let (status, reason, action) = if !facts.eligible {
        (
            "denied",
            "conversation_unavailable",
            "Ask the owner to review conversation restrictions.",
        )
    } else if !facts.grant.issued {
        (
            "setup_required",
            "grant_missing",
            "Ask the owner to issue this conversation's timer grant.",
        )
    } else if !scheduler {
        (
            "unhealthy",
            "scheduler_unavailable",
            "Ask the operator to restore the timer scheduler.",
        )
    } else if !facts.running_deep {
        (
            "denied",
            "no_running_deep",
            "Only this conversation's running primary turn may use agent timers.",
        )
    } else {
        (
            "ready",
            "core_preconditions_observed",
            "Agent calls still require their existing scoped grant and authorization.",
        )
    };
    serde_json::json!({
        "schema_version": 1, "surface": "native_timers", "complete": false,
        "freshness": "per_request", "status": status, "reason": reason,
        "setup_action": action, "readiness_basis": "core_preconditions",
        "requires_operation_authorization": true,
        "agent_grant_possession": "unassessed",
        "operations": ["list", "create_once", "upsert_once", "cancel", "pause", "resume", "skip_next"],
        "recurring": {"status": if facts.running_deep && !facts.recurring_allowed { "not_supported" } else { status },
            "reason": if facts.running_deep && !facts.recurring_allowed { "timer_origin_turn" } else { reason }},
        "scheduler_running": scheduler, "observations": facts,
        "schedule_limits": {
            "minimum_lead_ms": AGENT_TIMER_MIN_LEAD_MS,
            "minimum_interval_ms": AGENT_TIMER_MIN_INTERVAL_MS,
            "maximum_horizon_ms": AGENT_TIMER_MAX_HORIZON_MS,
            "maximum_pause_ms": AGENT_TIMER_MAX_PAUSE_MS,
            "once_time_basis": "UTC_epoch_milliseconds",
            "calendar_timezone": "explicit_supported_timezone_required",
            "requires_service_uptime": true
        }
    })
}

async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) =
        crate::archived_history_http::owner_credential(&state, &headers).await?;
    let conversation = crate::conversation_resources_http::conversation(&id)?;
    let facts = state
        .store
        .agent_timer_discovery(&credential, &owner, &conversation)
        .await
        .map_err(crate::agent_timers_http::failure)?;
    let value = projection(facts, state.timers.ready.load(Ordering::Acquire));
    let mut response = Json(value).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

#[cfg(test)]
#[path = "timer_capabilities_http_tests.rs"]
mod tests;
