use super::wire;
use crate::{AppState, Error};
use axum::{
    extract::{Request, State},
    http::{header, HeaderMap},
    middleware::Next,
    response::{IntoResponse, Response},
};

pub(super) fn credential(headers: &HeaderMap) -> Result<String, Error> {
    if headers.contains_key(header::AUTHORIZATION) {
        return Err(wire::unauthorized());
    }
    let mut found = None;
    for value in headers.get_all(header::COOKIE) {
        for part in value.to_str().map_err(|_| wire::unauthorized())?.split(';') {
            if let Some(("orkestr_v2_session", token)) = part.trim().split_once('=') {
                if found.is_some()
                    || token.len() != 64
                    || !token.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return Err(wire::unauthorized());
                }
                found = Some(format!("browser:{token}"));
            }
        }
    }
    found.ok_or_else(wire::unauthorized)
}

pub(super) async fn gate(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let headers = request.headers().clone();
    let method = request.method().clone();
    let uri = request.uri().clone();
    let checked = async {
        credential(&headers)?;
        crate::browser::owner(&state, &headers).await?;
        let mut origins = headers.get_all(header::ORIGIN).iter();
        if let Some(origin) = origins.next() {
            if origin.to_str().ok() != Some(state.origin.as_str()) || origins.next().is_some() {
                return Err(Error(
                    axum::http::StatusCode::FORBIDDEN,
                    "origin_rejected",
                    "Origin rejected",
                ));
            }
        }
        crate::browser::guard(&state, &method, uri.path(), &headers).await?;
        if uri.query().is_some() {
            return Err(wire::invalid());
        }
        Ok::<_, Error>(())
    }
    .await;
    let mut response = match checked {
        Ok(()) => next.run(request).await,
        Err(error) => error.into_response(),
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        axum::http::HeaderValue::from_static("nosniff"),
    );
    response
}
