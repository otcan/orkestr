//! Authenticated execution projection and revision-guarded Stop handoff.
#[cfg(test)]
#[path = "execution/retired_history_tests.rs"]
mod retired_history_tests;
use super::*;
use axum::extract::{rejection::QueryRejection, Path, Query};
use orkestr_v2_application::runtime::RuntimeStoreError;

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StatusQuery {
    run_id: Option<RunId>,
}

pub(crate) async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<StatusQuery>, QueryRejection>,
) -> Result<Response, Error> {
    status_for(state, headers, id, query, false).await
}

pub(crate) async fn fast_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    query: Result<Query<StatusQuery>, QueryRejection>,
) -> Result<Response, Error> {
    status_for(state, headers, id, query, true).await
}

async fn status_for(
    state: AppState,
    headers: HeaderMap,
    id: String,
    query: Result<Query<StatusQuery>, QueryRejection>,
    fast: bool,
) -> Result<Response, Error> {
    let owner = owner(&state, &headers).await?;
    let Query(query) = query.map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_query",
            "Invalid execution query",
        )
    })?;
    if query.run_id.as_ref().is_some_and(|run| run.0.is_nil()) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "invalid_query",
            "Invalid execution query",
        ));
    }
    let conversation = ConversationId(Uuid::parse_str(&id).map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_id",
            "Invalid conversation ID",
        )
    })?);
    let scope = if fast {
        state.fast_execution_scope(&owner, &conversation).await?
    } else {
        state.execution_scope(&owner, &conversation).await?
    };
    let status = if let Some(run) = &query.run_id {
        // Durable exact-run evidence survives retirement and newer windows.
        // The current browser credential and owner tuple share one snapshot;
        // only the separate live registry below may advertise controls.
        state
            .store
            .execution_run_history_authenticated(
                &browser::credential(&headers)?,
                &owner,
                &conversation,
                run,
                fast,
            )
            .await
    } else if fast {
        let credential = browser::credential(&headers)?;
        let Some(scope) = scope.as_ref() else {
            return Ok(StatusCode::NO_CONTENT.into_response());
        };
        scope
            .store
            .execution_fast_status_authenticated(&credential, &conversation)
            .await
    } else {
        state.store.execution_status(&owner, &conversation).await
    }
    .map_err(|error| match error {
        RuntimeStoreError::Unauthorized if query.run_id.is_some() || fast => unauthorized(),
        RuntimeStoreError::NotFound | RuntimeStoreError::Unauthorized => {
            Error(StatusCode::NOT_FOUND, "not_found", "Conversation not found")
        }
        _ => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Execution status unavailable",
        ),
    })?;
    match status {
        None if query.run_id.is_some() => Err(Error(
            StatusCode::NOT_FOUND,
            "not_found",
            "Execution not found",
        )),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
        Some(mut status)
            if status.conversation_id == conversation
                && status.is_valid()
                && query
                    .run_id
                    .as_ref()
                    .is_none_or(|run| status.run_id.as_ref() == Some(run)) =>
        {
            status.capabilities.stop = status.phase == ExecutionPhase::Running
                && scope
                    .as_ref()
                    .and_then(|scope| scope.control.as_ref())
                    .is_some_and(|control| {
                        status
                            .run_id
                            .as_ref()
                            .is_some_and(|run| control.available(&owner, &conversation, run))
                    });
            status.capabilities.steer = status.phase == ExecutionPhase::Running
                && status.queue_age_ms.is_none()
                && scope
                    .as_ref()
                    .and_then(|scope| scope.control.as_ref())
                    .is_some_and(|control| {
                        status.run_id.as_ref().is_some_and(|run| {
                            control.steering_available(&owner, &conversation, run)
                        })
                    });
            if let (true, Some(run)) = (fast, query.run_id.as_ref()) {
                // Burst marker for channel adapters: quote this reply's
                // source message. Absent (not false) for a lone reply, so the
                // single-message shape is unchanged.
                let concurrent = state
                    .store
                    .fast_run_concurrent_authenticated(
                        &browser::credential(&headers)?,
                        &owner,
                        &conversation,
                        run,
                    )
                    .await
                    .unwrap_or(false);
                if concurrent {
                    let mut value = serde_json::to_value(&status).map_err(|_| {
                        Error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "invalid_projection",
                            "Execution status unavailable",
                        )
                    })?;
                    value["concurrent_fast"] = serde_json::Value::Bool(true);
                    return Ok(Json(value).into_response());
                }
            }
            if let (false, Some(run)) = (fast, query.run_id.as_ref()) {
                let credential = browser::credential(&headers)?;
                // Grouped Deep turn: the inputs this one run answers, in
                // arrival order (head first). Absent for a single-input run,
                // so that shape is unchanged. Channel adapters settle every
                // grouped input with this run's final.
                let group = state
                    .store
                    .deep_run_group_authenticated(&credential, &owner, &conversation, run)
                    .await
                    // Unlike the Fast quote marker this settles inputs: a
                    // store error must not read as a single-input run, or the
                    // adapter would settle the head without its group.
                    .map_err(|_| {
                        Error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "store_unavailable",
                            "Execution status unavailable",
                        )
                    })?;
                // Parallel Deep burst markers: `parallel_deep` for a read-only
                // parallel slot run (its final answers its own input; an exact
                // PARALLEL_DEFER answer means the writer will answer it), and
                // `concurrent_deep` for any Deep final of a parallel burst, so
                // adapters quote its source message. Both absent otherwise.
                // They route an input's final too: a store error is a 503,
                // never "not parallel".
                let (parallel, concurrent, deferred) = state
                    .store
                    .deep_run_parallel_authenticated(&credential, &owner, &conversation, run)
                    .await
                    .map_err(|_| {
                        Error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "store_unavailable",
                            "Execution status unavailable",
                        )
                    })?;
                if !group.is_empty() || concurrent {
                    let mut value = serde_json::to_value(&status).map_err(|_| {
                        Error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "invalid_projection",
                            "Execution status unavailable",
                        )
                    })?;
                    if !group.is_empty() {
                        value["grouped_inputs"] = group
                            .into_iter()
                            .map(|(message, event, request_key)| {
                                serde_json::json!({
                                    "message_id": message,
                                    "event_id": event,
                                    "request_key": request_key,
                                })
                            })
                            .collect();
                    }
                    if parallel {
                        value["parallel_deep"] = serde_json::Value::Bool(true);
                    }
                    if deferred {
                        // Core handed this slot's input back to the writer:
                        // this run never answers it.
                        value["parallel_deferred"] = serde_json::Value::Bool(true);
                    }
                    if concurrent {
                        value["concurrent_deep"] = serde_json::Value::Bool(true);
                    }
                    return Ok(Json(value).into_response());
                }
            }
            Ok(Json(status).into_response())
        }
        Some(_) => Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_projection",
            "Execution status unavailable",
        )),
    }
}

