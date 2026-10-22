//! Owner-authenticated, read-only lookups for the host usage page: which
//! conversation each native provider session served, conversation names and
//! the V1 threads migrated into conversations. Identifiers and names only.
use crate::Store;
use orkestr_v2_application::runtime::RuntimeStoreError as Error;
use sqlx::Row;

/// Most native sessions returned (newest first).
const MAX_SESSIONS: i64 = 20_000;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UsageDirectory {
    /// (native session id, conversation id, role)
    pub runs: Vec<(String, String, String)>,
    /// (conversation id, name)
    pub names: Vec<(String, String)>,
    /// (V1 thread id, conversation id)
    pub lineage: Vec<(String, String)>,
}

fn db(_: impl std::fmt::Display) -> Error {
    Error::Unavailable
}

impl Store {
    pub async fn usage_directory_authenticated(
        &self,
        credential: &str,
    ) -> Result<UsageDirectory, Error> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(Error::Unauthorized);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner: String = sqlx::query_scalar(
            "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
        )
        .bind(crate::digest(credential))
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(Error::Unauthorized)?;
        let runs = sqlx::query("SELECT native_session_id,conversation_id,role FROM production_runs WHERE owner_id=? GROUP BY native_session_id ORDER BY max(rowid) DESC LIMIT ?")
            .bind(&owner).bind(MAX_SESSIONS).fetch_all(&mut *tx).await.map_err(db)?
            .iter().map(|r| (r.get(0), r.get(1), r.get(2))).collect();
        let names = sqlx::query("SELECT conversation_id,name FROM conversation_directory WHERE owner_id=?")
            .bind(&owner).fetch_all(&mut *tx).await.map_err(db)?
            .iter().map(|r| (r.get(0), r.get(1))).collect();
        let lineage = sqlx::query("SELECT source_thread_id,conversation_id FROM conversation_lineage WHERE owner_id=?")
            .bind(&owner).fetch_all(&mut *tx).await.map_err(db)?
            .iter().map(|r| (r.get(0), r.get(1))).collect();
        tx.commit().await.map_err(db)?;
        Ok(UsageDirectory {
            runs,
            names,
            lineage,
        })
    }
}
