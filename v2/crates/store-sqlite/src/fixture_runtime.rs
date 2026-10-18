//! Explicit offline fixture authority. Never called by server bootstrap.
//! Only synthetic readiness and durable dispatch authority; never real provider I/O.
use crate::Store;
use orkestr_v2_application::runtime::{Result, RuntimeStoreError};
use orkestr_v2_contracts::OwnerId;
use sqlx::{Row, SqliteConnection};
use uuid::Uuid;

mod admission;
mod dispatch;
mod inspection;
mod port;
#[cfg(feature = "fixture-test-controls")]
pub mod test_controls;
pub use inspection::{FixtureAttemptInspection, FixtureDispatchState, FixtureScopeInspection};
mod readiness;

const LEASE_MS: i64 = 60_000;

/// No arbitrary clock, lease duration, provider or incarnation can be supplied.
pub struct ExplicitFixtureSupervisorConfig {
    pub namespace: String,
    pub supervisor_key: String,
    pub takeover: FixtureTakeover,
}

pub enum FixtureTakeover {
    First,
    ExpiredPredecessor { incarnation_id: Uuid },
}

/// Non-cloneable authority tied to this database and one immutable incarnation.
/// No Debug/serialization: private context material is not diagnostic output.
pub struct FixtureSupervisorStore {
    store: Store,
    owner: OwnerId,
    namespace: String,
    supervisor_key: String,
    context_id: Uuid,
    incarnation_id: Uuid,
    generation: i64,
    #[cfg(feature = "fixture-test-controls")]
    checkpoint: Option<test_controls::ArmedCheckpoint>,
}