/// Browser-only durable intent. A receipt is never provider interruption proof.
pub(crate) async fn stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<
        Json<orkestr_v2_contracts::ExecutionControlRequest>,
        axum::extract::rejection::JsonRejection,
    >,
) -> Result<Response, Error> {
    stop_for(state, headers, id, body, false).await
}

pub(crate) async fn fast_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ExecutionControlRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Response, Error> {
    stop_for(state, headers, id, body, true).await
}

async fn stop_for(
    state: AppState,
    headers: HeaderMap,
    id: String,
    body: Result<Json<ExecutionControlRequest>, axum::extract::rejection::JsonRejection>,
    fast: bool,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    browser::guard(
        &state,
        &axum::http::Method::POST,
        "execution_stop",
        &headers,
    )
    .await?;
    let conversation = ConversationId(Uuid::parse_str(&id).map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_id",
            "Invalid conversation ID",
        )
    })?);
    let Json(input) = body.map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Invalid Stop request",
        )
    })?;
    if !input.is_valid() {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Invalid Stop request",
        ));
    }
    let receipt = stop_run(&state, &headers, &owner, &conversation, &input, fast).await?;
    Ok(Json(receipt).into_response())
}

/// Request Stop of one exact registered run (authenticated and guarded by
/// the caller) and hand the issued control to its owned factory.
async fn stop_run(
    state: &AppState,
    headers: &HeaderMap,
    owner: &OwnerId,
    conversation: &ConversationId,
    input: &ExecutionControlRequest,
    fast: bool,
) -> Result<orkestr_v2_contracts::ExecutionStopReceipt, Error> {
    let (owner, conversation) = (owner.clone(), conversation.clone());
    let scope = if fast {
        state.fast_execution_scope(&owner, &conversation).await?
    } else {
        state.execution_scope(&owner, &conversation).await?
    }
    .ok_or(Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "control_unavailable",
        "Stop unavailable",
    ))?;
    let credential = browser::credential(headers)?;
    let requested = match &scope.control {
        Some(control) => Some(control.request(&owner, &conversation, input).ok_or(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "control_unavailable",
            "Stop unavailable",
        ))?),
        None => None,
    };
    let _schedule = match &requested {
        Some(control) => Some(control.serialize().await),
        None => None,
    };
    // Selection is not authority. The exact owned run may have retired while
    // this request waited for its bounded native step to release the lock.
    if requested
        .as_ref()
        .is_some_and(|control| !control.is_permitted())
    {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "control_unavailable",
            "Stop unavailable",
        ));
    }
    let (receipt, issued_control) = scope
        .store
        .stop_execution_control_authenticated(&credential, &conversation, input)
        .await
        .map_err(stop_error)?;
    if !receipt.is_valid()
        || receipt.conversation_id != conversation
        || receipt.run_id != input.run_id
        || receipt.request_key != input.request_key
        || receipt.requested_revision != input.expected_revision
    {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_receipt",
            "Stop unavailable",
        ));
    }
    if let Some(control) = requested {
        control.publish(issued_control).map_err(|_| {
            Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "control_unavailable",
                "Stop delivery requires reconciliation",
            )
        })?;
    }
    Ok(receipt)
}

