//! Ordinary synthetic browser authentication; no saved machine session.
use super::*;

pub(super) fn credentials() -> Credentials {
    Credentials {
        username: "synthetic-owner".into(),
        password: "synthetic-password-only".into(),
    }
}
pub(super) fn headers() -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(header::HOST, "synthetic.example:8090".parse().unwrap());
    h.insert(header::ORIGIN, ORIGIN.parse().unwrap());
    h
}
pub(super) async fn login(state: &AppState) -> HeaderMap {
    let mut h = headers();
    let mut wrong_origin = h.clone();
    wrong_origin.insert(header::ORIGIN, "http://foreign.example".parse().unwrap());
    assert!(browser::guard(state, &Method::POST, SESSION, &wrong_origin)
        .await
        .is_err());
    assert!(browser::guard(state, &Method::POST, SESSION, &h)
        .await
        .is_ok());
    let response = browser::login(State(state.clone()), h.clone(), Ok(Json(credentials())))
        .await
        .unwrap_or_else(|_| panic!("ordinary login refused"));
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let body = to_bytes(response.into_body(), 8192).await.unwrap();
    let projection: BrowserSessionProjection = serde_json::from_slice(&body).unwrap();
    h.insert(header::COOKIE, cookie.parse().unwrap());
    h.insert("x-orkestr-csrf", projection.csrf_token.parse().unwrap());
    assert!(browser::owner(state, &h).await.is_ok());
    h
}
pub(super) async fn logout(state: &AppState, h: HeaderMap) {
    let mut missing_csrf = h.clone();
    missing_csrf.remove("x-orkestr-csrf");
    assert!(
        browser::guard(state, &Method::DELETE, SESSION, &missing_csrf)
            .await
            .is_err()
    );
    assert!(browser::guard(state, &Method::DELETE, SESSION, &h)
        .await
        .is_ok());
    assert!(browser::logout(State(state.clone()), h.clone())
        .await
        .is_ok());
    assert!(browser::owner(state, &h).await.is_err());
}
