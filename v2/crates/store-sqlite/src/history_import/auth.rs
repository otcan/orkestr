//! Shared transaction-local guard for the separately inert history ledger.
//! Registration and public request/receipt types remain Core-owned.
use orkestr_v2_contracts::OwnerId;
use sqlx::{Sqlite, Transaction};

/// Call inside the transaction before reading ledger identities.
/// BEGIN IMMEDIATE serializes writes with credential revocation.
/// No token/session/credential row is copied to the history ledger.
pub(super) async fn authorized(
    tx: &mut Transaction<'_, Sqlite>,
    token: &str,
    owner: &OwnerId,
) -> Result<bool, sqlx::Error> {
    if token.is_empty() || token.len() > 1024 {
        return Ok(false);
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()",
    )
    .bind(crate::digest(token))
    .bind(owner.to_string())
    .fetch_one(&mut **tx)
    .await?;
    Ok(count == 1)
}
