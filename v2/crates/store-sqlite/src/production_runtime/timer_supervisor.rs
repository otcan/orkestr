//! Reserved timer-only context: never takes over native provider authority.
use super::*;
const NAMESPACE: &str = "orkestr:durable-timers";
const KEY: &str = "ordinary-timer-scheduler";
impl Context {
    pub(super) fn require_provider_context(&self) -> Result<()> {
        if self.namespace == NAMESPACE && self.key == KEY {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
}
async fn empty_provider_context(tx: &mut SqliteConnection, id: &str) -> Result<()> {
    let n: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM production_readiness WHERE context_id=?) + (SELECT count(*) FROM production_runs WHERE context_id=?)")
        .bind(id).bind(id).fetch_one(tx).await.map_err(db)?;
    if n != 0 {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}
impl Store {
    /// Trusted local timer service only. Current machine auth is checked inside
    /// the same writer transaction as discovery and exact predecessor replacement.
    /// An active predecessor is Busy; no native bindings or runs are recovered.
    pub async fn authorize_timer_supervisor(&self, credential: &str) -> Result<Store> {
        if credential.len() != 64 || !credential.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let token_hash = crate::digest(credential);
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner: String = sqlx::query_scalar(
            "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
        )
        .bind(&token_hash)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::Unauthorized)?;
        let clock = now(&mut tx).await?;
        let row = sqlx::query("SELECT * FROM production_supervisors WHERE owner_id=? AND provider_kind='codex' AND namespace=? AND supervisor_key=?")
            .bind(&owner).bind(NAMESPACE).bind(KEY).fetch_optional(&mut *tx).await.map_err(db)?;
        let (id, generation) = if let Some(row) = row {
            let id: String = row.get("context_id");
            empty_provider_context(&mut tx, &id).await?;
            if row.get::<i64, _>("lease_deadline_ms") > clock {
                return Err(RuntimeStoreError::Busy);
            }
            (
                id,
                row.get::<i64, _>("generation")
                    .checked_add(1)
                    .ok_or(RuntimeStoreError::Unavailable)?,
            )
        } else {
            (Uuid::new_v4().to_string(), 1)
        };
        let incarnation = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO production_supervisors(context_id,owner_id,provider_kind,namespace,supervisor_key,incarnation_id,generation,lease_deadline_ms) VALUES(?,?,'codex',?,?,?,?,?) ON CONFLICT(context_id) DO UPDATE SET incarnation_id=excluded.incarnation_id,generation=excluded.generation,lease_deadline_ms=excluded.lease_deadline_ms")
            .bind(&id).bind(&owner).bind(NAMESPACE).bind(KEY).bind(&incarnation).bind(generation).bind(clock+60_000).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(Store {
            #[cfg(feature = "fixture-test-controls")]
            production_checkpoint: None,
            deep_burst_quiet_ms: self.deep_burst_quiet_ms,
            agent_timer_daily: self.agent_timer_daily,
            pool: self.pool.clone(),
            #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
            workspace_handles: self.workspace_handles.clone(),
            authority: Some(Context {
                owner: OwnerId(Uuid::parse_str(&owner).map_err(db)?),
                provider: ProviderKind::Codex,
                namespace: NAMESPACE.into(),
                key: KEY.into(),
                id,
                incarnation,
                generation,
                token_hash,
                window_bootstrap_only: false,
            }),
        })
    }
    /// Trusted unattended-service lifecycle: renew a still-current machine session
    /// for a bounded twelve-hour window. This never revives expiry or revocation.
    /// The service must explicitly opt in and call before expiry; every scheduler
    /// operation continues checking the auth row, not a cached authorization.
    pub async fn renew_timer_supervisor_credential(&self) -> Result<i64> {
        let c = self.context()?;
        if c.namespace != NAMESPACE || c.key != KEY {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        empty_provider_context(&mut tx, &c.id).await?;
        let expiry: i64 = sqlx::query_scalar("UPDATE auth_sessions SET expires_at=max(expires_at,unixepoch()+43200) WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch() RETURNING expires_at")
            .bind(&c.token_hash).bind(c.owner.to_string()).fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Unauthorized)?;
        tx.commit().await.map_err(db)?;
        Ok(expiry)
    }

    /// Negative-only graceful release after the server has stopped scheduler work.
    /// Existing issuers immediately expire; this creates no provider authority.
    pub async fn retire_timer_supervisor(&self) -> Result<()> {
        let c = self.context()?;
        if c.namespace != NAMESPACE || c.key != KEY {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        empty_provider_context(&mut tx, &c.id).await?;
        sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0 WHERE context_id=? AND incarnation_id=? AND generation=?")
            .bind(&c.id).bind(&c.incarnation).bind(c.generation).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn clean_release_reopen_and_current_credential_are_required() {
        let f = super::super::tests::setup().await;
        let scheduler = f.store.authorize_timer_supervisor(&f.token).await.unwrap();
        assert!(matches!(
            f.store.authorize_timer_supervisor(&f.token).await,
            Err(RuntimeStoreError::Busy)
        ));
        assert!(matches!(
            scheduler.context().unwrap().require_provider_context(),
            Err(RuntimeStoreError::Fenced)
        ));
        assert!(matches!(
            f.handle.retire_timer_supervisor().await,
            Err(RuntimeStoreError::Fenced)
        ));
        let old = scheduler.supervisor_incarnation().unwrap().to_string();
        scheduler.retire_timer_supervisor().await.unwrap();
        assert!(scheduler.timer_scheduler_candidates(None, 1).await.is_err());
        let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
        let successor = reopened.authorize_timer_supervisor(&f.token).await.unwrap();
        assert_ne!(successor.supervisor_incarnation(), Some(old.as_str()));
        assert!(scheduler.heartbeat_supervisor().await.is_err());
        reopened.revoke_session(&f.token).await.unwrap();
        assert!(matches!(
            successor.retire_timer_supervisor().await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        assert!(matches!(
            reopened.authorize_timer_supervisor(&f.token).await,
            Err(RuntimeStoreError::Unauthorized)
        ));
    }
    #[tokio::test]
    async fn service_renewal_is_bounded_and_cannot_resurrect_auth() {
        let f = super::super::tests::setup().await;
        let scheduler = f.store.authorize_timer_supervisor(&f.token).await.unwrap();
        sqlx::query("UPDATE auth_sessions SET expires_at=unixepoch()+30 WHERE token_hash=?")
            .bind(crate::digest(&f.token))
            .execute(&f.store.pool)
            .await
            .unwrap();
        let expiry = scheduler.renew_timer_supervisor_credential().await.unwrap();
        let clock: i64 = sqlx::query_scalar("SELECT unixepoch()")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
        assert!((43199..=43200).contains(&(expiry - clock)));
        assert!(matches!(
            f.handle.renew_timer_supervisor_credential().await,
            Err(RuntimeStoreError::Fenced)
        ));
        sqlx::query("UPDATE auth_sessions SET expires_at=unixepoch()-1 WHERE token_hash=?")
            .bind(crate::digest(&f.token))
            .execute(&f.store.pool)
            .await
            .unwrap();
        assert!(matches!(
            scheduler.renew_timer_supervisor_credential().await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        let stored: i64 =
            sqlx::query_scalar("SELECT expires_at FROM auth_sessions WHERE token_hash=?")
                .bind(crate::digest(&f.token))
                .fetch_one(&f.store.pool)
                .await
                .unwrap();
        assert!(stored < clock);
        f.store.revoke_session(&f.token).await.unwrap();
        assert!(matches!(
            scheduler.renew_timer_supervisor_credential().await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=?")
                .bind(crate::digest(&f.token))
                .fetch_one(&f.store.pool)
                .await
                .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn independent_bootstrap_has_one_winner() {
        let f = super::super::tests::setup().await;
        let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
        let (a, b) = tokio::join!(
            f.store.authorize_timer_supervisor(&f.token),
            other.authorize_timer_supervisor(&f.token)
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        assert!(matches!(
            if a.is_err() { a } else { b },
            Err(RuntimeStoreError::Busy)
        ));
    }
}
