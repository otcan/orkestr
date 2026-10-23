//! Shared verifier codec and irreversible dispatch CAS. Table names are closed,
//! internal constants; neither caller SQL nor a fixture bootstrap grants authority.
use super::*;
use sha2::{Digest, Sha256};
pub(crate) fn hash(domain: &str, parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in std::iter::once(domain).chain(parts.iter().copied()) {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    format!("{:x}", digest.finalize())
}
pub(crate) fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
pub(crate) enum Ledger {
    Fixture,
    Production,
}
impl Ledger {
    fn table(&self) -> &'static str {
        match self {
            Self::Fixture => "fixture_runs",
            Self::Production => "production_runs",
        }
    }
}
pub(crate) async fn reserve(
    conn: &mut SqliteConnection,
    ledger: Ledger,
    run: &str,
    verifier: &str,
    key: &str,
) -> Result<()> {
    let changed=sqlx::query(&format!("UPDATE {} SET dispatch_state='reserved',reservation_hash=?,reserve_key=? WHERE id=? AND dispatch_state='candidate'",ledger.table()))
        .bind(verifier).bind(key).bind(run).execute(conn).await.map_err(db)?.rows_affected();
    if changed != 1 {
        return Err(RuntimeStoreError::Conflict);
    }
    Ok(())
}
pub(crate) async fn consume(
    conn: &mut SqliteConnection,
    ledger: Ledger,
    run: &str,
) -> Result<bool> {
    let changed=sqlx::query(&format!("UPDATE {} SET dispatch_state='delivery_unknown',candidate_hash=NULL,reservation_hash=NULL WHERE id=? AND dispatch_state='reserved'",ledger.table()))
        .bind(run).execute(conn).await.map_err(db)?.rows_affected();
    Ok(changed == 1)
}

pub(crate) fn input_digest(
    claim: &InboxClaim,
    binding: &SessionId,
    generation: u64,
    key: &str,
) -> String {
    hash(
        "fixture-admission-v1",
        &[
            &claim.owner_id.to_string(),
            &claim.conversation_id.to_string(),
            &claim.message_id.to_string(),
            &claim.event_id.to_string(),
            &claim.consumer_session_id.to_string(),
            &claim.scope_sequence.to_string(),
            &claim.claim_generation.to_string(),
            &claim.lease_deadline_ms.to_string(),
            &binding.to_string(),
            &generation.to_string(),
            key,
        ],
    )
}

pub(crate) async fn validate_claim(
    conn: &mut SqliteConnection,
    claim: &InboxClaim,
    binding: &SessionId,
    clock: i64,
) -> Result<()> {
    validate_window_claim(conn, claim, binding, clock, None).await
}
pub(crate) async fn validate_window_claim(
    conn: &mut SqliteConnection,
    claim: &InboxClaim,
    binding: &SessionId,
    clock: i64,
    window: Option<&str>,
) -> Result<()> {
    let inbox = sqlx::query("SELECT * FROM reasoning_inbox WHERE conversation_id=? AND sequence=?")
        .bind(claim.conversation_id.to_string())
        .bind(claim.scope_sequence)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::NotFound)?;
    let held: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ordinary_input_holds WHERE event_id=?")
            .bind(claim.event_id.to_string())
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?;
    if held != 0 {
        return Err(RuntimeStoreError::Fenced);
    }
    if inbox.get::<&str, _>("state") != "claimed"
        || inbox.get::<Option<String>, _>("claimant_session_id") != Some(binding.to_string())
        || inbox.get::<String, _>("message_id") != claim.message_id.to_string()
        || inbox.get::<String, _>("event_id") != claim.event_id.to_string()
        || inbox.get::<i64, _>("claim_generation")
            != i64::try_from(claim.claim_generation).map_err(db)?
        || inbox.get::<Option<i64>, _>("claim_deadline_ms") != Some(claim.lease_deadline_ms)
    {
        return Err(RuntimeStoreError::StaleLease);
    }
    if claim.lease_deadline_ms <= clock {
        return Err(RuntimeStoreError::Expired);
    }
    let earliest: i64 = sqlx::query_scalar(
        "SELECT min(sequence) FROM reasoning_inbox WHERE conversation_id=? AND state IN ('queued','claimed') AND NOT EXISTS(SELECT 1 FROM ordinary_input_holds h WHERE h.event_id=reasoning_inbox.event_id) AND (? IS NULL OR EXISTS(SELECT 1 FROM execution_window_inputs wi WHERE wi.window_id=? AND wi.event_id=reasoning_inbox.event_id))",
    )
    .bind(claim.conversation_id.to_string()).bind(window).bind(window)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    if earliest != claim.scope_sequence {
        return Err(RuntimeStoreError::Conflict);
    }
    Ok(())
}