/// The owner's Stop of every live read-only parallel Deep turn of the
/// conversation, including turns that outlive the writer's own turn (whose
/// Stop already reaches every live slot). Body: `{"request_key": "..."}`.
/// Returns the receipts of the turns it stopped (none while the switch is
/// off: no parallel turn exists then).
pub(crate) async fn parallel_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<ParallelStopRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Response, Error> {
    let owner = browser::owner(&state, &headers).await?;
    browser::guard(
        &state,
        &axum::http::Method::POST,
        "execution_stop",
        &headers,
    )
    .await?;
    let conversation = ConversationId(Uuid::parse_str(&id).map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_id",
            "Invalid conversation ID",
        )
    })?);
    let Json(input) = body.map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Invalid Stop request",
        )
    })?;
    let key = input.request_key;
    if key.is_empty()
        // The per-run key appends `:<run id>` within the 128-byte bound.
        || key.len() > 91
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
    {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Invalid Stop request",
        ));
    }
    let credential = browser::credential(&headers)?;
    let unavailable = || {
        Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "store_unavailable",
            "Stop unavailable",
        )
    };
    let runs = state
        .store
        .parallel_deep_live_runs_authenticated(&credential, &owner, &conversation)
        .await
        .map_err(|_| unavailable())?;
    let mut receipts = Vec::new();
    // A Stop that could not be requested (store busy or unavailable) must not
    // read as success: the owner retries, and stopped turns are not listed
    // again (they are no longer starting or running).
    let mut incomplete = false;
    for run in runs {
        let status = match state
            .store
            .execution_run_history_authenticated(&credential, &owner, &conversation, &run, false)
            .await
        {
            Ok(Some(status)) => status,
            Ok(None) => continue, // Ended meanwhile.
            Err(_) => {
                incomplete = true;
                continue;
            }
        };
        let key_for_run = format!("{key}:{run}");
        let request = ExecutionControlRequest {
            run_id: run,
            expected_revision: status.revision,
            expected_control_revision: status.control_revision,
            // Keyed by run: a replay or a changed live set never pairs a
            // key with another run.
            request_key: key_for_run,
        };
        match stop_run(&state, &headers, &owner, &conversation, &request, false).await {
            Ok(receipt) => receipts.push(receipt),
            // A turn that ended (or was stopped) meanwhile refuses its Stop:
            // nothing to do.
            Err(Error(_, "revision_conflict" | "execution_fenced" | "not_found", _)) => {}
            Err(_) => incomplete = true,
        }
    }
    if incomplete {
        return Err(unavailable());
    }
    Ok(Json(serde_json::json!({ "stopped": receipts })).into_response())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ParallelStopRequest {
    request_key: String,
}

fn stop_error(error: RuntimeStoreError) -> Error {
    match error {
        RuntimeStoreError::InvalidInput => Error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Invalid Stop request",
        ),
        RuntimeStoreError::Unauthorized => unauthorized(),
        RuntimeStoreError::NotFound => {
            Error(StatusCode::NOT_FOUND, "not_found", "Execution not found")
        }
        RuntimeStoreError::Conflict => Error(
            StatusCode::CONFLICT,
            "revision_conflict",
            "Stop request conflicts with execution state",
        ),
        RuntimeStoreError::Fenced | RuntimeStoreError::StaleLease | RuntimeStoreError::Expired => {
            Error(
                StatusCode::CONFLICT,
                "execution_fenced",
                "Execution authority changed",
            )
        }
        RuntimeStoreError::Busy => {
            Error(StatusCode::CONFLICT, "execution_busy", "Execution is busy")
        }
        RuntimeStoreError::Unavailable => Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "control_unavailable",
            "Stop unavailable",
        ),
    }
}
