//! Owner-authenticated local provider authority. No fixture constructor is reused.
use crate::Store;
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::OwnerId;
use sqlx::{Row, SqliteConnection};
use uuid::Uuid;
mod acceptance;
#[cfg(all(test, unix))]
mod acceptance_process_tests;
#[cfg(test)]
mod acceptance_tests;
mod admission;
mod cancellation;
#[cfg(test)]
mod cancellation_tests;
mod capability;
pub use capability::{ConsumedProviderDispatch, ExecutionConsumption};
mod dispatch;
mod fast;
mod fence;
pub use fast::FastAdmissionInput;
pub(crate) mod inspection;
mod leases;
mod metadata;
#[cfg(test)]
mod observation_tests;
mod observations;
#[cfg(test)]
mod payload_tests;
mod payloads;
pub use metadata::{BoundSessionMetadata, ReadySessionTransition};
#[cfg(all(test, unix))]
mod process_tests;
mod readiness;
mod recovery;
#[cfg(test)]
mod recovery_tests;
mod status;
mod stop;
#[cfg(test)]
mod stop_tests;
#[cfg(feature = "fixture-test-controls")]
pub(crate) mod test_controls;
#[cfg(test)]
mod tests;

pub type ProductionSupervisorStore = Store;
#[derive(Clone)]
pub(crate) struct Context {
    owner: OwnerId,
    provider: ProviderKind,
    namespace: String,
    key: String,
    id: String,
    incarnation: String,
    generation: i64,
    token_hash: String,
}
pub(super) fn db(_: impl std::fmt::Display) -> RuntimeStoreError {
    RuntimeStoreError::Unavailable
}
pub(super) fn valid(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
fn provider_name(provider: ProviderKind) -> Result<&'static str> {
    match provider {
        ProviderKind::Codex => Ok("codex"),
        ProviderKind::Claude => Ok("claude"),
        _ => Err(RuntimeStoreError::InvalidInput),
    }
}
async fn now(conn: &mut SqliteConnection) -> Result<i64> {
    sqlx::query_scalar("SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)")
        .fetch_one(conn)
        .await
        .map_err(db)
}
impl Store {
    /// Trusted composition only; machine token is never stored in plaintext.
    pub async fn authorize_supervisor(
        &self,
        token: &str,
        config: ProductionSupervisorConfig,
    ) -> Result<ProductionSupervisorStore> {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let provider = provider_name(config.provider)?;
        if !valid(&config.namespace) || !valid(&config.supervisor_key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let token_hash = crate::digest(token);
        let owner: String = sqlx::query_scalar(
            "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
        )
        .bind(&token_hash)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::Unauthorized)?;
        let clock = now(&mut tx).await?;
        let existing=sqlx::query("SELECT * FROM production_supervisors WHERE owner_id=? AND provider_kind=? AND namespace=? AND supervisor_key=?")
            .bind(&owner).bind(provider).bind(&config.namespace).bind(&config.supervisor_key).fetch_optional(&mut *tx).await.map_err(db)?;
        let (id, generation) = match (existing, config.takeover) {
            (None, ProductionTakeover::First) => (Uuid::new_v4().to_string(), 1),
            (Some(row), ProductionTakeover::ExpiredPredecessor { incarnation_id }) => {
                if row.get::<String, _>("incarnation_id") != incarnation_id {
                    return Err(RuntimeStoreError::Conflict);
                }
                if row.get::<i64, _>("lease_deadline_ms") > clock {
                    return Err(RuntimeStoreError::Busy);
                }
                let id: String = row.get("context_id");
                sqlx::query("UPDATE session_bindings SET state='lost' WHERE id IN (SELECT session_id FROM production_readiness WHERE context_id=?)").bind(&id).execute(&mut *tx).await.map_err(db)?;
                sqlx::query("UPDATE production_runs SET state='blocked',dispatch_state=CASE WHEN dispatch_state='delivery_unknown' THEN 'delivery_unknown' ELSE 'quarantined' END,candidate_hash=NULL,reservation_hash=NULL,reserve_key=NULL WHERE context_id=? AND state IN ('starting','running')")
                    .bind(&id).execute(&mut *tx).await.map_err(db)?;
                (
                    id,
                    row.get::<i64, _>("generation")
                        .checked_add(1)
                        .ok_or(RuntimeStoreError::Unavailable)?,
                )
            }
            _ => return Err(RuntimeStoreError::Conflict),
        };
        let incarnation = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO production_supervisors(context_id,owner_id,provider_kind,namespace,supervisor_key,incarnation_id,generation,lease_deadline_ms) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(context_id) DO UPDATE SET incarnation_id=excluded.incarnation_id,generation=excluded.generation,lease_deadline_ms=excluded.lease_deadline_ms")
            .bind(&id).bind(&owner).bind(provider).bind(&config.namespace).bind(&config.supervisor_key).bind(&incarnation).bind(generation).bind(clock+60_000)
            .execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(Store {
            #[cfg(feature = "fixture-test-controls")]
            production_checkpoint: None,
            pool: self.pool.clone(),
            authority: Some(Context {
                owner: OwnerId(Uuid::parse_str(&owner).map_err(db)?),
                provider: config.provider,
                namespace: config.namespace,
                key: config.supervisor_key,
                id,
                incarnation,
                generation,
                token_hash,
            }),
        })
    }
    pub fn supervisor_incarnation(&self) -> Option<&str> {
        self.authority.as_ref().map(|c| c.incarnation.as_str())
    }
    pub async fn reattach_supervisor(&self, store: &Store) -> Result<ProductionSupervisorStore> {
        let result = Store {
            #[cfg(feature = "fixture-test-controls")]
            production_checkpoint: None,
            pool: store.pool.clone(),
            authority: Some(self.context()?.clone()),
        };
        let mut tx = result.pool.begin().await.map_err(db)?;
        result.context()?.validate(&mut tx).await?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
    fn context(&self) -> Result<&Context> {
        self.authority
            .as_ref()
            .ok_or(RuntimeStoreError::Unavailable)
    }
}
impl Context {
    async fn authenticate(&self, conn: &mut SqliteConnection) -> Result<()> {
        let present:i64=sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(&self.token_hash).bind(self.owner.to_string()).fetch_one(conn).await.map_err(db)?;
        if present != 1 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        Ok(())
    }
    async fn validate(&self, conn: &mut SqliteConnection) -> Result<()> {
        self.authenticate(conn).await?;
        let row=sqlx::query("SELECT * FROM production_supervisors WHERE context_id=? AND owner_id=? AND provider_kind=? AND namespace=? AND supervisor_key=?")
            .bind(&self.id).bind(self.owner.to_string()).bind(provider_name(self.provider)?).bind(&self.namespace).bind(&self.key)
            .fetch_optional(&mut *conn).await.map_err(db)?.ok_or(RuntimeStoreError::Unauthorized)?;
        if row.get::<String, _>("incarnation_id") != self.incarnation
            || row.get::<i64, _>("generation") != self.generation
        {
            return Err(RuntimeStoreError::Fenced);
        }
        if row.get::<i64, _>("lease_deadline_ms") <= now(conn).await? {
            return Err(RuntimeStoreError::Expired);
        }
        Ok(())
    }
}
