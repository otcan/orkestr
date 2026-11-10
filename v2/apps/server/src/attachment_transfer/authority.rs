//! Preserve the original shared-auth credential for Store transaction checks.
use axum::http::{header, HeaderMap};
use orkestr_v2_contracts::OwnerId;

pub(super) async fn credential(
    state: &crate::AppState,
    headers: &HeaderMap,
) -> Result<(OwnerId, String), crate::Error> {
    let owner = crate::owner(state, headers).await?;
    let credential = if headers.contains_key(header::COOKIE) {
        crate::browser::credential(headers)?
    } else {
        let mut values = headers.get_all(header::AUTHORIZATION).iter();
        let token = values
            .next()
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(crate::unauthorized)?;
        if values.next().is_some() {
            return Err(crate::unauthorized());
        }
        token.to_owned()
    };
    // The returned owner is not a substitute for transaction-time credential
    // authentication. Do not log or serialize this tuple.
    Ok((owner, credential))
}
