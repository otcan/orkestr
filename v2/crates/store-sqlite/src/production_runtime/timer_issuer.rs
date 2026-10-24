use super::*;

/// Local trusted scheduler identity, not a timer grant or provider capability.
/// Recreated from authenticated supervisor bootstrap after process restart.
pub struct TimerSchedulerIssuer {
    context: Context,
    namespace: Uuid,
}

impl TimerSchedulerIssuer {
    /// An in-memory action cannot cross a supervisor/session replacement.
    /// The key is never serialized or accepted from a browser.
    pub(crate) fn tracker_scan_key(&self) -> String {
        crate::digest(&format!(
            "tracker.scan.issuer.v1:{}:{}:{}:{}:{}:{}",
            self.context.owner,
            self.context.id,
            self.context.incarnation,
            self.context.generation,
            self.context.token_hash,
            self.namespace,
        ))
    }
}

impl Store {
    /// Metadata-only restart discovery. Each namespace still needs a separate
    /// issuer and a fresh guarded admission; discovery grants no timer authority.
    pub async fn timer_scheduler_candidates(
        &self,
        after: Option<Uuid>,
        limit: u16,
    ) -> crate::history_import::Result<Vec<Uuid>> {
        use crate::history_import::HistoryError;
        if !(1..=32).contains(&limit) || after.is_some_and(|id| id.is_nil()) {
            return Err(HistoryError::Invalid);
        }
        let context = self.context().map_err(|_| HistoryError::Unauthorized)?;
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| HistoryError::Unavailable)?;
        context
            .validate(&mut tx)
            .await
            .map_err(|_| HistoryError::Unauthorized)?;
        let namespaces: Vec<String> = sqlx::query_scalar(
            "SELECT t.namespace FROM dormant_timers t WHERE t.owner_id=? AND (EXISTS(SELECT 1 FROM durable_timer_authorities a WHERE a.owner_id=t.owner_id AND a.namespace=t.namespace AND a.generation=t.generation) OR EXISTS(SELECT 1 FROM tracker_scan_authorities a WHERE a.owner_id=t.owner_id AND a.namespace=t.namespace AND a.generation=t.generation)) AND t.state='enabled' AND t.namespace>? ORDER BY t.namespace LIMIT ?",
        )
        .bind(context.owner.to_string())
        .bind(after.map(|id| id.to_string()).unwrap_or_default())
        .bind(i64::from(limit))
        .fetch_all(&mut *tx).await.map_err(|_| HistoryError::Unavailable)?;
        let result = namespaces
            .into_iter()
            .map(|id| Uuid::parse_str(&id).map_err(|_| HistoryError::Unavailable))
            .collect();
        tx.commit().await.map_err(|_| HistoryError::Unavailable)?;
        result
    }

    /// Trusted configuration selects the timer namespace. Browser input must not
    /// call this issuer path. Persisted timer grants independently authorize work.
    pub async fn authorize_timer_scheduler(&self, namespace: Uuid) -> Result<TimerSchedulerIssuer> {
        if namespace.is_nil() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let context = self.context()?;
        let issuer = TimerSchedulerIssuer {
            context: context.clone(),
            namespace,
        };
        let (tx, _) = self
            .timer_scheduler_transaction(&issuer, namespace)
            .await
            .map_err(|_| RuntimeStoreError::Unauthorized)?;
        tx.commit().await.map_err(db)?;
        Ok(issuer)
    }

    pub(crate) async fn timer_scheduler_transaction(
        &self,
        issuer: &TimerSchedulerIssuer,
        namespace: Uuid,
    ) -> crate::history_import::Result<(sqlx::Transaction<'_, sqlx::Sqlite>, OwnerId)> {
        use crate::history_import::HistoryError;
        let fail = |_| HistoryError::Unauthorized;
        let current = self.context().map_err(fail)?;
        if namespace != issuer.namespace
            || current.id != issuer.context.id
            || current.incarnation != issuer.context.incarnation
            || current.generation != issuer.context.generation
            || current.owner != issuer.context.owner
            || current.token_hash != issuer.context.token_hash
        {
            return Err(HistoryError::Unauthorized);
        }
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|_| HistoryError::Unavailable)?;
        issuer.context.validate(&mut tx).await.map_err(fail)?;
        Ok((tx, issuer.context.owner.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::production_runtime::tests::{setup, snapshot};

    #[tokio::test]
    async fn scheduler_issuer_is_local_scoped_current_and_read_only() {
        let f = setup().await;
        let ns = Uuid::new_v4();
        let before = snapshot(&f.store).await;
        assert!(f.store.authorize_timer_scheduler(ns).await.is_err());
        let issuer = f.handle.authorize_timer_scheduler(ns).await.unwrap();
        let (tx, owner) = f
            .handle
            .timer_scheduler_transaction(&issuer, ns)
            .await
            .unwrap();
        assert_eq!(owner, f.owner);
        tx.commit().await.unwrap();
        assert!(f
            .handle
            .timer_scheduler_transaction(&issuer, Uuid::new_v4())
            .await
            .is_err());
        assert_eq!(snapshot(&f.store).await, before);
        // Browser logout is independent of the scheduler's exact machine session.
        let browser = "browser:synthetic-owner-session";
        f.store.save_session(browser, &f.owner).await.unwrap();
        f.store.revoke_session(browser).await.unwrap();
        let (tx, _) = f
            .handle
            .timer_scheduler_transaction(&issuer, ns)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        f.store.revoke_session(&f.token).await.unwrap();
        let before = snapshot(&f.store).await;
        assert!(f
            .handle
            .timer_scheduler_transaction(&issuer, ns)
            .await
            .is_err());
        assert_eq!(snapshot(&f.store).await, before);
        f.store.close().await;
        std::fs::remove_dir_all(f.root).unwrap();
    }
}

#[cfg(test)]
#[path = "timer_candidate_tests.rs"]
mod candidate_tests;
