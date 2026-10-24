use super::*;
use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query,
    },
    response::sse::{Event, KeepAlive, Sse},
};
use orkestr_v2_application::IntakeStore;
use serde::Deserialize;
use std::convert::Infallible;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    after: Option<i64>,
    limit: Option<u32>,
}
fn page(q: Result<Query<Page>, QueryRejection>) -> Result<Page, Error> {
    let Query(p) = q.map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_cursor",
            "Invalid pagination",
        )
    })?;
    if p.after.is_some_and(|n| n < 0) || p.limit.is_some_and(|n| n == 0 || n > 100) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "invalid_cursor",
            "Invalid pagination",
        ));
    }
    Ok(p)
}
fn conversation(id: String) -> Result<ConversationId, Error> {
    Uuid::parse_str(&id).map(ConversationId).map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_id",
            "Invalid conversation ID",
        )
    })
}
fn json<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Error> {
    body.map(|b| b.0).map_err(|_| {
        Error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Invalid JSON body or body limit exceeded",
        )
    })
}
pub async fn create_project(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<ProjectInput>, JsonRejection>,
) -> Result<impl IntoResponse, Error> {
    let owner = owner(&s, &headers).await?;
    let result = s.store.create_project(&owner, &json(body)?).await?;
    Ok((
        if result.duplicate {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(result.project),
    ))
}
pub async fn projects(
    State(s): State<AppState>,
    headers: HeaderMap,
    q: Result<Query<Page>, QueryRejection>,
) -> Result<impl IntoResponse, Error> {
    let owner = owner(&s, &headers).await?;
    let p = page(q)?;
    Ok(Json(
        s.store
            .projects(&owner, p.after.unwrap_or(0), p.limit.unwrap_or(50))
            .await?,
    ))
}
pub async fn snapshot(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    q: Result<Query<Page>, QueryRejection>,
) -> Result<impl IntoResponse, Error> {
    let owner = owner(&s, &headers).await?;
    let p = page(q)?;
    Ok(Json(
        s.store
            .snapshot(
                &owner,
                &conversation(id)?,
                p.after.unwrap_or(0),
                p.limit.unwrap_or(50),
            )
            .await?,
    ))
}
pub async fn message(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<MessageRequest>, JsonRejection>,
) -> Result<impl IntoResponse, Error> {
    let owner = owner(&s, &headers).await?;
    let request = json(body)?;
    let expected_provider_generation = request.expected_provider_generation;
    let continuation_source_run_id = request.continuation_source_run_id.clone();
    let (input, reply_to) = request.into_parts();
    let admitted = s
        .store
        .admit_with_provider_generation(
            &owner,
            &conversation(id)?,
            &input,
            reply_to.as_ref(),
            expected_provider_generation,
            continuation_source_run_id.as_ref(),
        )
        .await?;
    Ok((
        if admitted.duplicate {
            StatusCode::OK
        } else {
            StatusCode::ACCEPTED
        },
        Json(admitted.receipt),
    ))
}
pub async fn events(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    q: Result<Query<Page>, QueryRejection>,
) -> Result<impl IntoResponse, Error> {
    let owner_id = owner(&s, &headers).await?;
    let p = page(q)?;
    let conversation = conversation(id)?;
    let mut after = match headers.get("last-event-id") {
        Some(v) => v
            .to_str()
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .ok_or(Error(
                StatusCode::BAD_REQUEST,
                "invalid_cursor",
                "Invalid Last-Event-ID",
            ))?,
        None => p.after.unwrap_or(0),
    };
    let mut batch = s
        .store
        .events(&owner_id, &conversation, after, 100)
        .await
        .map_err(|e| match e {
            StoreError::Invalid => Error(
                StatusCode::CONFLICT,
                "resync_required",
                "Cursor outside retained history; fetch snapshot",
            ),
            e => e.into(),
        })?;
    let stream = async_stream::stream! {
        loop {
            for envelope in batch.drain(..) {
                after=envelope.sequence();
                match Event::default().event(envelope.sse_name()).id(after.to_string()).json_data(&envelope) {
                    Ok(event) => yield Ok::<_,Infallible>(event), Err(_) => return,
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            // Recheck authentication during long-lived streams, not just at connection time.
            if owner(&s,&headers).await.is_err() { yield Ok(Event::default().event("session_expired").data("{}")); return; }
            match s.store.events(&owner_id,&conversation,after,100).await {
                Ok(events) => batch=events,
                Err(_) => { yield Ok(Event::default().event("resync_required").data("{}")); return; }
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}
