//! Actual disposable Store + shared authentication; no transfer storage mock.
use super::authority;
use axum::{
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
};
use orkestr_v2_store_sqlite::Store;
use std::path::PathBuf;

pub(super) struct Home(pub(super) PathBuf);
impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
pub(super) async fn state() -> (Home, crate::AppState, String) {
    let home = Home(std::env::temp_dir().join(format!(
        "attachment-auth-synthetic-{}",
        uuid::Uuid::new_v4()
    )));
    std::fs::create_dir(&home.0).unwrap();
    let store = Store::open(&home.0.join("state.sqlite3")).await.unwrap();
    store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = "ab".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    store
        .save_session(&format!("browser:{token}"), &owner)
        .await
        .unwrap();
    let state = crate::AppState::new(
        store,
        "synthetic-bootstrap-token-long-enough".into(),
        "http://localhost:43123".into(),
    )
    .unwrap();
    (home, state, token)
}
#[tokio::test]
async fn exact_machine_credential_and_revocation_reopen() {
    let (_home, state, token) = state().await;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    let (_, actual) = authority::credential(&state, &headers)
        .await
        .ok()
        .expect("valid machine credential");
    assert_eq!(actual, token);
    state.store.revoke_session(&token).await.unwrap();
    let error = authority::credential(&state, &headers)
        .await
        .expect_err("revoked refuses");
    assert_eq!(error.into_response().status(), StatusCode::UNAUTHORIZED);
}
#[tokio::test]
async fn exact_browser_namespace_and_ambiguous_headers_refuse() {
    let (_home, state, token) = state().await;
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, "localhost:43123".parse().unwrap());
    headers.insert(
        header::COOKIE,
        format!("orkestr_v2_session={token}").parse().unwrap(),
    );
    let (_, actual) = authority::credential(&state, &headers)
        .await
        .ok()
        .expect("valid browser credential");
    assert_eq!(actual, format!("browser:{token}"));
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    assert!(authority::credential(&state, &headers).await.is_err());
    headers.remove(header::COOKIE);
    headers.append(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    assert!(authority::credential(&state, &headers).await.is_err());
    headers.remove(header::AUTHORIZATION);
    headers.insert(
        header::COOKIE,
        format!("orkestr_v2_session={token}").parse().unwrap(),
    );
    state
        .store
        .revoke_session(&format!("browser:{token}"))
        .await
        .unwrap();
    assert!(authority::credential(&state, &headers).await.is_err());
}