fn db(_: impl std::fmt::Display) -> RuntimeStoreError {
    RuntimeStoreError::Unavailable
}
fn valid(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
async fn now(conn: &mut SqliteConnection) -> Result<i64> {
    sqlx::query_scalar("SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)")
        .fetch_one(conn)
        .await
        .map_err(db)
}

/// Trusted fixture harness entry point; no HTTP/env/credential bootstrap path.
/// Reopen requires the still-live original handle's reattach method; knowing an
/// incarnation ID is not sufficient to attach. Takeover requires expiry AND CAS.
pub async fn bootstrap_fixture_supervisor(
    store: &Store,
    owner: &OwnerId,
    config: ExplicitFixtureSupervisorConfig,
) -> Result<FixtureSupervisorStore> {
    if !valid(&config.namespace) || !valid(&config.supervisor_key) {
        return Err(RuntimeStoreError::InvalidInput);
    }
    let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
    let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM owners WHERE id=?")
        .bind(owner.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    if exists != 1 {
        return Err(RuntimeStoreError::NotFound);
    }
    let clock = now(&mut tx).await?;
    let existing = sqlx::query(
        "SELECT * FROM fixture_supervisors WHERE owner_id=? AND namespace=? AND supervisor_key=?",
    )
    .bind(owner.to_string())
    .bind(&config.namespace)
    .bind(&config.supervisor_key)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    let incarnation_id = Uuid::new_v4();
    let (context_id, generation) = match (existing, config.takeover) {
        (None, FixtureTakeover::First) => (Uuid::new_v4(), 1),
        (None, FixtureTakeover::ExpiredPredecessor { .. }) => {
            return Err(RuntimeStoreError::Conflict)
        }
        (Some(_), FixtureTakeover::First) => return Err(RuntimeStoreError::Conflict),
        (
            Some(row),
            FixtureTakeover::ExpiredPredecessor {
                incarnation_id: predecessor,
            },
        ) => {
            if row.get::<String, _>("incarnation_id") != predecessor.to_string() {
                return Err(RuntimeStoreError::Conflict);
            }
            if row.get::<i64, _>("lease_deadline_ms") > clock {
                return Err(RuntimeStoreError::Busy);
            }
            // Fence only this expired predecessor, inside the takeover transaction.
            // Unknown delivery stays unknown; neither state permits automatic retry.
            let context: String = row.get("context_id");
            sqlx::query("UPDATE session_bindings SET state='lost' WHERE id IN (SELECT session_id FROM fixture_readiness WHERE context_id=? AND incarnation_id=?)")
                .bind(&context).bind(predecessor.to_string()).execute(&mut *tx).await.map_err(db)?;
            sqlx::query("UPDATE fixture_runs SET state='blocked',dispatch_state=CASE WHEN dispatch_state='delivery_unknown' THEN 'delivery_unknown' ELSE 'quarantined' END,candidate_hash=NULL,reservation_hash=NULL WHERE context_id=? AND incarnation_id=?")
                .bind(&context).bind(predecessor.to_string()).execute(&mut *tx).await.map_err(db)?;
            (
                Uuid::parse_str(&row.get::<String, _>("context_id")).map_err(db)?,
                row.get::<i64, _>("generation")
                    .checked_add(1)
                    .ok_or(RuntimeStoreError::Unavailable)?,
            )
        }
    };
    sqlx::query("INSERT INTO fixture_supervisors(context_id,owner_id,namespace,supervisor_key,incarnation_id,generation,lease_deadline_ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT(context_id) DO UPDATE SET incarnation_id=excluded.incarnation_id,generation=excluded.generation,lease_deadline_ms=excluded.lease_deadline_ms")
        .bind(context_id.to_string()).bind(owner.to_string()).bind(&config.namespace)
        .bind(&config.supervisor_key).bind(incarnation_id.to_string()).bind(generation)
        .bind(clock.checked_add(LEASE_MS).ok_or(RuntimeStoreError::Unavailable)?)
        .execute(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(FixtureSupervisorStore {
        store: store.clone(),
        owner: owner.clone(),
        namespace: config.namespace,
        supervisor_key: config.supervisor_key,
        context_id,
        incarnation_id,
        generation,
        #[cfg(feature = "fixture-test-controls")]
        checkpoint: None,
    })
}

impl FixtureSupervisorStore {
    /// Public predecessor locator is not an attachment capability.
    pub fn incarnation_id(&self) -> Uuid {
        self.incarnation_id
    }

    /// Revalidate immutable context against the authoritative store clock.
    pub async fn validate_context(&self) -> Result<()> {
        let mut tx = self
            .store
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        self.validate_in(&mut tx).await?;
        tx.commit().await.map_err(db)
    }

    async fn validate_in(&self, conn: &mut SqliteConnection) -> Result<()> {
        let row = sqlx::query("SELECT * FROM fixture_supervisors WHERE context_id=? AND owner_id=? AND namespace=? AND supervisor_key=?")
            .bind(self.context_id.to_string()).bind(self.owner.to_string())
            .bind(&self.namespace).bind(&self.supervisor_key)
            .fetch_optional(&mut *conn).await.map_err(db)?.ok_or(RuntimeStoreError::Unauthorized)?;
        if row.get::<String, _>("incarnation_id") != self.incarnation_id.to_string()
            || row.get::<i64, _>("generation") != self.generation
        {
            return Err(RuntimeStoreError::Fenced);
        }
        if row.get::<i64, _>("lease_deadline_ms") <= now(conn).await? {
            return Err(RuntimeStoreError::Expired);
        }
        Ok(())
    }

    /// Attach another independently opened pool ONLY by presenting this live
    /// in-process handle. A reopened unrelated DB/context fails immutable checks.
    /// This never creates/renews an incarnation or returns delivery permission.
    pub async fn reattach(&self, store: &Store) -> Result<Self> {
        let handle = Self {
            store: store.clone(),
            owner: self.owner.clone(),
            namespace: self.namespace.clone(),
            supervisor_key: self.supervisor_key.clone(),
            context_id: self.context_id,
            incarnation_id: self.incarnation_id,
            generation: self.generation,
            #[cfg(feature = "fixture-test-controls")]
            checkpoint: None,
        };
        handle.validate_context().await?;
        Ok(handle)
    }
}

#[cfg(test)]
mod crash_tests;
#[cfg(test)]
mod dispatch_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod inspection_tests;

#[cfg(test)]
mod guard_tests;
